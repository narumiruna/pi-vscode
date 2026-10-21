import path from "node:path";
import * as vscode from "vscode";
import { boundCompletionContext, buildCompletionPrompt, extractCompletion } from "./completion";
import { piConfiguration } from "./configuration";
import { type Logger, nullLogger, safeErrorCategory, safeErrorCode } from "./logging";
import { invokePiWithCancellation } from "./vscodePi";

const maxPrefixCharacters = 12_000;
const maxSuffixCharacters = 6_000;
const maxCacheEntries = 50;
const cacheTtlMs = 30_000;

interface CachedCompletion {
  readonly text: string;
  readonly createdAt: number;
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

  public constructor(private readonly logger: Logger = nullLogger) {}

  public async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    completionContext: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    const configuration = piConfiguration("inlineCompletions", document.uri);
    if (
      !configuration.get<boolean>("enabled", false) &&
      completionContext.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke
    ) {
      return undefined;
    }
    const excludedLanguages = configuration.get<string[]>("excludedLanguages", ["plaintext", "scminput"]);
    if (excludedLanguages.includes(document.languageId)) {
      return undefined;
    }

    const linePrefix = document.lineAt(position.line).text.slice(0, position.character);
    if (
      completionContext.triggerKind !== vscode.InlineCompletionTriggerKind.Invoke &&
      linePrefix.trim().length < configuration.get<number>("minimumPrefixLength", 3)
    ) {
      return undefined;
    }

    const debounceMs = Math.max(0, configuration.get<number>("debounceMilliseconds", 650));
    if (!(await cancellableDelay(debounceMs, token))) {
      this.logger.record("debug", "inline-completion", { result: "cancelled", category: "cancelled" });
      return undefined;
    }

    const offset = document.offsetAt(position);
    const documentText = document.getText();
    const bounded = boundCompletionContext(
      documentText.slice(0, offset),
      documentText.slice(offset),
      maxPrefixCharacters,
      maxSuffixCharacters,
    );
    const cacheKey = `${document.uri.toString()}\0${document.version}\0${offset}\0${bounded.prefix}\0${bounded.suffix}`;
    const cached = this.cache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt <= cacheTtlMs) {
      return [new vscode.InlineCompletionItem(cached.text, new vscode.Range(position, position))];
    }

    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const file = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
      : path.basename(document.uri.fsPath);
    const prompt = buildCompletionPrompt({
      file,
      languageId: document.languageId,
      prefix: bounded.prefix,
      suffix: bounded.suffix,
    });
    const documentVersion = document.version;
    const operationId = this.logger.operation();

    try {
      const output = await invokePiWithCancellation(prompt, token, document.uri);
      if (token.isCancellationRequested || document.version !== documentVersion) {
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
      this.cache.set(cacheKey, { text: completion, createdAt: Date.now() });
      this.pruneCache();
      return [new vscode.InlineCompletionItem(completion, new vscode.Range(position, position))];
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
