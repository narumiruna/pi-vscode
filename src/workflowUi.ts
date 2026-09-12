import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import type { PiRuntimeManager } from "./piRuntime";
import { contextWarnings } from "./contextInspector";

/** Immutable, memory-only documents; callers release each result's resources. */
export class WorkflowDocuments implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly scheme = `pi-workflow-${randomUUID()}`;
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(this.scheme, this);
  public create(label: string, text: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: this.scheme, path: `/${encodeURIComponent(label)}`, query: randomUUID() });
    this.contents.set(uri.toString(), text);
    return uri;
  }
  public release(uri: vscode.Uri): void { this.contents.delete(uri.toString()); }
  public provideTextDocumentContent(uri: vscode.Uri): string { return this.contents.get(uri.toString()) ?? "This Pi snapshot has expired."; }
  public async inspect(label: string, text: string): Promise<void> {
    const uri = this.create(label, text);
    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true }); }
    finally { this.release(uri); }
  }
  public dispose(): void { this.contents.clear(); this.registration.dispose(); }
}
export function isDirtyFile(absolute: string): boolean {
  const canonical = (value: string) => {
    try { value = realpathSync(value); } catch { value = path.resolve(value); }
    return process.platform === "win32" ? value.toLowerCase() : value;
  };
  return vscode.workspace.textDocuments.some(document => document.uri.scheme === "file" && document.isDirty && canonical(document.uri.fsPath) === canonical(absolute));
}

export function requireTrustedFile(uri?: vscode.Uri): void {
  if (!vscode.workspace.isTrusted) throw new Error("Pi workflow actions require a trusted workspace.");
  if (uri && uri.scheme !== "file") throw new Error("This Pi workflow requires file-backed resources; virtual resources are unsupported.");
}
export async function assertRuntimeTarget(runtime: PiRuntimeManager, root: string, sessionId?: string): Promise<void> {
  requireTrustedFile(vscode.Uri.file(root));
  if (await realpath(runtime.currentCwd) !== await realpath(root)) {
    throw new Error("The target does not match Pi's active working directory. Explicitly switch the workspace/session first.");
  }
  if (!runtime.currentState.connected) await runtime.ensureStarted(vscode.Uri.file(root));
  if (sessionId !== undefined && runtime.currentState.sessionId !== sessionId) throw new Error("The Pi session changed; capture a new snapshot.");
}
export async function pickWorkspace(): Promise<vscode.Uri | undefined> {
  requireTrustedFile();
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (!folders.length) throw new Error("Open a file-backed workspace first.");
  const picked = folders.length === 1 ? folders[0] : (await vscode.window.showQuickPick(folders.map(folder => ({ label: folder.name, description: folder.uri.toString(), folder })), { title: "Choose Pi workflow workspace" }))?.folder;
  if (picked) requireTrustedFile(picked.uri);
  return picked?.uri;
}
export async function cancellable<T>(title: string, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  return vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title, cancellable: true }, async (_progress, token) => {
    const controller = new AbortController();
    const listener = token.onCancellationRequested(() => controller.abort());
    if (token.isCancellationRequested) controller.abort();
    try { return await action(controller.signal); } finally { listener.dispose(); }
  });
}
export async function inspectForTransmission(documents: WorkflowDocuments, label: string, text: string, maxCharacters: number): Promise<string | undefined> {
  if (text.length > maxCharacters) throw new Error("Snapshot exceeds its transmission limit.");
  await documents.inspect(label, text);
  const warnings = contextWarnings(label, text);
  const warningPrefix = warnings.length ? `${warnings.join("; ")}. ` : "";
  const action = await vscode.window.showWarningMessage(`${warningPrefix}Inspect this local snapshot. Pi history/instructions and later tool reads are separate. Secret warnings are best-effort. Nothing has been sent yet.`, "Send Snapshot", "Edit / Redact");
  if (action === "Send Snapshot") return text;
  if (action !== "Edit / Redact") return undefined;
  // Do not put raw debug/test secrets in untitled editors, which VS Code may back up for hot exit.
  const secret = await vscode.window.showInputBox({ title: "Redact snapshot text", prompt: "Exact text to replace with [REDACTED]. The edited snapshot will be inspected again before transmission.", password: true });
  if (!secret) return undefined;
  const edited = text.split(secret).join("[REDACTED]");
  if (edited === text) throw new Error("That text was not found; nothing was sent.");
  return inspectForTransmission(documents, label, edited, maxCharacters);
}

export function workflowCommand(context: vscode.ExtensionContext, id: string, action: () => Promise<void>): void {
  context.subscriptions.push(vscode.commands.registerCommand(id, async () => {
    try { await action(); } catch (error) { await vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error)); }
  }));
}
