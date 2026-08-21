import {
  existsSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { canSafelyRevert, fileVersion, hasFileChanged, type FileVersionState } from "./changeState";
import type { PiRpcEvent } from "./piRpcClient";

const previewScheme = "pi-checkpoint";
const maxTrackedFileBytes = 2 * 1024 * 1024;
const maxTrackedBytes = 20 * 1024 * 1024;

interface CapturedFile {
  readonly id: string;
  readonly uri: vscode.Uri;
  readonly label: string;
  readonly beforeContent?: Buffer;
  readonly before: FileVersionState;
  afterContent?: Buffer;
  after?: FileVersionState;
}

export interface TrackedFileChange {
  readonly id: string;
  readonly uri: string;
  readonly label: string;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly canRevert: boolean;
  readonly canPreview: boolean;
}

export class WorkspaceChangeTracker implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly captures = new Map<string, CapturedFile>();
  private readonly previewContents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  private trackedBytes = 0;
  private cwd: string | undefined;
  public readonly onDidChange = this.emitter.event;

  public startRequest(cwd: string): void {
    this.cwd = path.resolve(cwd);
    this.captures.clear();
    this.previewContents.clear();
    this.trackedBytes = 0;
  }

  public captureToolEvent(event: PiRpcEvent): void {
    const toolName = typeof event.toolName === "string" ? event.toolName : "";
    if (toolName !== "edit" && toolName !== "write") {
      return;
    }
    const args = isRecord(event.args) ? event.args : undefined;
    const candidate = args && firstString(args.path, args.filePath, args.file_path);
    if (!candidate || !this.cwd) {
      return;
    }
    const absolutePath = path.resolve(this.cwd, candidate);
    if (!isWithin(this.cwd, absolutePath) || this.captures.has(absolutePath)) {
      return;
    }

    let beforeContent: Buffer | undefined;
    if (existsSync(absolutePath)) {
      const stats = statSync(absolutePath);
      if (!stats.isFile() || stats.size > maxTrackedFileBytes || this.trackedBytes + stats.size > maxTrackedBytes) {
        return;
      }
      beforeContent = readFileSync(absolutePath);
      this.trackedBytes += beforeContent.length;
    }
    const uri = vscode.Uri.file(absolutePath);
    this.captures.set(absolutePath, {
      id: Buffer.from(absolutePath).toString("base64url"),
      uri,
      label: path.relative(this.cwd, absolutePath),
      beforeContent,
      before: fileVersion(beforeContent),
    });
  }

  public finishRequest(): TrackedFileChange[] {
    for (const [absolutePath, capture] of this.captures) {
      let afterContent: Buffer | undefined;
      if (existsSync(absolutePath)) {
        const stats = statSync(absolutePath);
        if (!stats.isFile() || stats.size > maxTrackedFileBytes) {
          capture.afterContent = undefined;
          capture.after = { exists: true, hash: "untracked-size" };
          continue;
        }
        afterContent = readFileSync(absolutePath);
      }
      capture.afterContent = afterContent;
      capture.after = fileVersion(afterContent);
    }
    return this.changes;
  }

  public get changes(): TrackedFileChange[] {
    const changes: TrackedFileChange[] = [];
    for (const capture of this.captures.values()) {
      if (!capture.after || !hasFileChanged(capture.before, capture.after)) {
        continue;
      }
      const current = readCurrentVersion(capture.uri.fsPath);
      changes.push({
        id: capture.id,
        uri: capture.uri.toString(),
        label: capture.label,
        created: !capture.before.exists && capture.after.exists,
        deleted: capture.before.exists && !capture.after.exists,
        canRevert: canSafelyRevert(capture.after, current),
        canPreview: isText(capture.beforeContent) && isText(capture.afterContent),
      });
    }
    return changes;
  }

  public async review(id: string): Promise<void> {
    const capture = this.find(id);
    if (!capture.after || !isText(capture.beforeContent) || !isText(capture.afterContent)) {
      throw new Error("This change cannot be shown as a text diff.");
    }
    const beforeUri = vscode.Uri.from({ scheme: previewScheme, path: capture.uri.path, query: id });
    this.previewContents.set(beforeUri.toString(), capture.beforeContent?.toString("utf8") ?? "");
    const afterUri = capture.after.exists
      ? capture.uri
      : vscode.Uri.from({ scheme: previewScheme, path: capture.uri.path, query: `${id}-deleted` });
    if (!capture.after.exists) {
      this.previewContents.set(afterUri.toString(), "");
    }
    await vscode.commands.executeCommand(
      "vscode.diff",
      beforeUri,
      afterUri,
      `Pi Change: ${capture.label}`,
      { preview: true },
    );
  }

  public async open(id: string): Promise<void> {
    const capture = this.find(id);
    if (!existsSync(capture.uri.fsPath)) {
      throw new Error("The changed file no longer exists.");
    }
    const document = await vscode.workspace.openTextDocument(capture.uri);
    await vscode.window.showTextDocument(document, { preview: true });
  }

  public revert(id: string): TrackedFileChange[] {
    const capture = this.find(id);
    if (!capture.after || !canSafelyRevert(capture.after, readCurrentVersion(capture.uri.fsPath))) {
      throw new Error("The file changed after Pi completed, so it was not reverted.");
    }
    if (capture.before.exists && capture.beforeContent) {
      writeFileSync(capture.uri.fsPath, capture.beforeContent);
    } else if (existsSync(capture.uri.fsPath)) {
      unlinkSync(capture.uri.fsPath);
    }
    capture.afterContent = capture.beforeContent;
    capture.after = capture.before;
    return this.changes;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previewContents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.captures.clear();
    this.previewContents.clear();
    this.emitter.dispose();
  }

  private find(id: string): CapturedFile {
    const capture = [...this.captures.values()].find(value => value.id === id);
    if (!capture) {
      throw new Error("The Pi change checkpoint is no longer available.");
    }
    return capture;
  }
}

function readCurrentVersion(filePath: string): FileVersionState {
  if (!existsSync(filePath)) {
    return fileVersion(undefined);
  }
  const stats = statSync(filePath);
  if (!stats.isFile() || stats.size > maxTrackedFileBytes) {
    return { exists: true, hash: "untracked-size" };
  }
  return fileVersion(readFileSync(filePath));
}

function isText(content: Buffer | undefined): boolean {
  return content === undefined || !content.subarray(0, 8_000).includes(0);
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function firstString(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
