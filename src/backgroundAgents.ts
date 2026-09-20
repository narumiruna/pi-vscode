import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { acquireOperation } from "./operationLocks";
import { gitEnvironment, gitIdentity, gitRevision } from "./gitSnapshots";
import { captureBackgroundResult, importBackgroundResult, validTaskOrigin, type BackgroundResult, type ImportReport, type TaskOrigin } from "./backgroundResults";
import { cancellable, isDirtyFile, requireTrustedFile, WorkflowDocuments } from "./workflowUi";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import {
  assertBackgroundTaskCapacity,
  backgroundTaskIdsToEvict,
  countOccupiedBackgroundTaskSlots,
  isBackgroundTaskActive,
  launchBackgroundExecution,
} from "./backgroundAgentLifecycle";
import { buildAgentPrompt, type ChatReferenceContext } from "./prompts";
import { PiRpcClient, type PiRpcEvent, type PiRpcImage } from "./piRpcClient";
import { readPiInvocationOptions } from "./vscodePi";
import { picodeConfiguration } from "./configuration";
import {
  vscodeBridgeExtensionEnvironmentKey,
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
} from "./vscodeBridgeProtocol";

const storageKey = "picode.backgroundTasks.v1";
const maxTasks = 20;
const maxOutputCharacters = 20_000;

export interface BackgroundTaskState {
  readonly id: string;
  readonly title: string;
  readonly status: "starting" | "running" | "completed" | "failed" | "cancelled";
  readonly output: string;
  readonly tool?: string;
  readonly sessionFile?: string;
  readonly worktreePath?: string;
  readonly error?: string;
  readonly cwd?: string;
  readonly origin?: TaskOrigin;
  readonly importReport?: ImportReport;
  readonly reviewing?: boolean;
  readonly processId?: number;
  readonly inactivityUnverified?: boolean;
  readonly resultPreviewReady?: boolean;
}

interface ActiveTask {
  readonly client: PiRpcClient;
  readonly subscription: vscode.Disposable;
  cancelRequested: boolean;
  readonly releaseOperation: () => void;
}

export class BackgroundAgentManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<readonly BackgroundTaskState[]>();
  private readonly tasks = new Map<string, BackgroundTaskState>();
  private readonly active = new Map<string, ActiveTask>();
  public readonly onDidChange = this.emitter.event;
  private readonly documents = new WorkflowDocuments();
  private readonly resultPreviews = new Map<string, { snapshot: BackgroundResult; selected: string[] }>();
  private readonly resultOperations = new Set<string>();

  public constructor(private readonly context: vscode.ExtensionContext) {
    const restored = context.workspaceState.get<unknown>(storageKey);
    if (Array.isArray(restored)) {
      for (const task of restored.filter(isBackgroundTaskState).slice(-maxTasks)) {
        const restored = { ...task, origin: validTaskOrigin(task.origin) ? task.origin : undefined, reviewing: false };
        this.tasks.set(task.id, task.status === "running" || task.status === "starting"
          ? { ...restored, status: "failed", inactivityUnverified: !restored.processId, error: "VS Code closed before this task completed. Inactivity must be verified before import." }
          : restored);
      }
    }
  }

  public get states(): readonly BackgroundTaskState[] {
    return [...this.tasks.values()].map(task => ({ ...task, resultPreviewReady: this.resultPreviews.has(task.id) }));
  }

  public async start(
    request: string,
    contexts: readonly ChatReferenceContext[],
    images: readonly PiRpcImage[],
    cwd: string,
    isolatedWorktree: boolean,
  ): Promise<string> {
    requireTrustedFile(vscode.Uri.file(cwd));
    cwd = await realpath(cwd);
    assertBackgroundTaskCapacity(
      countOccupiedBackgroundTaskSlots(
        [...this.tasks].map(([id, task]) => [id, task.status] as const),
        [...this.active.keys(), ...this.resultOperations],
      ),
      maxTasks,
    );
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const title = request.length > 60 ? `${request.slice(0, 57)}…` : request;
    this.setTask({ id, title, status: "starting", output: "", cwd });

    let taskCwd = cwd;
    let worktreePath: string | undefined;
    if (isolatedWorktree) {
      try {
        const created = await this.createWorktree(cwd, id);
        worktreePath = created.worktreePath;
        taskCwd = worktreePath;
        this.patchTask(id, { worktreePath, origin: created.origin, cwd: taskCwd });
      } catch (error) {
        this.failTask(id, error);
        throw error;
      }
    }

    const invocation = readPiInvocationOptions(vscode.Uri.file(taskCwd));
    const configuration = picodeConfiguration();
    const client = new PiRpcClient({
      executablePath: invocation.executablePath,
      cwd: taskCwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      appendSystemPrompt: "This is an independent background task. Work only in the provided working directory.",
      extensions: [path.join(this.context.extensionUri.fsPath, "resources", "picode-permission-gate.ts")],
      approveProjectResources: configuration.get<boolean>("approveProjectResources", false),
      env: {
        PICODE_PERMISSION_MODE: configuration.get<string>("agent.confirmToolCalls", "dangerous"),
      },
      unsetEnv: [
        vscodeBridgePortEnvironmentKey,
        vscodeBridgeTokenEnvironmentKey,
        vscodeBridgeExtensionEnvironmentKey,
      ],
    });
    const subscription = client.onEvent(event => this.handleEvent(id, event));
    let releaseOperation: () => void;
    try { releaseOperation = acquireOperation(taskCwd, "background task"); }
    catch (error) { subscription.dispose(); this.failTask(id, error); throw error; }
    this.active.set(id, { client, subscription, cancelRequested: false, releaseOperation });

    try {
      await launchBackgroundExecution(
        async () => {
          await client.start();
          this.patchTask(id, { processId: client.processId });
          await client.setSessionName(title);
        },
        // Pi RPC resolves prompt commands after acceptance; task events continue asynchronously.
        () => {
          if (this.active.get(id)?.cancelRequested) throw new Error("Background task cancelled before submission.");
          return client.prompt(buildAgentPrompt(request, contexts), images);
        },
      );
      if (this.tasks.get(id)?.status === "starting") this.patchTask(id, { status: "running" });
    } catch (error) {
      this.failTask(id, error);
      await this.stopActive(id);
      throw error;
    }
    return id;
  }

  public async cancel(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) {
      return;
    }
    active.cancelRequested = true;
    try { await active.client.clearQueue(); await active.client.abort(); }
    catch {
      this.patchTask(id, { status: "cancelled", error: "Queue clearing unsupported/uncertain; process stopped without replay." });
      await this.stopActive(id);
    }
  }

  public async openSession(id: string): Promise<string> {
    const task = this.requireTask(id);
    if (task.worktreePath || task.origin) throw new Error("Isolated sessions must be resumed in their own workspace. Use Open Worktree, then Resume Session there.");
    if (!task.sessionFile) {
      throw new Error("This background task does not have a resumable Pi session yet.");
    }
    return task.sessionFile;
  }

  public async openWorktree(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (!task.worktreePath) {
      throw new Error("This task does not use an isolated worktree.");
    }
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(task.worktreePath), {
      forceNewWindow: true,
    });
  }

  public invalidateResults(): void { this.resultPreviews.clear(); this.publish(); }

  public async reviewResults(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (!task.worktreePath || !validTaskOrigin(task.origin)) throw new Error("Legacy/non-isolated task: open its worktree or Source Control; verified import metadata is unavailable.");
    requireTrustedFile(vscode.Uri.file(task.worktreePath));
    this.assertTaskInactive(id);
    if (this.resultOperations.has(id)) throw new Error("Wait for the result operation to finish.");
    this.resultOperations.add(id);
    this.patchTask(id, { reviewing: true });
    try {
      const snapshot = await cancellable("Capture observed task results", signal => captureBackgroundResult(task.worktreePath!, task.origin!, signal));
      await this.documents.inspect("Observed task results", snapshot.files.map(file => `${JSON.stringify(file.path)}: ${file.skipped ?? "regular text change"}`).join("\n") + "\n\nTests: not verified. The task's model summary is not command evidence.");
      const selected = await vscode.window.showQuickPick(snapshot.files.filter(file => !file.skipped).map(file => ({ label: file.path, description: file.before === undefined ? "Addition" : file.after === undefined ? "Deletion" : "Modification", file })), { title: "Select regular text files to preview for import", canPickMany: true });
      if (!selected?.length) { this.resultPreviews.delete(id); return; }
      for (const { file } of selected) {
        const before = this.documents.create(`base-${file.path}`, file.before ?? "");
        const after = this.documents.create(`task-${file.path}`, file.after ?? "");
        try { await vscode.commands.executeCommand("vscode.diff", before, after, `Task import preview: ${file.path}`, { preview: false }); }
        finally { this.documents.release(before); this.documents.release(after); }
      }
      this.resultPreviews.set(id, { snapshot, selected: selected.map(item => item.file.path) });
      await vscode.window.showInformationMessage("Selected task results previewed. Use Apply Selected to import; the task worktree will be retained.");
    } finally { this.resultOperations.delete(id); this.patchTask(id, { reviewing: false }); }
  }

  public async applySelected(id: string, targetCwd: string): Promise<void> {
    const task = this.requireTask(id);
    const preview = this.resultPreviews.get(id);
    if (!preview) throw new Error("Review Results and preview selected files first. Previews expire on reload.");
    requireTrustedFile(vscode.Uri.file(targetCwd));
    const cwd = await realpath(targetCwd);
    const target = await gitIdentity(cwd);
    if (JSON.stringify(target) !== JSON.stringify(preview.snapshot.origin.repository)) throw new Error("Switch Pi to the task's originating worktree before importing results.");
    if (this.resultOperations.has(id)) throw new Error("A task result operation is already active.");
    const release = acquireOperation(target.root, "task result import");
    let releaseCwd = () => {};
    try {
      if (cwd !== target.root) releaseCwd = acquireOperation(cwd, "task result import");
      this.resultOperations.add(id);
      this.patchTask(id, { reviewing: true });
      if (await vscode.window.showWarningMessage(`Import ${preview.selected.length} previewed files into ${target.root}? No staging or branch changes. Filesystem writes are not atomic across files.`, { modal: true }, "Import Selected") !== "Import Selected") return;
      const report = await importBackgroundResult(preview.snapshot, preview.selected, {
        assertInactive: () => { requireTrustedFile(); this.assertTaskInactive(id); },
        isDirty: isDirtyFile,
      });
      this.patchTask(id, { importReport: report });
      this.resultPreviews.delete(id);
      await this.documents.inspect("Task import report", JSON.stringify(report, null, 2));
    } finally { releaseCwd(); release(); this.resultOperations.delete(id); this.patchTask(task.id, { reviewing: false }); }
  }

  public async cleanupWorktree(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (!task.worktreePath) {
      return;
    }
    requireTrustedFile(vscode.Uri.file(task.worktreePath));
    if (this.active.has(id) || this.resultOperations.has(id)) {
      throw new Error("Cancel or wait for the task/review/import before removing its worktree.");
    }
    this.assertTaskInactive(id);
    const storageRoot = await realpath(path.join(this.context.globalStorageUri.fsPath, "worktrees"));
    const worktree = await realpath(task.worktreePath);
    if (path.dirname(worktree) !== storageRoot || path.basename(worktree) !== task.id) throw new Error("Worktree cleanup path is not owned by this task.");
    const repository = await primaryWorktree(worktree);
    await execFilePromise("git", ["-C", repository, "worktree", "remove", "--force", worktree]);
    this.resultPreviews.delete(id);
    this.patchTask(id, { worktreePath: undefined });
  }

  public dispose(): void {
    this.documents.dispose();
    this.resultPreviews.clear();
    for (const id of [...this.active.keys()]) {
      void this.stopActive(id);
    }
    this.emitter.dispose();
  }

  private async createWorktree(cwd: string, id: string): Promise<{ worktreePath: string; origin: TaskOrigin }> {
    const identity = await gitIdentity(cwd);
    const baseCommit = (await gitRevision(identity.root)).head;
    if (!baseCommit) throw new Error("Worktree agents require an existing base commit.");
    const repository = identity.root;
    const root = path.join(this.context.globalStorageUri.fsPath, "worktrees");
    const target = path.join(root, id);
    await mkdir(root, { recursive: true });
    await execFilePromise("git", ["-c", "core.hooksPath=/dev/null", "-C", repository, "worktree", "add", "--detach", target, baseCommit]);
    return { worktreePath: await realpath(target), origin: { repository: identity, baseCommit } };
  }

  private handleEvent(id: string, event: PiRpcEvent): void {
    if (event.type === "message_update") {
      const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        const task = this.requireTask(id);
        this.patchTask(id, { output: (task.output + update.delta).slice(-maxOutputCharacters) });
      }
    } else if (event.type === "tool_execution_start") {
      this.patchTask(id, { tool: typeof event.toolName === "string" ? event.toolName : "tool" });
    } else if (event.type === "tool_execution_end") {
      this.patchTask(id, { tool: undefined });
    } else if (event.type === "agent_settled") {
      void this.completeTask(id);
    } else if (event.type === "extension_ui_request") {
      void this.handleExtensionUi(id, event).catch(error => this.failTask(id, error));
    } else if (event.type === "process_exit" && !event.expected && this.active.has(id)) {
      this.failTask(id, new Error("The background Pi process exited unexpectedly."));
      void this.stopActive(id);
    }
  }

  private async handleExtensionUi(taskId: string, event: PiRpcEvent): Promise<void> {
    const active = this.active.get(taskId);
    const id = typeof event.id === "string" ? event.id : undefined;
    const method = typeof event.method === "string" ? event.method : undefined;
    if (!active || !id || !method) {
      return;
    }
    if (method === "confirm") {
      const title = typeof event.title === "string" ? event.title : "Allow background Pi action?";
      const message = typeof event.message === "string" ? event.message : title;
      const choice = await vscode.window.showWarningMessage(`${title}\n${message}`, { modal: true }, "Allow");
      active.client.sendExtensionUiResponse(id, { confirmed: choice === "Allow" });
    } else if (method === "select") {
      const options = Array.isArray(event.options) ? event.options.filter(value => typeof value === "string") : [];
      const value = await vscode.window.showQuickPick(options, { title: typeof event.title === "string" ? event.title : "Pi" });
      active.client.sendExtensionUiResponse(id, value === undefined ? { cancelled: true } : { value });
    } else if (method === "input" || method === "editor") {
      const value = await vscode.window.showInputBox({
        title: typeof event.title === "string" ? event.title : "Pi Input",
        value: typeof event.prefill === "string" ? event.prefill : undefined,
      });
      active.client.sendExtensionUiResponse(id, value === undefined ? { cancelled: true } : { value });
    } else if (method === "notify") {
      const message = typeof event.message === "string" ? event.message : "Pi notification";
      await vscode.window.showInformationMessage(message);
    }
  }

  private async completeTask(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) {
      return;
    }
    try {
      const state = await active.client.getState();
      const sessionFile = typeof state.sessionFile === "string" ? state.sessionFile : undefined;
      this.patchTask(id, {
        status: active.cancelRequested ? "cancelled" : "completed",
        sessionFile,
        tool: undefined,
      });
    } catch (error) {
      this.failTask(id, error);
    } finally {
      await this.stopActive(id);
    }
  }

  private failTask(id: string, error: unknown): void {
    this.patchTask(id, {
      status: this.active.get(id)?.cancelRequested ? "cancelled" : "failed",
      error: error instanceof Error ? error.message : String(error),
      tool: undefined,
    });
  }

  private async stopActive(id: string): Promise<void> {
    const active = this.active.get(id);
    if (!active) {
      return;
    }
    this.active.delete(id);
    active.subscription.dispose();
    try { await active.client.stop(); } finally { active.releaseOperation(); }
  }

  private setTask(task: BackgroundTaskState): void {
    this.tasks.set(task.id, task);
    const protectedTasks = {
      has: (id: string) => this.active.has(id) || this.resultOperations.has(id) || isBackgroundTaskActive(this.tasks.get(id)?.status),
    };
    for (const id of backgroundTaskIdsToEvict(this.tasks.keys(), protectedTasks, maxTasks)) {
      this.tasks.delete(id);
      this.resultPreviews.delete(id);
    }
    this.publish();
  }

  private patchTask(id: string, changes: Partial<BackgroundTaskState>): void {
    const task = this.requireTask(id);
    this.setTask({ ...task, ...changes });
  }

  private assertTaskInactive(id: string): void {
    const task = this.requireTask(id);
    if (this.active.has(id) || task.inactivityUnverified) throw new Error("Task inactivity is unverified. Inspect its worktree instead of importing.");
    if (task.processId) {
      try { process.kill(task.processId, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return; throw new Error("Cannot verify task process inactivity."); }
      throw new Error("The recorded task process is still running (or its PID was reused); import is unavailable.");
    }
  }

  private requireTask(id: string): BackgroundTaskState {
    const task = this.tasks.get(id);
    if (!task) {
      throw new Error("The background Pi task no longer exists.");
    }
    return task;
  }

  private publish(): void {
    const states = this.states;
    void this.context.workspaceState.update(storageKey, states).then(undefined, () => {});
    this.emitter.fire(states);
  }
}

async function primaryWorktree(cwd: string): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", cwd, "worktree", "list", "--porcelain", "-z"]);
  const first = stdout.split("\0").find(line => line.startsWith("worktree "));
  if (!first) {
    throw new Error("Could not locate the primary Git worktree.");
  }
  return first.slice("worktree ".length);
}

function execFilePromise(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024, timeout: 30_000, shell: false, windowsHide: true, env: gitEnvironment() }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`${command} ${args.join(" ")} failed: ${stderr || error.message}`));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function isBackgroundTaskState(value: unknown): value is BackgroundTaskState {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    (value.status === "starting" || value.status === "running" || value.status === "completed" || value.status === "failed" || value.status === "cancelled") &&
    typeof value.output === "string" && value.output.length <= maxOutputCharacters && value.id.length <= 200 && value.title.length <= 500 &&
    [value.cwd, value.worktreePath, value.sessionFile].every(item => item === undefined || (typeof item === "string" && path.isAbsolute(item) && !item.includes("\0"))) &&
    (value.importReport === undefined || isImportReport(value.importReport)) &&
    (value.processId === undefined || (Number.isSafeInteger(value.processId) && Number(value.processId) > 0)) &&
    (value.inactivityUnverified === undefined || typeof value.inactivityUnverified === "boolean")
  );
}

function isImportReport(value: unknown): boolean {
  return isRecord(value) && ["applied", "skipped", "failed"].every(key => {
    const list = value[key];
    return Array.isArray(list) && list.length <= 100 && list.every(item => typeof item === "string" && item.length <= 4000);
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
