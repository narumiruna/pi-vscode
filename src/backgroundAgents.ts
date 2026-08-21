import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { buildAgentPrompt, type ChatReferenceContext } from "./prompts";
import { PiRpcClient, type PiRpcEvent, type PiRpcImage } from "./piRpcClient";
import { getRuntimeProfile } from "./runtimeProfiles";
import { readPiInvocationOptions } from "./vscodePi";

const storageKey = "piCodingAgent.backgroundTasks.v1";
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
}

interface ActiveTask {
  readonly client: PiRpcClient;
  readonly subscription: vscode.Disposable;
  cancelRequested: boolean;
}

export class BackgroundAgentManager implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<readonly BackgroundTaskState[]>();
  private readonly tasks = new Map<string, BackgroundTaskState>();
  private readonly active = new Map<string, ActiveTask>();
  public readonly onDidChange = this.emitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    const restored = context.workspaceState.get<unknown>(storageKey);
    if (Array.isArray(restored)) {
      for (const task of restored.filter(isBackgroundTaskState).slice(-maxTasks)) {
        this.tasks.set(task.id, task.status === "running" || task.status === "starting"
          ? { ...task, status: "failed", error: "VS Code closed before this task completed." }
          : task);
      }
    }
  }

  public get states(): readonly BackgroundTaskState[] {
    return [...this.tasks.values()];
  }

  public async start(
    request: string,
    contexts: readonly ChatReferenceContext[],
    images: readonly PiRpcImage[],
    cwd: string,
    isolatedWorktree: boolean,
  ): Promise<string> {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const title = request.length > 60 ? `${request.slice(0, 57)}…` : request;
    this.setTask({ id, title, status: "starting", output: "" });

    let taskCwd = cwd;
    let worktreePath: string | undefined;
    if (isolatedWorktree) {
      try {
        worktreePath = await this.createWorktree(cwd, id);
        taskCwd = worktreePath;
        this.patchTask(id, { worktreePath });
      } catch (error) {
        this.failTask(id, error);
        throw error;
      }
    }

    const invocation = readPiInvocationOptions(vscode.Uri.file(taskCwd));
    const profile = getRuntimeProfile("agent");
    const configuration = vscode.workspace.getConfiguration("piCodingAgent");
    const client = new PiRpcClient({
      executablePath: invocation.executablePath,
      cwd: taskCwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      tools: profile.tools,
      appendSystemPrompt: `${profile.systemPrompt} This is an independent background task. Work only in the provided working directory.`,
      approveProjectResources: configuration.get<boolean>("approveProjectResources", false),
    });
    const subscription = client.onEvent(event => this.handleEvent(id, event));
    this.active.set(id, { client, subscription, cancelRequested: false });

    try {
      await client.start();
      await client.setSessionName(title);
      this.patchTask(id, { status: "running" });
      await client.prompt(buildAgentPrompt(request, contexts), images);
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
    await active.client.abort();
  }

  public async openSession(id: string): Promise<string> {
    const task = this.requireTask(id);
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

  public async cleanupWorktree(id: string): Promise<void> {
    const task = this.requireTask(id);
    if (!task.worktreePath) {
      return;
    }
    if (this.active.has(id)) {
      throw new Error("Cancel or wait for the task before removing its worktree.");
    }
    const repository = await primaryWorktree(task.worktreePath);
    await execFilePromise("git", ["-C", repository, "worktree", "remove", "--force", task.worktreePath]);
    await rm(task.worktreePath, { recursive: true, force: true });
    this.patchTask(id, { worktreePath: undefined });
  }

  public dispose(): void {
    for (const id of [...this.active.keys()]) {
      void this.stopActive(id);
    }
    this.emitter.dispose();
  }

  private async createWorktree(cwd: string, id: string): Promise<string> {
    const repository = await gitRoot(cwd);
    const root = path.join(this.context.globalStorageUri.fsPath, "worktrees");
    const target = path.join(root, id);
    await mkdir(root, { recursive: true });
    await execFilePromise("git", ["-C", repository, "worktree", "add", "--detach", target, "HEAD"]);
    return target;
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
    } else if (event.type === "process_exit" && !event.expected && this.active.has(id)) {
      this.failTask(id, new Error("The background Pi process exited unexpectedly."));
      void this.stopActive(id);
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
      status: "failed",
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
    await active.client.stop();
  }

  private setTask(task: BackgroundTaskState): void {
    this.tasks.set(task.id, task);
    while (this.tasks.size > maxTasks) {
      const oldest = this.tasks.keys().next().value;
      if (!oldest) {
        break;
      }
      this.tasks.delete(oldest);
    }
    this.publish();
  }

  private patchTask(id: string, changes: Partial<BackgroundTaskState>): void {
    const task = this.requireTask(id);
    this.setTask({ ...task, ...changes });
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
  const { stdout } = await execFilePromise("git", ["-C", cwd, "worktree", "list", "--porcelain"]);
  const first = stdout.split(/\r?\n/).find(line => line.startsWith("worktree "));
  if (!first) {
    throw new Error("Could not locate the primary Git worktree.");
  }
  return first.slice("worktree ".length);
}

async function gitRoot(cwd: string): Promise<string> {
  const { stdout } = await execFilePromise("git", ["-C", cwd, "rev-parse", "--show-toplevel"]);
  const root = stdout.trim();
  if (!root) {
    throw new Error("A Git repository is required for worktree isolation.");
  }
  return root;
}

function execFilePromise(command: string, args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8", maxBuffer: 5 * 1024 * 1024 }, (error, stdout, stderr) => {
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
    typeof value.output === "string"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
