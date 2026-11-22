import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import * as vscode from "vscode";
import {
  checkpointPathKey,
  maxCheckpointFile as maxFile,
  type SettlementChange,
  type SettlementEntry,
} from "./checkpointCapture";
import { captureCheckpoint, settleCheckpoint } from "./checkpointCaptureHost";
import { CheckpointHistory, expectedToolText, type RequestCheckpoint } from "./checkpointHistory";
import { decodeText, safeRelativePath } from "./gitSnapshots";
import { acquireOperation, observeOperations } from "./operationLocks";
import type { PiRpcEvent } from "./piRpcClient";
import { isDirtyFile, requireTrustedFile } from "./workflowUi";

const concurrentWriterExclusion = "Concurrent workspace writers: request attribution is unproven; restore unavailable.";
const invalidatedCheckpointExclusion =
  "Other workspace activity: historical checkpoint attribution is unverified; restore unavailable.";
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
  private readonly changesEmitter = new vscode.EventEmitter<void>();
  public readonly onDidInvalidateCheckpoints = this.changesEmitter.event;
  private readonly previews = new Map<string, string>();
  private readonly invalidatedCheckpoints = new WeakSet<RequestCheckpoint>();
  private operationObserver: ReturnType<typeof observeOperations> | undefined;
  private observedRoot: string | undefined;
  private current:
    | {
        cwd: string;
        rootIdentity: { dev: bigint; ino: bigint };
        sessionId: string;
        startedAt: number;
        files: Map<string, StartFile>;
        expectedBytes: number;
        exclusions: string[];
        unprovenEffects: boolean;
      }
    | undefined;
  private latest: RequestCheckpoint | undefined;
  private capture: AbortController | undefined;
  private settlement:
    | {
        controller: AbortController;
        status: RequestCheckpoint["status"];
        invalidated: boolean;
        result: Promise<TrackedFileChange[] | undefined>;
      }
    | undefined;

  public get hasProtectedRecovery(): boolean {
    return this.history.values.some((record) => record.restoreFailed);
  }

  /** Enable conservative history invalidation when multiple local sessions can use this workspace. */
  public enableConcurrentSafety(cwd: string): void {
    const root = realpathSync(cwd);
    if (this.operationObserver && this.observedRoot === root) return;
    this.operationObserver?.dispose();
    this.observedRoot = root;
    this.invalidateCheckpoints();
    this.operationObserver = observeOperations(root, (owner) => {
      if (owner !== this) this.invalidateCheckpoints();
    });
  }

  /** Retain recovery snapshots, but do not restore their unverified historical attribution. */
  public invalidateCheckpoints(): void {
    if (this.settlement) this.settlement.invalidated = true;
    for (const record of this.history.values) this.invalidatedCheckpoints.add(record);
    this.previews.clear();
    this.changesEmitter.fire();
  }

  /** Call again after startRequest if overlap was detected before capture began. */
  public invalidateConcurrentRequest(): void {
    this.invalidateCheckpoints();
    const request = this.current;
    if (!request) return;
    request.unprovenEffects = true;
    if (!request.exclusions.includes(concurrentWriterExclusion)) request.exclusions.unshift(concurrentWriterExclusion);
  }

  public async prepareRequest(root: string, sessionId: string, requestSignal: AbortSignal) {
    if (this.capture || this.current) throw new Error("A checkpoint request is already pending.");
    const { dev, ino } = statSync(root, { bigint: true });
    const rootIdentity = { dev, ino };
    const controller = new AbortController();
    this.capture = controller;
    const signal = AbortSignal.any([controller.signal, requestSignal]);
    const files = new Map<string, StartFile>();
    const exclusions: string[] = [];
    let expectedBytes = 0;
    const editorChanges = observeEditorChanges(root);
    const names = new Map<string, string>();
    const dispose = () => {
      editorChanges.dispose();
      if (this.capture === controller) this.capture = undefined;
    };
    try {
      editorChanges.collectDirty();
      await captureCheckpoint(root, new Set(editorChanges.paths), signal, (record) => {
        if ("exclusion" in record) exclusions.push(record.exclusion);
        else {
          const { path: name, before } = record;
          files.set(name, { before, expected: before, announced: false, unsupported: false });
          names.set(checkpointPathKey(path.join(root, name)), name);
          expectedBytes += Buffer.byteLength(before);
        }
      });
      return {
        dispose,
        commit: (overlapped: boolean) => {
          if (signal.aborted || this.capture !== controller) throw new Error("Pi request was cancelled.");
          if (!sameWorkspaceRoot(root, rootIdentity)) throw new Error("Workspace changed during checkpoint capture.");
          if (editorChanges.ambiguous) throw new Error("Too many editor changes during checkpoint capture.");
          for (const key of editorChanges.paths) {
            const name = names.get(key);
            const file = name === undefined ? undefined : files.get(name);
            if (name === undefined || !file) continue;
            files.delete(name);
            expectedBytes -= Buffer.byteLength(file.before);
            exclusions.push(`${name}: editor buffer changed during capture`);
          }
          if (this.operationObserver && this.observedRoot !== root) this.enableConcurrentSafety(root);
          this.previews.clear();
          this.current = {
            cwd: root,
            rootIdentity,
            sessionId,
            startedAt: Date.now(),
            files,
            expectedBytes,
            exclusions,
            unprovenEffects: overlapped,
          };
          if (overlapped) exclusions.unshift(concurrentWriterExclusion);
          this.latest = undefined;
          dispose();
        },
      };
    } catch (error) {
      dispose();
      throw error;
    }
  }

  public async startRequest(cwd: string, sessionId = "unknown"): Promise<void> {
    const prepared = await this.prepareRequest(realpathSync(cwd), sessionId, new AbortController().signal);
    try {
      prepared.commit(false);
    } finally {
      prepared.dispose();
    }
  }

  /** Direct shell has no deterministic file attribution or restorable coverage. */
  public recordShellRequest(
    cwd: string,
    sessionId = "unknown",
    status: RequestCheckpoint["status"] = "completed",
  ): void {
    this.previews.clear();
    this.latest = this.history.add({
      repository: cwd,
      sessionId,
      startedAt: Date.now(),
      completedAt: Date.now(),
      status,
      files: [],
      exclusions: [
        "Direct shell: all file, process, and external effects are non-restorable. Inspect Source Control and processes.",
      ],
    });
  }

  public captureToolEvent(event: PiRpcEvent): void {
    const request = this.current;
    if (!request || this.settlement) return;
    const tool = String(event.toolName ?? "");
    if (
      ![
        "read",
        "grep",
        "find",
        "ls",
        "vscode_context",
        "vscode_code_context",
        "vscode_open_file",
        "vscode_notify",
        "edit",
        "write",
      ].includes(tool)
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

  /** One complete comparison per request. Undefined means the originating request no longer owns the result. */
  public finishRequest(
    status: RequestCheckpoint["status"] = "completed",
    canPublish: () => boolean = () => true,
  ): Promise<TrackedFileChange[] | undefined> {
    if (this.settlement) {
      if (status === "process-exit") this.settlement.status = status;
      return this.settlement.result;
    }
    const request = this.current;
    if (!request) return Promise.resolve(undefined);
    const changed: SettlementChange[] = [];
    const editorChanges = observeEditorChanges(request.cwd);
    editorChanges.collectDirty();
    const controller = new AbortController();
    const settlement: NonNullable<WorkspaceChangeTracker["settlement"]> = {
      controller,
      status,
      invalidated: false,
      result: settleCheckpoint(
        request.cwd,
        request.files.size,
        settlementEntries(request.files),
        controller.signal,
        (change) => changed.push(change),
      )
        .then(
          () => true,
          () => false,
        )
        .then((compared) => {
          if (controller.signal.aborted || !canPublish() || !sameWorkspaceRoot(request.cwd, request.rootIdentity))
            return undefined;
          editorChanges.collectDirty();
          return this.publishSettlement(
            request,
            settlement.status,
            settlement.invalidated,
            editorChanges,
            compared ? changed : undefined,
          );
        })
        .finally(() => {
          editorChanges.dispose();
          if (this.settlement === settlement) {
            this.current = undefined;
            this.settlement = undefined;
          }
        }),
    };
    this.settlement = settlement;
    return settlement.result;
  }

  private publishSettlement(
    request: NonNullable<WorkspaceChangeTracker["current"]>,
    status: RequestCheckpoint["status"],
    invalidated: boolean,
    editorChanges: ReturnType<typeof observeEditorChanges>,
    changed: SettlementChange[] | undefined,
  ): TrackedFileChange[] {
    if (status === "process-exit") {
      request.unprovenEffects = true;
      request.exclusions.push("Process exited without settlement: final tool/descendant attribution is unverified.");
    }
    if (invalidated && !request.unprovenEffects) {
      request.unprovenEffects = true;
      request.exclusions.unshift(invalidatedCheckpointExclusion);
    }
    if (editorChanges.ambiguous)
      request.exclusions.unshift("Too many editor changes during settlement: restore coverage unavailable.");
    if (!changed) request.exclusions.unshift("Checkpoint settlement failed: restore coverage unavailable.");
    const files: RequestCheckpoint["files"] = [];
    for (const { path: name, matched } of changed ?? []) {
      const capture = request.files.get(name);
      if (!capture) continue;
      if (
        !matched ||
        request.unprovenEffects ||
        editorChanges.ambiguous ||
        editorChanges.paths.has(checkpointPathKey(path.join(request.cwd, name)))
      ) {
        if (request.exclusions.length < 1000)
          request.exclusions.push(
            `${name}: uncertain attribution, unsupported tool, deletion, shell effect, dirty buffer, or stale content`,
          );
      } else files.push({ path: name, before: capture.before, after: capture.expected });
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
    // The complete comparison already checked these files. Restore always runs its own fresh preflight.
    return this.listChanges(false);
  }

  public get changes(): TrackedFileChange[] {
    return this.listChanges(true);
  }
  private listChanges(checkDisk: boolean): TrackedFileChange[] {
    const record = this.latest;
    return record
      ? record.files
          .filter((file) => !file.reverted)
          .map((file) => {
            let canRevert = true;
            try {
              if (checkDisk) this.preflight(record, [file.path]);
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
    const before = vscode.Uri.from({ scheme: "pi-checkpoint", path: `/${name}`, query: `${record.id}-before` });
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
          label: `${new Date(record.startedAt).toLocaleTimeString()} · ${record.files.length} covered · ${this.checkpointExclusions(record).length} excluded · ${record.status}`,
          record,
        })),
      { title: "Request checkpoints (memory-only; not a transcript rewind)" },
    );
    if (!selected) return false;
    const record = selected.record;
    const report = vscode.Uri.from({ scheme: "pi-checkpoint", path: "/coverage.txt", query: record.id });
    this.previews.clear();
    this.previews.set(
      report.toString(),
      `Request ${record.id}; session ${record.sessionId}; ${record.status}\nCovered: ${record.files.map((file) => `${file.path}${file.reverted ? " (reverted)" : ""}`).join(", ") || "none"}\nExcluded:\n${this.checkpointExclusions(record).join("\n")}\n${record.restoreFailed ? "A restore failed; recovery before/after snapshots are retained." : ""}`,
    );
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(report), { preview: true });
    const picks = await vscode.window.showQuickPick(
      record.files.filter((file) => !file.reverted).map((file) => ({ label: file.path, file })),
      {
        title: `Preview covered changes; exclusions: ${this.checkpointExclusions(record).slice(0, 5).join("; ")}`,
        canPickMany: true,
      },
    );
    if (!picks?.length) return false;
    const names = picks.map((pick) => pick.file.path);
    this.preflight(record, names);
    for (const name of names) await this.review(`${record.id}:${name}`);
    if (
      (await vscode.window.showWarningMessage(
        `Revert ${names.length} covered files? ${this.checkpointExclusions(record).length} exclusions remain. No transcript, index, or session rewind. Filesystem-wide atomicity is not guaranteed.`,
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
    const release = acquireOperation(record.repository, "checkpoint restore", this);
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
  private checkpointExclusions(record: RequestCheckpoint): readonly string[] {
    return this.invalidatedCheckpoints.has(record)
      ? [invalidatedCheckpointExclusion, ...record.exclusions]
      : record.exclusions;
  }
  private preflight(record: RequestCheckpoint, names: string[]): void {
    if (this.invalidatedCheckpoints.has(record)) throw new Error(invalidatedCheckpointExclusion);
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
  public lookupPreview(uri: vscode.Uri): string | undefined {
    return this.previews.get(uri.toString());
  }
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.lookupPreview(uri) ?? "Checkpoint preview expired.";
  }
  public cancelPendingSettlement(): void {
    this.settlement?.controller.abort();
  }

  public resetSession(): void {
    this.capture?.abort();
    this.cancelPendingSettlement();
    this.settlement = undefined;
    this.current = undefined;
    this.latest = undefined;
    this.history.clear();
    this.previews.clear();
  }
  public dispose(): void {
    this.changesEmitter.dispose();
    this.operationObserver?.dispose();
    this.operationObserver = undefined;
    this.resetSession();
  }
}
function sameWorkspaceRoot(root: string, identity: { dev: bigint; ino: bigint }): boolean {
  try {
    if (realpathSync(root) !== root) return false;
    const current = statSync(root, { bigint: true });
    return current.isDirectory() && current.dev === identity.dev && current.ino === identity.ino;
  } catch {
    return false;
  }
}
function observeEditorChanges(root: string) {
  const paths = new Set<string>();
  let ambiguous = false;
  const rootKey = checkpointPathKey(root);
  const exclude = (doc: vscode.TextDocument) => {
    if (doc.uri.scheme !== "file" || ambiguous) return;
    let absolute: string;
    try {
      absolute = realpathSync(doc.uri.fsPath);
    } catch {
      absolute = path.resolve(doc.uri.fsPath);
    }
    const key = checkpointPathKey(absolute);
    const relative = path.relative(rootKey, key);
    if (!relative || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`) || relative === "..") return;
    if (paths.size >= 10_000 && !paths.has(key)) ambiguous = true;
    else paths.add(key);
  };
  const listeners = [
    vscode.workspace.onDidOpenTextDocument((doc) => {
      if (doc.isDirty) exclude(doc);
    }),
    vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
      if (document.isDirty || contentChanges.length) exclude(document);
    }),
  ];
  return {
    paths,
    get ambiguous() {
      return ambiguous;
    },
    collectDirty: () => {
      for (const doc of vscode.workspace.textDocuments) if (doc.isDirty) exclude(doc);
    },
    dispose: () => {
      for (const listener of listeners) listener.dispose();
    },
  };
}
function* settlementEntries(files: Map<string, StartFile>): Generator<SettlementEntry> {
  for (const [path, file] of files)
    yield { path, before: file.before, expected: file.announced && !file.unsupported ? file.expected : undefined };
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
