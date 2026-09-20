import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import { CheckpointHistory, expectedToolText, type RequestCheckpoint } from "./checkpointHistory";
import { decodeText, safeRelativePath } from "./gitSnapshots";
import { acquireOperation } from "./operationLocks";
import type { PiRpcEvent } from "./piRpcClient";
import { isDirtyFile, requireTrustedFile } from "./workflowUi";

const maxFile = 2 * 1024 * 1024;
export interface TrackedFileChange {
  readonly id: string;
  readonly uri: string;
  readonly label: string;
  readonly created: boolean;
  readonly deleted: boolean;
  readonly canRevert: boolean;
  readonly canPreview: boolean;
}
interface StartFile {
  before: string;
  expected: string;
  announced: boolean;
  unsupported: boolean;
}
export class WorkspaceChangeTracker implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly history = new CheckpointHistory();
  private readonly previews = new Map<string, string>();
  private current:
    | {
        cwd: string;
        sessionId: string;
        startedAt: number;
        files: Map<string, StartFile>;
        expectedBytes: number;
        exclusions: string[];
        unprovenEffects: boolean;
      }
    | undefined;
  private latest: RequestCheckpoint | undefined;

  /** This boundary completes synchronously before runtime.prompt can submit to the subprocess. */
  public startRequest(cwd: string, sessionId = "unknown"): void {
    const root = realpathSync(cwd);
    this.previews.clear();
    const files = new Map<string, StartFile>();
    const exclusions: string[] = [
      "Coverage: pre-captured existing regular text files only; new files, deletions, and shell effects are unsupported.",
    ];
    let bytes = 0;
    let visited = 0;
    const pending = [""];
    while (pending.length && visited < 10_000 && bytes < 20 * 1024 * 1024) {
      const relative = pending.pop()!;
      try {
        if (realpathSync(path.join(root, relative)) !== path.join(root, relative)) {
          exclusions.push(`${relative}: symlink directory`);
          continue;
        }
        for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
          if (++visited > 10_000) break;
          const name = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
          if ([".git", "node_modules", ".aru"].includes(entry.name)) {
            exclusions.push(`${name}: excluded directory`);
            continue;
          }
          if (entry.isDirectory()) {
            pending.push(name);
            continue;
          }
          if (!entry.isFile() || dirty(path.join(root, name))) {
            exclusions.push(`${name}: non-regular or dirty buffer`);
            continue;
          }
          const before = readCovered(root, name);
          if (before === undefined) {
            exclusions.push(`${name}: unavailable, non-text or oversized`);
            continue;
          }
          bytes += Buffer.byteLength(before);
          if (bytes > 20 * 1024 * 1024) {
            exclusions.push("Request-start capture overflow");
            break;
          }
          files.set(name, { before, expected: before, announced: false, unsupported: false });
        }
      } catch {
        exclusions.push(`${relative}: unavailable during request-start capture`);
      }
    }
    if (pending.length || visited >= 10_000) exclusions.push("Request-start enumeration limit");
    const expectedBytes = [...files.values()].reduce((total, file) => total + Buffer.byteLength(file.expected), 0);
    this.current = {
      cwd: root,
      sessionId,
      startedAt: Date.now(),
      files,
      expectedBytes,
      exclusions,
      unprovenEffects: false,
    };
    this.latest = undefined;
  }

  public captureToolEvent(event: PiRpcEvent): void {
    const request = this.current;
    if (!request) return;
    const tool = String(event.toolName ?? "");
    if (
      !["read", "grep", "find", "ls", "vscode_context", "vscode_open_file", "vscode_notify", "edit", "write"].includes(
        tool,
      )
    ) {
      request.unprovenEffects = true;
      if (request.exclusions.length < 1000)
        request.exclusions.push(`Shell/custom tool with unproven side effects: ${tool.slice(0, 200)}`);
      return;
    }
    if (!["edit", "write"].includes(tool)) return;
    if (!event.args || typeof event.args !== "object") {
      request.unprovenEffects = true;
      return;
    }
    const args = event.args as Record<string, unknown>;
    const candidate = args.path ?? args.filePath ?? args.file_path;
    if (typeof candidate !== "string" || candidate.length > 4096) {
      request.unprovenEffects = true;
      request.exclusions.push("Tool with unknown/oversized path");
      return;
    }
    const relative = path.relative(request.cwd, path.resolve(request.cwd, candidate)).split(path.sep).join("/");
    const file = request.files.get(relative);
    if (!file) {
      request.exclusions.push(`${relative}: not pre-captured (creation/deletion/outside scope)`);
      return;
    }
    file.announced = true;
    if (file.unsupported) return;
    const expected = expectedToolText(file.expected, tool, args);
    const nextBytes = request.expectedBytes - Buffer.byteLength(file.expected) + Buffer.byteLength(expected ?? "");
    if (expected === undefined || Buffer.byteLength(expected) > maxFile || nextBytes > 20 * 1024 * 1024) {
      request.expectedBytes -= Buffer.byteLength(file.expected);
      file.expected = "";
      file.unsupported = true;
    } else {
      request.expectedBytes = nextBytes;
      file.expected = expected;
    }
  }

  public finishRequest(status: RequestCheckpoint["status"] = "completed"): TrackedFileChange[] {
    const request = this.current;
    if (!request) return this.changes;
    this.current = undefined;
    if (status === "process-exit") {
      request.unprovenEffects = true;
      request.exclusions.push("Process exited without settlement: final tool/descendant attribution is unverified.");
    }
    const files: RequestCheckpoint["files"] = [];
    for (const [name, capture] of request.files) {
      const after = readCovered(request.cwd, name);
      if (after === capture.before) continue;
      if (
        !capture.announced ||
        capture.unsupported ||
        request.unprovenEffects ||
        dirty(path.join(request.cwd, name)) ||
        after === undefined ||
        after !== capture.expected
      ) {
        request.exclusions.push(
          `${name}: uncertain attribution, unsupported tool, deletion, shell effect, dirty buffer, or stale content`,
        );
      } else files.push({ path: name, before: capture.before, after });
    }
    if (request.unprovenEffects)
      request.exclusions.push("Shell/custom/unfinished effects: historical restore unavailable for all affected files");
    this.latest = this.history.add({
      repository: request.cwd,
      sessionId: request.sessionId,
      startedAt: request.startedAt,
      completedAt: Date.now(),
      status,
      files,
      exclusions: request.exclusions.slice(0, 1000),
    });
    return this.changes;
  }

  public get changes(): TrackedFileChange[] {
    const record = this.latest;
    return record
      ? record.files
          .filter((file) => !file.reverted)
          .map((file) => {
            let canRevert = true;
            try {
              this.preflight(record, [file.path]);
            } catch {
              canRevert = false;
            }
            return {
              id: `${record.id}:${file.path}`,
              uri: vscode.Uri.file(path.join(record.repository, file.path)).toString(),
              label: file.path,
              created: false,
              deleted: false,
              canRevert,
              canPreview: true,
            };
          })
      : [];
  }
  public async review(id: string): Promise<void> {
    const { record, name } = this.resolve(id);
    const file = record.files.find((file) => file.path === name)!;
    const before = vscode.Uri.from({ scheme: "picode-checkpoint", path: `/${name}`, query: `${record.id}-before` });
    const after = before.with({ query: `${record.id}-after` });
    this.previews.clear();
    this.previews.set(before.toString(), file.before);
    this.previews.set(after.toString(), file.after);
    await vscode.commands.executeCommand("vscode.diff", before, after, `Request checkpoint: ${name}`, {
      preview: true,
    });
  }
  public async open(id: string): Promise<void> {
    const { record, name } = this.resolve(id);
    await vscode.window.showTextDocument(
      await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(record.repository, name))),
      { preview: true },
    );
  }
  public revert(id: string): TrackedFileChange[] {
    const { record, name } = this.resolve(id);
    this.restore(record, [name]);
    return this.changes;
  }
  public async selectCheckpoint(cwd: string, sessionId: string | undefined): Promise<boolean> {
    requireTrustedFile(vscode.Uri.file(cwd));
    const selected = await vscode.window.showQuickPick(
      this.history.values
        .filter((record) => record.repository === realpathSync(cwd) && record.sessionId === sessionId)
        .map((record) => ({
          label: `${new Date(record.startedAt).toLocaleTimeString()} · ${record.files.length} covered · ${record.exclusions.length} excluded · ${record.status}`,
          record,
        })),
      { title: "Request checkpoints (memory-only; not a transcript rewind)" },
    );
    if (!selected) return false;
    const record = selected.record;
    const report = vscode.Uri.from({ scheme: "picode-checkpoint", path: "/coverage.txt", query: record.id });
    this.previews.clear();
    this.previews.set(
      report.toString(),
      `Request ${record.id}; session ${record.sessionId}; ${record.status}\nCovered: ${record.files.map((file) => `${file.path}${file.reverted ? " (reverted)" : ""}`).join(", ") || "none"}\nExcluded:\n${record.exclusions.join("\n")}\n${record.restoreFailed ? "A restore failed; recovery before/after snapshots are retained." : ""}`,
    );
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report), { preview: true });
    const picks = await vscode.window.showQuickPick(
      record.files.filter((file) => !file.reverted).map((file) => ({ label: file.path, file })),
      { title: `Preview covered changes; exclusions: ${record.exclusions.slice(0, 5).join("; ")}`, canPickMany: true },
    );
    if (!picks?.length) return false;
    const names = picks.map((pick) => pick.file.path);
    this.preflight(record, names);
    for (const name of names) await this.review(`${record.id}:${name}`);
    if (
      (await vscode.window.showWarningMessage(
        `Revert ${names.length} covered files? ${record.exclusions.length} exclusions remain. No transcript, index, or session rewind. Filesystem-wide atomicity is not guaranteed.`,
        { modal: true },
        "Revert Covered Changes",
      )) !== "Revert Covered Changes"
    )
      return false;
    this.restore(record, names);
    return true;
  }
  private restore(record: RequestCheckpoint, names: string[]): void {
    requireTrustedFile();
    const release = acquireOperation(record.repository, "checkpoint restore");
    const reverted: string[] = [];
    try {
      this.preflight(record, names);
      for (const name of names) {
        this.preflight(record, [name]);
        const file = record.files.find((file) => file.path === name)!;
        // Parent and leaf are checked by readCovered; external filesystem races remain non-transactional.
        const fd = openSync(path.join(record.repository, name), constants.O_RDWR | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          const named = lstatSync(path.join(record.repository, name));
          if (
            opened.ino !== named.ino ||
            opened.dev !== named.dev ||
            opened.nlink !== 1 ||
            realpathSync(path.join(record.repository, name)) !== path.join(record.repository, name)
          )
            throw new Error("File identity changed during restore.");
          const current = Buffer.alloc(Buffer.byteLength(file.after) + 1);
          const count = readSync(fd, current, 0, current.length, 0);
          if (current.subarray(0, count).toString("utf8") !== file.after || dirty(path.join(record.repository, name)))
            throw new Error("File changed during restore preflight.");
          writeFileSync(fd, file.before, "utf8");
          ftruncateSync(fd, Buffer.byteLength(file.before));
        } finally {
          closeSync(fd);
        }
        file.reverted = true;
        reverted.push(name);
      }
      record.restoreFailed = false;
    } catch (error) {
      record.restoreFailed = true;
      throw new Error(
        `Checkpoint restore stopped. Reverted: ${reverted.join(", ") || "none"}. Recovery snapshots retained. ${error instanceof Error ? error.message : error}`,
      );
    } finally {
      release();
    }
  }
  private preflight(record: RequestCheckpoint, names: string[]): void {
    this.history.assertRestorable(record.id, names, (name) => ({
      text: readCovered(record.repository, name),
      dirty: dirty(path.join(record.repository, name)),
    }));
  }
  private resolve(id: string): { record: RequestCheckpoint; name: string } {
    const colon = id.indexOf(":");
    const record = this.history.require(id.slice(0, colon));
    const name = id.slice(colon + 1);
    if (!record.files.some((file) => file.path === name)) throw new Error("Unknown checkpoint file.");
    return { record, name };
  }
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.previews.get(uri.toString()) ?? "Checkpoint preview expired.";
  }
  public dispose(): void {
    this.current = undefined;
    this.latest = undefined;
    this.history.clear();
    this.previews.clear();
  }
}
function dirty(absolute: string): boolean {
  return isDirtyFile(absolute);
}
function readCovered(root: string, relative: string): string | undefined {
  try {
    if (!safeRelativePath(relative) || realpathSync(root) !== root) return undefined;
    let target = root;
    for (const part of relative.split("/")) {
      target = path.join(target, part);
      if (lstatSync(target).isSymbolicLink()) return undefined;
    }
    const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxFile) return undefined;
      const bytes = Buffer.alloc(stat.size + 1);
      const count = readSync(fd, bytes, 0, bytes.length, 0);
      const afterStat = fstatSync(fd);
      return count === stat.size && afterStat.size === stat.size && afterStat.mtimeMs === stat.mtimeMs
        ? decodeText(bytes.subarray(0, count))
        : undefined;
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}
