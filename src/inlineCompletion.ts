import path from "node:path";
import * as vscode from "vscode";
import { buildCompletionPrompt, extractCompletion } from "./completion";
import { type PiConfiguration, piConfiguration } from "./configuration";
import { type Logger, nullLogger, safeErrorCategory, safeErrorCode } from "./logging";
import { invokePiWithCancellation, readPiInvocationSettings } from "./vscodePi";

const maxPrefixCharacters = 12_000;
const maxSuffixCharacters = 6_000;
const maxCacheEntries = 50;
const cacheTtlMs = 30_000;

interface CachedCompletion {
  readonly text: string;
  readonly createdAt: number;
  readonly scopeKey: string;
  readonly linePrefixLength: number;
}

export function registerInlineCompletions(context: vscode.ExtensionContext, logger: Logger = nullLogger): void {
  const provider = new PiInlineCompletionProvider(logger);
  context.subscriptions.push(
    vscode.languages.registerInlineCompletionItemProvider(
      [{ scheme: "file" }, { scheme: "vscode-remote" }, { scheme: "untitled" }],
      provider,
    ),
    vscode.commands.registerCommand("pi.triggerInlineCompletion", async () => {
      await vscode.commands.executeCommand("editor.action.inlineSuggest.trigger");
    }),
  );
}

export class PiInlineCompletionProvider implements vscode.InlineCompletionItemProvider {
  private readonly cache = new Map<string, CachedCompletion>();
  private readonly documentIds = new WeakMap<vscode.TextDocument, number>();
  private nextDocumentId = 0;

  public constructor(private readonly logger: Logger = nullLogger) {}

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    completionContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (token.isCancellationRequested || document.isClosed) return undefined;

    const languageId = document.languageId;
    const version = document.version;
    const isCurrent = () =>
      !token.isCancellationRequested &&
      !document.isClosed &&
      document.version === version &&
      document.languageId === languageId;
    const manual = completionContext.triggerKind === vscode.InlineCompletionTriggerKind.Invoke;
    const configuration = piConfiguration("inlineCompletions", document.uri);
    const minimum = minimumPrefixLength(configuration, languageId, manual);
    if (minimum === undefined) return undefined;

    const offset = document.offsetAt(position);
    let documentId = this.documentIds.get(document);
    if (documentId === undefined) {
      documentId = ++this.nextDocumentId;
      this.documentIds.set(document, documentId);
    }
    const cacheKey = `${documentId}:${version}:${offset}:${languageId}`;
    const cached = this.cache.get(cacheKey);
    // Keep the derived length, not source text, to check automatic eligibility without a line read on hits.
    let linePrefixLength = cached?.linePrefixLength;
    const readLinePrefixLength = () =>
      (linePrefixLength ??= document.lineAt(position.line).text.slice(0, position.character).trim().length);
    if (minimum > 0 && readLinePrefixLength() < minimum) return undefined;

    const item = (text: string) => [new vscode.InlineCompletionItem(text, new vscode.Range(position, position))];
    if (cacheMatches(cached, () => completionScope(document.uri).key)) return item(cached.text);

    const remainsEligible = () => {
      const currentMinimum = minimumPrefixLength(
        piConfiguration("inlineCompletions", document.uri),
        languageId,
        manual,
      );
      return currentMinimum !== undefined && !(currentMinimum > 0 && readLinePrefixLength() < currentMinimum);
    };
    const debounceMs = Math.max(0, configuration.get<number>("debounceMilliseconds", 650));
    if (!(await cancellableDelay(debounceMs, token)) || !isCurrent()) {
      this.logger.record("debug", "inline-completion", { result: "cancelled", category: "cancelled" });
      return undefined;
    }
    if (!remainsEligible()) return undefined;

    const scope = completionScope(document.uri);
    // Another request may have filled this entry while this one waited.
    const settled = this.cache.get(cacheKey);
    if (cacheMatches(settled, () => scope.key)) return item(settled.text);

    const prefixLength = readLinePrefixLength();
    const prompt = buildCompletionPrompt({
      file: scope.file,
      languageId,
      ...readCompletionContext(document, position, offset),
    });
    const operationId = this.logger.operation();

    try {
      if (!isCurrent()) {
        this.logger.record("debug", "inline-completion", { operationId, result: "cancelled", category: "cancelled" });
        return undefined;
      }
      const output = await invokePiWithCancellation(prompt, token, document.uri);
      if (!isCurrent() || !remainsEligible() || completionScope(document.uri).key !== scope.key) {
        this.logger.record("debug", "inline-completion", { operationId, result: "cancelled", category: "cancelled" });
        return undefined;
      }
      const completion = extractCompletion(output);
      if (!completion) {
        this.logger.record("warn", "inline-completion", {
          operationId,
          result: "failed",
          category: "invalid-response",
        });
        return undefined;
      }
      this.cache.set(cacheKey, {
        text: completion,
        createdAt: Date.now(),
        scopeKey: scope.key,
        linePrefixLength: prefixLength,
      });
      this.pruneCache();
      return item(completion);
    } catch (error) {
      this.logger.record(token.isCancellationRequested ? "debug" : "error", "inline-completion", {
        operationId,
        result: token.isCancellationRequested ? "cancelled" : "failed",
        category: token.isCancellationRequested ? "cancelled" : safeErrorCategory(error),
        errorCode: safeErrorCode(error),
      });
      return undefined;
    }
  }

  private pruneCache(): void {
    const now = Date.now();
    for (const [key, value] of this.cache) {
      if (now - value.createdAt > cacheTtlMs) {
        this.cache.delete(key);
      }
    }
    while (this.cache.size > maxCacheEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.cache.delete(oldest);
    }
  }
}

function cacheMatches(cached: CachedCompletion | undefined, readScopeKey: () => string): cached is CachedCompletion {
  return cached !== undefined && Date.now() - cached.createdAt <= cacheTtlMs && cached.scopeKey === readScopeKey();
}

function minimumPrefixLength(configuration: PiConfiguration, languageId: string, manual: boolean): number | undefined {
  if (
    (!manual && !configuration.get<boolean>("enabled", false)) ||
    configuration.get<string[]>("excludedLanguages", ["plaintext", "scminput"]).includes(languageId)
  ) {
    return undefined;
  }
  return manual ? 0 : configuration.get<number>("minimumPrefixLength", 3);
}

function completionScope(resource: vscode.Uri): { file: string; key: string } {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(resource);
  const file = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, resource.fsPath)
    : path.basename(resource.fsPath);
  return { file, key: JSON.stringify([file, readPiInvocationSettings(resource)]) };
}

function readCompletionContext(document: vscode.TextDocument, position: vscode.Position, offset: number) {
  const prefixOffset = Math.max(0, offset - maxPrefixCharacters);
  const documentEnd = document.offsetAt(new vscode.Position(document.lineCount, 0));
  const suffixOffset = Math.min(documentEnd, offset + maxSuffixCharacters);
  let start = document.positionAt(prefixOffset);
  let end = document.positionAt(suffixOffset);
  const splitPrefix = document.offsetAt(start) !== prefixOffset;
  const splitSuffix = document.offsetAt(end) !== suffixOffset;
  // A Position cannot represent the middle of CRLF. Read the representable interior and add
  // only the selected code unit at each split to match the old UTF-16 slices without extra reads.
  if (splitPrefix) start = document.positionAt(prefixOffset + 1);
  if (splitSuffix) end = document.positionAt(suffixOffset - 1);
  return {
    prefix: (splitPrefix ? "\n" : "") + document.getText(new vscode.Range(start, position)),
    suffix: document.getText(new vscode.Range(position, end)) + (splitSuffix ? "\r" : ""),
  };
}

function cancellableDelay(milliseconds: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      cancellation.dispose();
      resolve(true);
    }, milliseconds);
    const cancellation = token.onCancellationRequested(() => {
      clearTimeout(timer);
      cancellation.dispose();
      resolve(false);
    });
  });
}
