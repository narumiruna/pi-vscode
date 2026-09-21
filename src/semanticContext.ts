import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { assertSafeFile } from "./backgroundResults";
import { requireTrustedFile } from "./workflowUi";

export type CodeContextOperation = "definition" | "references" | "callers" | "callees" | "documentSymbols";
export const maxSemanticResults = 50;
export const maxSemanticExcerpts = 20;
export const maxSemanticExcerptCharacters = 4_000;
const semanticProviderTimeoutMs = 5_000;

export interface CodeContextRange {
  readonly start: { readonly line: number; readonly column: number };
  readonly end: { readonly line: number; readonly column: number };
}

export interface CodeContextItem {
  readonly name?: string;
  readonly kind?: string;
  readonly uri: string;
  readonly path: string;
  readonly range: CodeContextRange;
  readonly selectionRange?: CodeContextRange;
  readonly sourceRanges?: readonly CodeContextRange[];
}

export interface CodeContextResult {
  readonly operation: CodeContextOperation;
  readonly source: { readonly uri: string; readonly path: string; readonly line: number; readonly column: number };
  readonly items: readonly CodeContextItem[];
  readonly truncated: boolean;
}

export async function queryCodeContext(
  operation: CodeContextOperation,
  uri: vscode.Uri,
  position: vscode.Position,
  token?: vscode.CancellationToken,
): Promise<CodeContextResult> {
  if (!isCodeContextOperation(operation)) throw new Error("Unsupported semantic operation.");
  const folder = requireWorkspaceResource(uri);
  const root = await realpath(folder.uri.fsPath);
  await assertSafeFile(root, path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/"));
  const source = await vscode.workspace.openTextDocument(uri);
  const version = source.version;
  if (
    !Number.isSafeInteger(position.line) ||
    !Number.isSafeInteger(position.character) ||
    position.line < 0 ||
    position.line >= source.lineCount ||
    position.character < 0 ||
    position.character > source.lineAt(position.line).text.length
  )
    throw new Error("Invalid semantic source position.");
  if (token?.isCancellationRequested) throw new Error("Semantic context request was cancelled.");
  const deadline = Date.now() + semanticProviderTimeoutMs;
  const execute = (command: string, ...args: unknown[]) => boundedProviderCall(command, args, deadline, token);
  let values: unknown[] = [];
  if (operation === "definition") {
    values = array(await execute("vscode.executeDefinitionProvider", uri, position));
  } else if (operation === "references") {
    values = array(await execute("vscode.executeReferenceProvider", uri, position));
  } else if (operation === "documentSymbols") {
    values = flattenSymbols(array(await execute("vscode.executeDocumentSymbolProvider", uri)), uri);
  } else {
    const roots = array(await execute("vscode.prepareCallHierarchy", uri, position));
    for (const root of roots.slice(0, maxSemanticResults)) {
      const command = operation === "callers" ? "vscode.provideIncomingCalls" : "vscode.provideOutgoingCalls";
      values.push(...array(await execute(command, root)).slice(0, maxSemanticResults + 1));
      if (values.length > maxSemanticResults) break;
    }
  }
  if (token?.isCancellationRequested) throw new Error("Semantic context request was cancelled.");
  requireWorkspaceResource(uri);
  if (source.isClosed || source.version !== version) throw new Error("Semantic source changed during provider lookup.");
  const normalized: CodeContextItem[] = [];
  for (const value of values.slice(0, 1_000))
    for (const item of normalizeValue(value, operation)) {
      if (item.uri.length > 4_000 || item.path.length > 4_000 || !belongsToFolder(item, folder)) continue;
      try {
        await assertSafeFile(
          root,
          path.relative(folder.uri.fsPath, vscode.Uri.parse(item.uri).fsPath).split(path.sep).join("/"),
        );
        normalized.push({ ...item, path: relativePath(folder.uri, vscode.Uri.parse(item.uri)) });
      } catch {
        /* Skip symlink or escaped provider targets. */
      }
    }
  const unique = new Map<string, CodeContextItem>();
  for (const item of normalized) {
    const key = `${item.uri}\0${rangeKey(item.range)}`;
    if (!unique.has(key)) unique.set(key, item);
  }
  const sorted = [...unique.values()].sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.range.start.line - right.range.start.line ||
      left.range.start.column - right.range.start.column ||
      left.range.end.line - right.range.end.line ||
      left.range.end.column - right.range.end.column ||
      (left.name ?? "").localeCompare(right.name ?? ""),
  );
  if (token?.isCancellationRequested) throw new Error("Semantic context request was cancelled.");
  requireWorkspaceResource(uri);
  if (source.isClosed || source.version !== version) throw new Error("Semantic source changed during provider lookup.");
  return {
    operation,
    source: {
      uri: uri.toString(),
      path: relativePath(folder.uri, uri),
      line: position.line + 1,
      column: position.character + 1,
    },
    items: sorted.slice(0, maxSemanticResults),
    truncated: sorted.length > maxSemanticResults || values.length > 1_000,
  };
}

export async function semanticAttachmentText(result: CodeContextResult): Promise<string> {
  if (result.operation === "documentSymbols") return JSON.stringify(result, undefined, 2);
  const sections: string[] = [];
  for (const item of result.items.slice(0, maxSemanticExcerpts)) {
    const uri = vscode.Uri.parse(item.uri);
    const folder = requireWorkspaceResource(uri);
    const root = await realpath(folder.uri.fsPath);
    await assertSafeFile(root, path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/"));
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isClosed || item.range.start.line >= document.lineCount || item.range.end.line >= document.lineCount)
      continue;
    const startLine = Math.max(0, item.range.start.line - 3);
    const endLine = Math.min(document.lineCount - 1, item.range.end.line + 1);
    const range = new vscode.Range(startLine, 0, endLine, document.lineAt(endLine).text.length);
    const startOffset = document.offsetAt(range.start);
    const boundedEnd = document.positionAt(
      Math.min(document.offsetAt(range.end), startOffset + maxSemanticExcerptCharacters),
    );
    const excerpt = document.getText(new vscode.Range(range.start, boundedEnd));
    sections.push(
      `${item.path}:${item.range.start.line + 1}${item.name ? ` · ${item.name}` : ""} · document version ${document.version}\n${excerpt}`,
    );
  }
  const header = JSON.stringify({
    operation: result.operation,
    source: result.source,
    count: result.items.length,
    truncated: result.truncated,
  });
  return `${header}\n\n${sections.join("\n\n---\n\n")}`;
}

export function isCodeContextOperation(value: unknown): value is CodeContextOperation {
  return ["definition", "references", "callers", "callees", "documentSymbols"].includes(String(value));
}

function requireWorkspaceResource(uri: vscode.Uri): vscode.WorkspaceFolder {
  requireTrustedFile(uri);
  const folder = vscode.workspace.getWorkspaceFolder(uri);
  if (!folder || folder.uri.scheme !== "file")
    throw new Error("Semantic context requires a file inside the active workspace.");
  return folder;
}

function normalizeValue(value: unknown, operation: CodeContextOperation): CodeContextItem[] {
  if (!record(value)) return [];
  if (operation === "callers" && record(value.from)) return normalizeCallItem(value.from, value.fromRanges);
  if (operation === "callees" && record(value.to)) return normalizeCallItem(value.to, value.fromRanges);
  if (isUri(value.targetUri) && isRange(value.targetRange)) {
    return [item(value.targetUri, value.targetRange, undefined, value.targetSelectionRange)];
  }
  if (isUri(value.uri) && isRange(value.range)) {
    return [item(value.uri, value.range, string(value.name), value.selectionRange, undefined, value.kind)];
  }
  if (record(value.location) && isUri(value.location.uri) && isRange(value.location.range)) {
    return [item(value.location.uri, value.location.range, string(value.name), undefined, undefined, value.kind)];
  }
  return [];
}

function normalizeCallItem(value: Record<string, unknown>, sourceRanges: unknown): CodeContextItem[] {
  if (!isUri(value.uri) || !isRange(value.range)) return [];
  return [
    item(
      value.uri,
      value.range,
      string(value.name),
      value.selectionRange,
      array(sourceRanges).slice(0, maxSemanticResults).filter(isRange),
      value.kind,
    ),
  ];
}

function item(
  uriValue: unknown,
  rangeValue: unknown,
  name?: string,
  selection?: unknown,
  sources?: readonly unknown[],
  kind?: unknown,
): CodeContextItem {
  const uri = uriValue as vscode.Uri;
  const range = describeRange(rangeValue as vscode.Range);
  return {
    ...(name ? { name: name.slice(0, 500) } : {}),
    ...(kind === undefined ? {} : { kind: symbolKind(kind) }),
    uri: uri.toString(),
    path: uri.fsPath,
    range,
    ...(isRange(selection) ? { selectionRange: describeRange(selection) } : {}),
    ...(sources?.length
      ? { sourceRanges: sources.slice(0, 50).map((source) => describeRange(source as vscode.Range)) }
      : {}),
  };
}

function flattenSymbols(values: unknown[], uri: vscode.Uri): unknown[] {
  const flattened: unknown[] = [];
  const visit = (value: unknown) => {
    if (!record(value) || flattened.length > maxSemanticResults * 4) return;
    flattened.push(isRange(value.range) && !value.uri ? { ...value, uri } : value);
    for (const child of array(value.children).slice(0, maxSemanticResults * 4)) visit(child);
  };
  for (const value of values.slice(0, maxSemanticResults * 4)) visit(value);
  return flattened;
}

function belongsToFolder(item: CodeContextItem, folder: vscode.WorkspaceFolder): boolean {
  try {
    const uri = vscode.Uri.parse(item.uri);
    return uri.scheme === "file" && vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() === folder.uri.toString();
  } catch {
    return false;
  }
}

function relativePath(root: vscode.Uri, uri: vscode.Uri): string {
  return root.scheme === "file" && uri.scheme === "file"
    ? path.relative(root.fsPath, uri.fsPath) || path.basename(uri.fsPath)
    : uri.toString();
}

function describeRange(range: vscode.Range): CodeContextRange {
  return {
    start: { line: range.start.line, column: range.start.character },
    end: { line: range.end.line, column: range.end.character },
  };
}

function rangeKey(range: CodeContextRange): string {
  return `${range.start.line}:${range.start.column}:${range.end.line}:${range.end.column}`;
}

function symbolKind(value: unknown): string {
  return typeof value === "number" ? (vscode.SymbolKind[value] ?? String(value)) : String(value).slice(0, 100);
}

function isUri(value: unknown): value is vscode.Uri {
  return (
    record(value) &&
    typeof value.toString === "function" &&
    typeof value.scheme === "string" &&
    typeof value.fsPath === "string"
  );
}
function isRange(value: unknown): value is vscode.Range {
  return (
    record(value) &&
    isPosition(value.start) &&
    isPosition(value.end) &&
    (value.end.line > value.start.line ||
      (value.end.line === value.start.line && value.end.character >= value.start.character))
  );
}
function isPosition(value: unknown): value is { line: number; character: number } {
  return (
    record(value) &&
    Number.isSafeInteger(value.line) &&
    Number.isSafeInteger(value.character) &&
    Number(value.line) >= 0 &&
    Number(value.character) >= 0
  );
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
function string(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function boundedProviderCall(
  command: string,
  args: readonly unknown[],
  deadline: number,
  token?: vscode.CancellationToken,
): Promise<unknown> {
  if (token?.isCancellationRequested) throw new Error("Semantic context request was cancelled.");
  return new Promise((resolve, reject) => {
    let cancellation: vscode.Disposable | undefined;
    let settled = false;
    const timer = setTimeout(
      () => finish(new Error("Language provider timed out.")),
      Math.max(0, deadline - Date.now()),
    );
    function finish(error?: unknown, value?: unknown) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancellation?.dispose();
      if (error) reject(error);
      else resolve(value);
    }
    cancellation = token?.onCancellationRequested(() => finish(new Error("Semantic context request was cancelled.")));
    if (settled) {
      cancellation?.dispose();
      return;
    }
    void Promise.resolve()
      .then(() => vscode.commands.executeCommand(command, ...args))
      .then(
        (value) => finish(undefined, value),
        (error) => finish(error),
      );
  });
}
