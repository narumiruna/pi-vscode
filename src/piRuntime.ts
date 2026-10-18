import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { piConfiguration } from "./configuration";
import { ConversationResponseCapture, ExclusiveOperationGate } from "./conversationController";
import { type ExtensionDialogRequest, ExtensionDialogRequests } from "./extensionDialogRequests";
import {
  maxShellPolicyMessageCharacters,
  type ShellResult,
  shellAbortDeadlineMs,
  shellCapabilityName,
  shellExecutionDeadlineMs,
  shellPolicyTitle,
  validateShellCommand,
} from "./directShell";
import {
  PiRpcClient,
  type PiRpcClientOptions,
  type PiRpcEvent,
  type PiRpcImage,
  type PiRpcQueue,
  parseRpcQueue,
} from "./piRpcClient";
import { PiRuntimeControl } from "./piRuntimeControl";
import { assertSessionWorkspace } from "./sessionIdentity";
import { VscodeBridgeServer } from "./vscodeBridge";
import {
  vscodeBridgeExtensionEnvironmentKey,
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
} from "./vscodeBridgeProtocol";
import { readPiInvocationOptions } from "./vscodePi";

const sessionPathKey = "pi.rpc.sessionPath.v1";
const maxQueueRecoveryBytes = 30 * 1024 * 1024;
const maxPendingQueueDisplayCharacters = 1_000;

export class SessionTrashUnavailableError extends Error {
  public constructor(
    public readonly sessionFile: string,
    options?: ErrorOptions,
  ) {
    super("This file provider cannot move the conversation to Trash.", options);
    this.name = "SessionTrashUnavailableError";
  }
}

export function isTrashUnavailableError(error: unknown): boolean {
  const code = isRecord(error) && typeof error.code === "string" ? error.code.toLowerCase() : "";
  const message = (
    isRecord(error) && typeof error.message === "string" ? error.message : formatError(error)
  ).toLowerCase();
  return (
    code === "notsupported" ||
    code === "not_supported" ||
    /trash.{0,80}(?:unavailable|unsupported|not supported|not implemented)/.test(message) ||
    /(?:provider|filesystem).{0,40}(?:does not support|unsupported).{0,40}trash/.test(message)
  );
}

export type DeleteConversationOutcome =
  | { readonly status: "deleted"; readonly permanently: boolean }
  | { readonly status: "kept" }
  | { readonly status: "failed"; readonly error: unknown; readonly permanently: boolean };

export async function deleteConversationWithTrashFallback(actions: {
  readonly moveToTrash: () => Promise<void>;
  readonly confirmPermanent: (error: SessionTrashUnavailableError) => Promise<boolean>;
  readonly deletePermanently: (error: SessionTrashUnavailableError) => Promise<void>;
}): Promise<DeleteConversationOutcome> {
  let trashUnavailable: SessionTrashUnavailableError;
  try {
    await actions.moveToTrash();
    return { status: "deleted", permanently: false };
  } catch (error) {
    if (!(error instanceof SessionTrashUnavailableError)) return { status: "failed", error, permanently: false };
    trashUnavailable = error;
  }
  if (!(await actions.confirmPermanent(trashUnavailable))) return { status: "kept" };
  try {
    await actions.deletePermanently(trashUnavailable);
    return { status: "deleted", permanently: true };
  } catch (error) {
    return { status: "failed", error, permanently: true };
  }
}

export interface PendingQueueInstruction {
  readonly id: string;
  readonly kind: "steering" | "followUp";
  readonly text: string;
  readonly hasAttachments: boolean;
}

export interface PiRuntimePendingQueue {
  readonly steering: readonly PendingQueueInstruction[];
  readonly followUp: readonly PendingQueueInstruction[];
}

export interface QueueInstructionDeliveredEvent extends PiRpcEvent {
  readonly type: "queue_instruction_delivered";
  readonly instruction: PendingQueueInstruction;
}

export interface PiRuntimeState {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly model?: Record<string, unknown>;
  readonly thinkingLevel?: string;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly availableModels: readonly Record<string, unknown>[];
  readonly availableThinkingLevels: readonly string[];
  readonly commands: readonly Record<string, unknown>[];
  readonly stats?: Record<string, unknown>;
  readonly queue?: PiRpcQueue;
  readonly pendingQueue?: PiRuntimePendingQueue;
  readonly queueable?: boolean;
  readonly recoveredDrafts?: readonly { id: string; text: string; uncertain: boolean; hasAttachments?: boolean }[];
}

export interface QueueInstructionOptions {
  readonly instructionId?: string;
  readonly images?: readonly PiRpcImage[];
  readonly resource?: vscode.Uri;
  readonly recoveryText?: string;
  readonly restoreAttachments?: () => void;
  readonly hasAttachments?: boolean;
  readonly recoveryBytes?: number;
}

type RuntimeQueueKind = "steering" | "followUp";
interface TrackedQueueInstruction {
  readonly id: string;
  readonly kind: RuntimeQueueKind;
  readonly message: string;
  readonly recoveryText: string;
  readonly restoreAttachments?: () => void;
  readonly hasAttachments: boolean;
  readonly recoveryBytes: number;
}

export function runtimeSessionIdentityChanged(
  before: Pick<PiRuntimeState, "sessionFile" | "sessionId">,
  after: Pick<PiRuntimeState, "sessionFile" | "sessionId">,
): boolean {
  return Boolean(
    (before.sessionFile && after.sessionFile && before.sessionFile !== after.sessionFile) ||
      (before.sessionId && after.sessionId && before.sessionId !== after.sessionId),
  );
}

export class PiRuntimeManager implements vscode.Disposable {
  private readonly extensionDialogs = new ExtensionDialogRequests();
  private readonly dialogOrigins = new WeakMap<PiRpcEvent, ExtensionDialogRequest>();
  private dialogGeneration = 0;
  private readonly eventEmitter = new vscode.EventEmitter<PiRpcEvent>();
  private readonly stateEmitter = new vscode.EventEmitter<PiRuntimeState>();
  private readonly bridge = new VscodeBridgeServer();
  private client: PiRpcClient | undefined;
  private clientSubscription: vscode.Disposable | undefined;
  private startPromise: Promise<void> | undefined;
  private resource: vscode.Uri | undefined;
  private state: PiRuntimeState;
  private readonly queueGate = new ExclusiveOperationGate("Wait for the current queue operation.");
  private readonly ownership = new ExclusiveOperationGate("Wait for the current Pi request or session operation.");
  private refreshRevision = 0;
  private readonly control: PiRuntimeControl;
  private queueStopping = false;
  private promptActive = false;
  private shellActive:
    | {
        readonly id: string;
        readonly client: PiRpcClient;
        readonly sessionId: string;
        readonly sessionFile?: string;
        readonly cwd: string;
        readonly workspacePath: string;
        readonly command: string;
        readonly excludeFromContext: boolean;
        readonly assertCurrent: () => Promise<void>;
        approved: boolean;
        consumed: boolean;
        cancelled: boolean;
        execution?: Promise<ShellResult>;
        stopping?: Promise<void>;
      }
    | undefined;
  private queueRevision = 0;
  private readonly trackedQueue: Record<RuntimeQueueKind, TrackedQueueInstruction[]> = { steering: [], followUp: [] };
  private readonly awaitingQueueStarts: TrackedQueueInstruction[] = [];
  private readonly recoveredAttachmentHandles = new Map<
    string,
    { readonly restore: () => void; readonly bytes: number }
  >();
  private pendingInstruction:
    | { record: TrackedQueueInstruction; minimumOccurrences: number; observed: boolean; delivered: boolean }
    | undefined;

  public readonly onEvent = this.eventEmitter.event;
  public readonly onDidChangeState = this.stateEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.state = emptyState();
    const runtime = this;
    this.control = new PiRuntimeControl({
      context,
      get cwd() {
        return runtime.currentCwd;
      },
      get resource() {
        return runtime.resource;
      },
      get state() {
        return runtime.state;
      },
      get client() {
        return runtime.client;
      },
      get hasPendingDialogs() {
        return runtime.hasPendingExtensionDialogs;
      },
      get queuePending() {
        return (
          runtime.queueGate.isPending ||
          Boolean(
            runtime.state.queue?.steering.length ||
              runtime.state.queue?.followUp.length ||
              runtime.awaitingQueueStarts.length,
          )
        );
      },
      owned: (action) => runtime.owned(action),
      start: () => runtime.ensureStarted(runtime.resource),
      startSession: (sessionFile) => runtime.createAndStartClient(sessionFile),
      stop: () => runtime.stopClient(),
      refresh: () => runtime.refreshState(true, true),
      emit: (event) => runtime.eventEmitter.fire(event),
      resetUi: () => runtime.resetExtensionUi(),
      terminalOptions: async () =>
        runtime.buildClientOptions(runtime.state.sessionFile, await runtime.bridgeEnvironment()),
    });
  }

  public get currentState(): PiRuntimeState {
    return { ...this.state, busy: this.state.busy || this.ownership.isPending };
  }

  private async owned<T>(action: () => Promise<T>): Promise<T> {
    const release = this.ownership.acquire();
    this.stateEmitter.fire(this.currentState);
    try {
      return await action();
    } finally {
      release();
      this.stateEmitter.fire(this.currentState);
    }
  }

  public get currentCwd(): string {
    return readPiInvocationOptions(this.resource).cwd;
  }

  private get bridgeExtensionPath(): string {
    return path.join(this.context.extensionUri.fsPath, "resources", "pi-bridge.ts");
  }

  private async bridgeEnvironment(): Promise<NodeJS.ProcessEnv> {
    return {
      ...(await this.bridge.start()),
      [vscodeBridgeExtensionEnvironmentKey]: this.bridgeExtensionPath,
    };
  }

  public initializeControlOwnership(): Promise<void> {
    return this.control.initializeOwnership();
  }

  public async initializeBridge(): Promise<void> {
    const environment = await this.bridgeEnvironment();
    this.context.environmentVariableCollection.description =
      "Connects process-local Pi bridge extensions to the active Pi VS Code window.";
    for (const key of [
      vscodeBridgePortEnvironmentKey,
      vscodeBridgeTokenEnvironmentKey,
      vscodeBridgeExtensionEnvironmentKey,
    ]) {
      this.context.environmentVariableCollection.replace(key, environment[key] ?? "");
    }
  }

  public broadcastToPi(event: string, data: unknown): number {
    return this.bridge.broadcast(event, data);
  }

  public async ensureStarted(resource?: vscode.Uri): Promise<void> {
    await this.control.initializeOwnership();
    this.control.assertSidebarOwnership();
    if (!vscode.workspace.isTrusted) throw new Error("Pi requires a trusted workspace.");
    if (resource && !["file", "untitled"].includes(resource.scheme))
      throw new Error("Pi requires file-backed resources (or an untitled editor in a file-backed workspace).");
    const folder = resource ? vscode.workspace.getWorkspaceFolder(resource) : vscode.workspace.workspaceFolders?.[0];
    if (folder && folder.uri.scheme !== "file") throw new Error("Pi does not support virtual workspaces.");
    if (this.client?.isRunning) {
      return;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.resource = resource ?? this.resource ?? vscode.window.activeTextEditor?.document.uri;
    this.startPromise = this.startClient();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = undefined;
    }
  }

  private async assertResourceMatchesActiveWorkspace(resource: vscode.Uri): Promise<void> {
    if (!["file", "untitled"].includes(resource.scheme)) throw new Error("Pi requests require file-backed resources.");
    const target = readPiInvocationOptions(resource).cwd;
    if ((await realpath(target)) !== (await realpath(this.currentCwd)))
      throw new Error(
        "The target workspace differs from Pi's active working directory. Switch workspace/session explicitly.",
      );
  }

  public async prompt(
    message: string,
    resource?: vscode.Uri,
    images?: readonly PiRpcImage[],
    onAccepted?: () => void,
    beforeSubmit?: () => void,
    allowQueue = false,
  ): Promise<string | { disposition: "handled" } | undefined> {
    if (/^\/vscode-pi-/i.test(message.trimStart()))
      throw new Error("The vscode-pi-* namespace is reserved for verified host controls.");
    return this.owned(async () => {
      await this.ensureStarted(resource);
      if (resource) await this.assertResourceMatchesActiveWorkspace(resource);
      const client = this.requireClient();
      if (this.state.busy) {
        throw new Error("Pi is already working. Send a steering message or cancel the active request first.");
      }
      beforeSubmit?.();

      const settled = this.createSettledWaiter();
      void settled.promise.catch(() => undefined);
      this.promptActive = true;
      this.trackedQueue.steering.splice(0);
      this.trackedQueue.followUp.splice(0);
      this.awaitingQueueStarts.splice(0);
      this.updateState({
        busy: true,
        queueable: allowQueue,
        queue: { steering: [], followUp: [] },
        pendingQueue: emptyPendingQueue(),
      });
      try {
        const disposition = await client.prompt(message, images);
        onAccepted?.();
        if (disposition === "handled") {
          this.promptActive = false;
          this.updateState({ busy: false });
          await this.refreshStateAfterCommand(true, "Slash command");
          return { disposition: "handled" };
        }
        return await settled.promise;
      } catch (error) {
        this.promptActive = false;
        await client.stop();
        this.updateState({ busy: false });
        throw error;
      } finally {
        this.promptActive = false;
        this.updateState({ queueable: false });
        settled.dispose();
      }
    });
  }

  /** Only the explicit idle composer dispatch calls this mutation route. */
  public async executeShell(
    command: string,
    excludeFromContext: boolean,
    onAccepted?: () => void,
    onHistory?: (messages: readonly unknown[]) => Promise<void>,
  ): Promise<ShellResult | undefined> {
    return this.withForegroundOperation("direct shell", async (client, assertCurrent) => {
      validateShellCommand(command);
      if (this.state.busy || this.state.queue?.steering.length || this.state.queue?.followUp.length)
        throw new Error("Direct shell requires an idle session with no queued work.");
      const folder = this.resource
        ? vscode.workspace.getWorkspaceFolder(this.resource)
        : vscode.workspace.workspaceFolders?.[0];
      if (!folder || folder.uri.scheme !== "file") throw new Error("Direct shell requires a file-backed workspace.");
      const cwd = await realpath(this.currentCwd);
      if ((await realpath(folder.uri.fsPath)) !== cwd)
        throw new Error("Direct shell workspace differs from Pi's working directory.");
      if (this.state.sessionFile) await assertSessionWorkspace(this.state.sessionFile, cwd);
      const commands = await client.getCommands();
      const policyPath = path.join(this.context.extensionUri.fsPath, "resources", "pi-permission-gate.ts");
      const readOnlyPath = path.join(this.context.extensionUri.fsPath, "resources", "pi-read-only-gate.ts");
      const hasPolicy = async (name: string, sourcePath: string, description: string): Promise<boolean> => {
        const matches = commands.filter((value) => isRecord(value) && value.name === name);
        const value = matches[0];
        if (
          matches.length !== 1 ||
          !isRecord(value) ||
          value.source !== "extension" ||
          value.description !== description ||
          !isRecord(value.sourceInfo) ||
          typeof value.sourceInfo.path !== "string"
        )
          return false;
        try {
          return (await realpath(value.sourceInfo.path)) === (await realpath(sourcePath));
        } catch {
          return false;
        }
      };
      if (
        !(await hasPolicy(shellCapabilityName, policyPath, "VS Code direct-shell policy; Pi 1.3.0")) ||
        !(await hasPolicy("vscode-pi-read-only-ready", readOnlyPath, "VS Code read-only direct-shell policy v1"))
      )
        throw new Error(
          "Direct shell is unavailable: verified Pi 1.3.0 packaged policies are required. No command ran.",
        );
      if (!this.state.sessionId || this.state.sessionId.length > 200 || cwd.length > 8_192)
        throw new Error("Direct shell requires a bounded verified session and working-directory identity.");
      await assertCurrent();
      const shell = {
        id: randomUUID(),
        client,
        sessionId: this.state.sessionId,
        sessionFile: this.state.sessionFile,
        cwd,
        workspacePath: folder.uri.fsPath,
        command,
        excludeFromContext,
        assertCurrent,
        approved: false,
        consumed: false,
        cancelled: false,
        execution: undefined as Promise<ShellResult> | undefined,
        stopping: undefined as Promise<void> | undefined,
      };
      this.shellActive = shell;
      // The shared owner projects busy while its state stays idle for assertCurrent.
      this.updateState({ queueable: false });
      let result: ShellResult = { output: "", cancelled: false, truncated: false };
      let submitted = false;
      try {
        const choice = await vscode.window.showWarningMessage(
          `Run this shell command with your user permissions?\n\nWorking directory: ${cwd}\n${excludeFromContext ? "Excluded from model context; command/output remain in Pi history and exports." : "Command/output enter model context on the next prompt and remain in Pi history."}\nShell effects cannot be restored by request checkpoints.\n\n${command}`,
          { modal: true },
          "Run Shell",
        );
        if (choice !== "Run Shell" || shell.cancelled) return undefined;
        await this.assertShellOrigin(shell);
        shell.approved = true;
        submitted = true;
        this.eventEmitter.fire({
          type: "shell_execution",
          id: shell.id,
          command,
          excludeFromContext,
          result,
          state: "running",
        });
        shell.execution = client.bash(command, excludeFromContext, (update) => {
          if (
            this.shellActive !== shell ||
            this.client !== client ||
            this.state.sessionId !== shell.sessionId ||
            this.state.sessionFile !== shell.sessionFile
          )
            return;
          result = update;
          this.eventEmitter.fire({
            type: "shell_execution",
            id: shell.id,
            command,
            excludeFromContext,
            result,
            state: "running",
          });
        });
        onAccepted?.();
        try {
          result = await withDeadline(
            shell.execution,
            shellExecutionDeadlineMs,
            "Direct shell reached its execution deadline.",
          );
        } catch (error) {
          await this.stopShell(shell);
          throw error;
        }
        if (shell.stopping) await shell.stopping;
        if (!shell.cancelled) await this.assertShellOrigin(shell);
        const finalState = await client.getState();
        if (finalState.sessionId !== shell.sessionId || stringField(finalState, "sessionFile") !== shell.sessionFile)
          throw new Error("Pi session changed while shell was running; output belongs to the original session.");
        this.eventEmitter.fire({
          type: "shell_execution",
          id: shell.id,
          command,
          excludeFromContext,
          result,
          state: "finished",
        });
        if (onHistory) {
          const history = await client.getMessages();
          await shell.assertCurrent();
          await onHistory(history);
        }
        await this.refreshStateAfterCommand(false, "Direct shell");
        return result;
      } catch (error) {
        if (submitted) {
          if (
            this.shellActive === shell &&
            (!this.client || this.client === client) &&
            this.state.sessionId === shell.sessionId &&
            this.state.sessionFile === shell.sessionFile
          )
            this.eventEmitter.fire({
              type: "shell_execution",
              id: shell.id,
              command,
              excludeFromContext,
              result,
              state: "uncertain",
            });
          throw new Error(
            `Direct shell did not complete reliably. Do not repeat it automatically. Inspect processes, Source Control, and external effects. ${formatError(error)}`,
          );
        }
        throw error;
      } finally {
        if (this.shellActive === shell) {
          this.shellActive = undefined;
          if (!this.client || this.client === client) this.updateState({ busy: false, queueable: false });
        }
      }
    });
  }

  private async assertShellOrigin(shell: NonNullable<PiRuntimeManager["shellActive"]>): Promise<void> {
    await shell.assertCurrent();
    if (
      !vscode.workspace.isTrusted ||
      this.shellActive !== shell ||
      shell.cancelled ||
      this.client !== shell.client ||
      !shell.client.isRunning ||
      this.state.sessionId !== shell.sessionId ||
      this.state.sessionFile !== shell.sessionFile ||
      (await realpath(this.currentCwd)) !== shell.cwd ||
      (await realpath(shell.workspacePath)) !== shell.cwd
    )
      throw new Error("Direct shell approval is stale or belongs to another workspace/session.");
    // Repeat synchronous identity checks after the asynchronous canonical checks.
    if (
      !vscode.workspace.isTrusted ||
      this.shellActive !== shell ||
      shell.cancelled ||
      this.client !== shell.client ||
      this.state.sessionId !== shell.sessionId ||
      this.state.sessionFile !== shell.sessionFile
    )
      throw new Error("Direct shell origin changed during validation.");
  }

  private async authorizeShellPolicy(event: PiRpcEvent, client: PiRpcClient): Promise<void> {
    const id = typeof event.id === "string" ? event.id : undefined;
    if (!id || id.length > 200) return;
    let confirmed = false;
    const shell = this.shellActive;
    try {
      if (!shell || shell.client !== client || !shell.approved || shell.consumed || event.method !== "confirm")
        throw new Error("No direct-shell approval belongs to this request.");
      if (typeof event.message !== "string" || event.message.length > maxShellPolicyMessageCharacters)
        throw new Error("Invalid or oversized direct-shell policy payload.");
      const payload: unknown = JSON.parse(event.message);
      if (
        !isRecord(payload) ||
        Object.keys(payload).length !== 4 ||
        payload.command !== shell.command ||
        typeof payload.cwd !== "string" ||
        payload.cwd.length > 8_192 ||
        payload.excludeFromContext !== shell.excludeFromContext ||
        payload.sessionId !== shell.sessionId
      )
        throw new Error("Direct-shell policy origin mismatch.");
      shell.consumed = true;
      if ((await realpath(payload.cwd)) !== shell.cwd) throw new Error("Direct-shell policy directory mismatch.");
      await this.assertShellOrigin(shell);
      confirmed = true;
    } catch {
      // Fail closed. Never send the request through the generic extension UI.
    }
    if (this.client === client && client.isRunning) {
      try {
        client.sendExtensionUiResponse(id, { confirmed });
      } catch (error) {
        await client.stop();
        this.eventEmitter.fire({
          type: "runtime_warning",
          warningCode: "cleanup-unverified",
          message: `Shell policy acknowledgement failed; disconnected without replay. ${formatError(error)}`,
        });
      }
    }
  }

  private async stopShell(shell: NonNullable<PiRuntimeManager["shellActive"]>): Promise<void> {
    shell.cancelled = true;
    if (!shell.execution) return;
    if (shell.stopping) return shell.stopping;
    shell.stopping = (async () => {
      try {
        await withDeadline(shell.client.abortBash(), shellAbortDeadlineMs, "Shell abort was not acknowledged.");
        await withDeadline(shell.execution!, shellAbortDeadlineMs, "Shell did not settle after abort.");
        this.eventEmitter.fire({
          type: "runtime_warning",
          warningCode: "cleanup-unverified",
          message:
            "The shell acknowledged cancellation and returned a final result. Escaped descendants may remain; Windows descendant cleanup is unverified. Inspect processes and effects before conflicting work.",
        });
      } catch (error) {
        await shell.client.stop();
        this.eventEmitter.fire({
          type: "runtime_warning",
          warningCode: "cleanup-unverified",
          message: `Direct shell disconnected without verified settlement. Escaped or Windows descendants may remain. ${formatError(error)}`,
        });
        throw error;
      }
    })();
    return shell.stopping;
  }

  public async queueInstruction(
    kind: "steer" | "followUp",
    text: string,
    options: QueueInstructionOptions = {},
  ): Promise<void> {
    if (!this.state.busy || !this.state.queueable || this.queueStopping || text.trimStart().startsWith("/"))
      throw new Error(
        "Only an active ordinary composer request accepts queued instructions that are not slash commands.",
      );
    const release = this.queueGate.acquire();
    try {
      if (options.resource) await this.assertResourceMatchesActiveWorkspace(options.resource);
      const queue = this.state.queue ?? { steering: [], followUp: [] };
      const queueKind = kind === "steer" ? "steering" : "followUp";
      parseRpcQueue({
        steering: queueKind === "steering" ? [...queue.steering, text] : queue.steering,
        followUp: queueKind === "followUp" ? [...queue.followUp, text] : queue.followUp,
      });
      this.seedTrackedQueue(queue);
      const recoveryBytes = options.recoveryBytes ?? 0;
      const pendingRecoveryBytes = [
        ...this.trackedQueue.steering,
        ...this.trackedQueue.followUp,
        ...this.awaitingQueueStarts,
      ].reduce((total, record) => total + record.recoveryBytes, 0);
      const recoveredBytes = [...this.recoveredAttachmentHandles.values()].reduce(
        (total, handle) => total + handle.bytes,
        0,
      );
      if (
        !Number.isSafeInteger(recoveryBytes) ||
        recoveryBytes < 0 ||
        recoveredBytes + pendingRecoveryBytes + recoveryBytes > maxQueueRecoveryBytes
      ) {
        throw new Error("Queued attachment snapshots exceed the 30 MiB in-memory recovery limit.");
      }
      const id = options.instructionId ?? randomUUID();
      if (!id || id.length > 200 || this.hasQueueInstruction(id))
        throw new Error("Queued instruction identity is invalid or already active.");
      const record: TrackedQueueInstruction = {
        id,
        kind: queueKind,
        message: text,
        recoveryText: options.recoveryText ?? text,
        restoreAttachments: options.restoreAttachments,
        hasAttachments: Boolean(options.hasAttachments),
        recoveryBytes,
      };
      this.trackedQueue[queueKind].push(record);
      const client = this.requireClient();
      const revision = this.queueRevision;
      this.pendingInstruction = {
        record,
        minimumOccurrences: queue[queueKind].filter((item) => item === text).length,
        observed: false,
        delivered: false,
      };
      try {
        await client[kind](text, options.images);
        if (
          !this.state.busy ||
          !this.state.queueable ||
          this.queueRevision === revision ||
          (!this.pendingInstruction.observed && !this.pendingInstruction.delivered)
        )
          throw new Error(
            "Pi settled during acceptance or did not report the queued instruction; delivery is uncertain.",
          );
      } catch (error) {
        const delivered = this.pendingInstruction?.record.id === record.id && this.pendingInstruction.delivered;
        // process_exit owns recovery, including an unacknowledged submission.
        await client.stop();
        if (delivered) {
          this.eventEmitter.fire({
            type: "runtime_warning",
            warningCode: "queue-delivered",
            message: `Pi delivered the queued instruction but its acknowledgement failed. Pi disconnected without replay. ${formatError(error)}`,
          });
          return;
        }
        throw new Error(
          `Queue acceptance is uncertain or unsupported. Pi disconnected; do not blindly resend. ${formatError(error)}`,
        );
      }
    } finally {
      this.pendingInstruction = undefined;
      release();
    }
  }

  public async clearInstructions(): Promise<void> {
    if (!this.state.queueable) throw new Error("This request does not own a composer queue.");
    const release = this.queueGate.acquire();
    this.queueStopping = true;
    try {
      const client = this.requireClient();
      try {
        const cleared = await client.clearQueue();
        if (this.awaitingQueueStarts.length)
          throw new Error("A queued instruction left the pending queue without a delivery event.");
        this.recoverQueue(this.takeClearedInstructions(cleared), false);
        this.updateState({ queue: { steering: [], followUp: [] }, pendingQueue: emptyPendingQueue() });
      } catch (error) {
        await client.stop();
        throw new Error(`Queue clearing unsupported/uncertain; disconnected without replay. ${formatError(error)}`);
      }
    } finally {
      release();
      this.queueStopping = false;
    }
  }

  public restoreRecoveredDraftAttachments(id: string): void {
    const draft = this.state.recoveredDrafts?.find((candidate) => candidate.id === id);
    if (!draft) throw new Error("This recovered queue draft is no longer available.");
    const handle = this.recoveredAttachmentHandles.get(id);
    if (!handle) return;
    handle.restore();
    this.recoveredAttachmentHandles.delete(id);
    this.updateState({
      recoveredDrafts: this.state.recoveredDrafts?.map((candidate) =>
        candidate.id === id ? { ...candidate, hasAttachments: false } : candidate,
      ),
    });
  }

  private recoverQueue(records: readonly TrackedQueueInstruction[], uncertain: boolean): void {
    const existing = this.state.recoveredDrafts ?? [];
    const additions = records.map((record) => {
      const id = randomUUID();
      if (record.restoreAttachments)
        this.recoveredAttachmentHandles.set(id, { restore: record.restoreAttachments, bytes: record.recoveryBytes });
      return { id, text: record.recoveryText, uncertain, ...(record.hasAttachments ? { hasAttachments: true } : {}) };
    });
    const candidates = [...existing, ...additions];
    const retainedReversed: typeof candidates = [];
    let retainedBytes = 0;
    for (let index = candidates.length - 1; index >= 0 && retainedReversed.length < 20; index -= 1) {
      const candidate = candidates[index]!;
      const bytes = this.recoveredAttachmentHandles.get(candidate.id)?.bytes ?? 0;
      if (retainedBytes + bytes > maxQueueRecoveryBytes) continue;
      retainedBytes += bytes;
      retainedReversed.push(candidate);
    }
    const recoveredDrafts = retainedReversed.reverse();
    const retained = new Set(recoveredDrafts.map((draft) => draft.id));
    for (const id of this.recoveredAttachmentHandles.keys())
      if (!retained.has(id)) this.recoveredAttachmentHandles.delete(id);
    this.updateState({ recoveredDrafts });
  }

  public async abort(): Promise<void> {
    if (this.shellActive) return this.stopShell(this.shellActive);
    const client = this.client;
    if (!client) return;
    try {
      this.extensionDialogs.cancelPending();
    } catch (error) {
      await client.stop();
      throw new Error(`Pi disconnected after a dialog cancellation write failed. ${formatError(error)}`);
    }
    if (this.queueGate.isPending) {
      await client.stop();
      throw new Error(
        "Pi disconnected during an ambiguous queue operation. Check recovered drafts; no automatic replay.",
      );
    }
    this.queueStopping = true;
    const release = this.queueGate.acquire();
    try {
      const cleared = await client.clearQueue();
      if (this.awaitingQueueStarts.length)
        throw new Error("A queued instruction left the pending queue without a delivery event.");
      this.recoverQueue(this.takeClearedInstructions(cleared), false);
      this.updateState({ queue: { steering: [], followUp: [] }, pendingQueue: emptyPendingQueue() });
      await client.abort();
    } catch (error) {
      await client.stop();
      throw new Error(
        `Could not guarantee clear-queue before abort. Pi disconnected; pending delivery is uncertain. ${formatError(error)}`,
      );
    } finally {
      release();
      this.queueStopping = false;
    }
  }

  public async newSession(): Promise<void> {
    return this.owned(async () => {
      await this.ensureStarted(this.resource);
      if (this.state.busy) throw new Error("Stop or wait for Pi before starting a session.");
      if (this.hasPendingExtensionDialogs) throw new Error("Finish or cancel the Pi extension dialog first.");
      this.invalidateExtensionDialogs();
      this.control.invalidate();
      this.resetExtensionUi();
      const result = await this.requireClient().newSession();
      if (isRecord(result) && result.cancelled) throw new Error("Pi cancelled the session switch.");
      this.resetQueueTracking();
      this.updateState({ queue: { steering: [], followUp: [] }, pendingQueue: emptyPendingQueue(), queueable: false });
      await this.refreshState(true);
    });
  }

  public async deleteSession(): Promise<void> {
    await this.deleteSessionFile(true);
  }

  public async deleteSessionPermanently(sessionFile: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Cancel or wait for the active request before deleting the conversation.");
      await assertSessionWorkspace(sessionFile, this.currentCwd);
      if (this.state.sessionFile !== sessionFile) {
        await vscode.workspace.fs.delete(vscode.Uri.file(sessionFile), { useTrash: false });
        return;
      }
      if (this.state.connected) await this.stopClient();
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(sessionFile), { useTrash: false });
      } catch (error) {
        await this.ensureStarted(this.resource).catch(() => undefined);
        throw error;
      }
      await this.finishDeletedSession();
    });
  }

  private async deleteSessionFile(useTrash: boolean): Promise<void> {
    return this.owned(async () => {
      await this.ensureStarted(this.resource);
      if (this.state.busy) throw new Error("Cancel or wait for the active request before deleting the conversation.");
      const sessionFile = this.state.sessionFile;
      await this.stopClient();
      if (sessionFile) {
        try {
          await vscode.workspace.fs.delete(vscode.Uri.file(sessionFile), { useTrash });
        } catch (error) {
          const failure =
            useTrash && isTrashUnavailableError(error)
              ? new SessionTrashUnavailableError(sessionFile, { cause: error })
              : error;
          await this.ensureStarted(this.resource).catch(() => undefined);
          throw failure;
        }
      }
      await this.finishDeletedSession();
    });
  }

  private async finishDeletedSession(): Promise<void> {
    const warnings: string[] = [];
    try {
      await this.context.workspaceState.update(sessionPathKey, undefined);
    } catch (error) {
      warnings.push(`Session storage cleanup failed: ${formatError(error)}`);
    }
    this.recoveredAttachmentHandles.clear();
    this.resetQueueTracking();
    this.state = emptyState();
    this.stateEmitter.fire(this.state);
    try {
      await this.ensureStarted(this.resource);
    } catch (error) {
      warnings.push(`A replacement Pi session could not start: ${formatError(error)}`);
    }
    if (warnings.length)
      this.eventEmitter.fire({
        type: "runtime_warning",
        warningCode: "deleted-cleanup",
        message: `The conversation was deleted. ${warnings.join(" ")}`,
      });
  }

  public async setSessionName(name: string): Promise<void> {
    if (this.shellActive) throw new Error("Wait for direct shell before renaming the session.");
    await this.ensureStarted(this.resource);
    await this.requireClient().setSessionName(name);
    await this.refreshState(false);
  }

  public async switchSession(sessionPath: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Stop or wait for Pi before switching session.");
      await this.ensureStarted(this.resource);
      await assertSessionWorkspace(sessionPath, this.currentCwd);
      if (this.hasPendingExtensionDialogs) throw new Error("Finish or cancel the Pi extension dialog first.");
      this.invalidateExtensionDialogs();
      this.control.invalidate();
      this.resetExtensionUi();
      const result = await this.requireClient().switchSession(sessionPath);
      if (isRecord(result) && result.cancelled) throw new Error("Pi cancelled the session switch.");
      this.resetQueueTracking();
      this.updateState({ queue: { steering: [], followUp: [] }, pendingQueue: emptyPendingQueue(), queueable: false });
      await this.refreshState(true);
    });
  }

  public async compact(customInstructions?: string, onAccepted?: () => void): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Wait for Pi before compacting the session.");
      await this.ensureStarted(this.resource);
      this.updateState({ busy: true });
      try {
        await this.requireClient().compact(customInstructions);
        onAccepted?.();
        await this.refreshStateAfterCommand(false, "Compaction");
      } finally {
        // Compaction statistics do not prove the provider's remaining context usage.
        this.updateState({ busy: false, stats: undefined });
      }
    });
  }

  public async setModel(provider: string, modelId: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Wait for Pi before changing the model.");
      await this.ensureStarted(this.resource);
      await this.requireClient().setModel(provider, modelId);
      await this.refreshState(true);
    });
  }

  public async setThinkingLevel(level: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Wait for Pi before changing thinking level.");
      await this.ensureStarted(this.resource);
      await this.requireClient().setThinkingLevel(level);
      await this.refreshState(false);
    });
  }

  public async getMessages(): Promise<unknown[]> {
    await this.ensureStarted(this.resource);
    return this.requireClient().getMessages();
  }

  public get hasPendingExtensionDialogs(): boolean {
    return this.extensionDialogs.hasPending;
  }

  public invalidateExtensionDialogs(): void {
    this.dialogGeneration++;
    this.extensionDialogs.invalidate();
  }

  public claimExtensionUiRequest(event: PiRpcEvent): ExtensionDialogRequest | undefined {
    const request = this.dialogOrigins.get(event);
    this.dialogOrigins.delete(event);
    return request?.isActive ? request : undefined;
  }

  public withWorkspaceOperation<T>(
    label: string,
    action: (assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.control.withWorkspaceOperation(label, action);
  }

  public withForegroundOperation<T>(
    label: string,
    action: (client: PiRpcClient, assertCurrent: () => Promise<void>) => Promise<T>,
  ): Promise<T> {
    return this.control.withForegroundOperation(label, action);
  }

  public reloadResources(): Promise<boolean> {
    return this.control.reloadResources();
  }
  public restartResources(): Promise<boolean> {
    return this.control.restartResources();
  }
  public getSessionTree() {
    return this.control.getSessionTree();
  }
  public branchSession(action: "fork" | "clone" | "navigate", origin: string, targetId?: string) {
    return this.control.branchSession(action, origin, targetId);
  }
  public chooseSessionBranch(select: Parameters<PiRuntimeControl["chooseSessionBranch"]>[0]) {
    return this.control.chooseSessionBranch(select);
  }
  public returnFromTerminal(): Promise<boolean> {
    return this.control.returnFromTerminal();
  }

  public async exportSession(outputPath?: string): Promise<string> {
    await this.ensureStarted(this.resource);
    return this.requireClient().exportHtml(outputPath);
  }

  public openInTerminal(expectedOrigin?: () => Promise<void>): Promise<void> {
    return this.control.openInTerminal(expectedOrigin);
  }

  /** Clear before replacing resources/session so only newly emitted Pi UI is retained. */
  public resetExtensionUi(): void {
    this.invalidateExtensionDialogs();
    this.eventEmitter.fire({ type: "extension_ui_reset" });
  }

  public dispose(): void {
    this.resetExtensionUi();
    this.control.dispose();
    this.clientSubscription?.dispose();
    this.clientSubscription = undefined;
    void this.stopClient();
    this.context.environmentVariableCollection.clear();
    this.bridge.dispose();
    this.eventEmitter.dispose();
    this.stateEmitter.dispose();
  }

  private async startClient(): Promise<void> {
    const savedSession = this.context.workspaceState.get<string>(sessionPathKey);
    try {
      await this.createAndStartClient(savedSession);
    } catch (error) {
      if (!savedSession) {
        throw error;
      }
      await this.context.workspaceState.update(sessionPathKey, undefined);
      await this.createAndStartClient(undefined);
      this.eventEmitter.fire({
        type: "runtime_warning",
        warningCode: "session-replaced",
        message: "The previous Pi session could not be restored, so a new session was started.",
      });
    }
  }

  private async createAndStartClient(sessionPath: string | undefined): Promise<void> {
    if (sessionPath) await assertSessionWorkspace(sessionPath, this.currentCwd);
    const bridgeEnvironment = await this.bridgeEnvironment();
    const options = this.buildClientOptions(sessionPath, bridgeEnvironment);
    const client = new PiRpcClient(options);
    this.invalidateExtensionDialogs();
    this.clientSubscription?.dispose();
    const subscription = client.onEvent((event) => {
      if (this.client !== client) return;
      if (event.type === "extension_ui_request" && event.title === shellPolicyTitle) {
        void this.authorizeShellPolicy(event, client).catch((error) => {
          this.eventEmitter.fire({
            type: "runtime_warning",
            warningCode: "cleanup-unverified",
            message: `Shell policy cleanup failed. ${formatError(error)}`,
          });
        });
        return;
      }
      this.handleEvent(event);
    });
    this.clientSubscription = subscription;
    this.client = client;
    this.resetExtensionUi();
    this.control.clientStarted();
    try {
      await client.start();
      await this.refreshState(true);
    } catch (error) {
      subscription.dispose();
      if (this.client === client) {
        this.invalidateExtensionDialogs();
        this.clientSubscription = undefined;
        this.client = undefined;
        this.resetExtensionUi();
      }
      await this.stopDetachedClient(client);
      throw error;
    }
  }

  private buildClientOptions(
    sessionPath: string | undefined,
    bridgeEnvironment: NodeJS.ProcessEnv,
  ): PiRpcClientOptions {
    const invocation = readPiInvocationOptions(this.resource);
    const configuration = piConfiguration();
    return {
      executablePath: invocation.executablePath,
      cwd: invocation.cwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      extensions: [
        this.bridgeExtensionPath,
        path.join(this.context.extensionUri.fsPath, "resources", "pi-permission-gate.ts"),
        path.join(this.context.extensionUri.fsPath, "resources", "pi-read-only-gate.ts"),
        path.join(this.context.extensionUri.fsPath, "resources", "pi-control.ts"),
      ],
      sessionPath,
      approveProjectResources: configuration.get<boolean>("approveProjectResources", false),
      env: {
        ...bridgeEnvironment,
        PI_VSCODE_PERMISSION_MODE: configuration.get<string>("agent.confirmToolCalls", "dangerous"),
      },
    };
  }

  private async refreshStateAfterCommand(includeCatalogs: boolean, command: string): Promise<void> {
    try {
      await this.refreshState(includeCatalogs);
    } catch (error) {
      this.eventEmitter.fire({
        type: "runtime_warning",
        warningCode: "state-refresh",
        message: `${command} completed, but runtime state refresh failed. Reconnect to refresh state. Do not repeat the command. ${formatError(error)}`,
      });
    }
  }

  private async refreshState(includeCatalogs: boolean, strict = false): Promise<void> {
    const client = this.requireClient();
    const revision = ++this.refreshRevision;
    const [rpcState, stats, models, thinkingLevels, commands] = await Promise.all([
      client.getState(),
      client.getSessionStats().catch(() => undefined),
      includeCatalogs
        ? strict
          ? client.getAvailableModels()
          : client.getAvailableModels().catch(() => [])
        : Promise.resolve(this.state.availableModels),
      includeCatalogs
        ? strict
          ? client.getAvailableThinkingLevels()
          : client.getAvailableThinkingLevels().catch(() => [])
        : Promise.resolve(this.state.availableThinkingLevels),
      includeCatalogs
        ? strict
          ? client.getCommands()
          : client.getCommands().catch(() => [])
        : Promise.resolve(this.state.commands),
    ]);
    if (revision !== this.refreshRevision || this.client !== client) return;
    const sessionFile = stringField(rpcState, "sessionFile");
    if (sessionFile) {
      await this.context.workspaceState.update(sessionPathKey, sessionFile);
    }
    if (revision !== this.refreshRevision || this.client !== client) return;
    if (
      runtimeSessionIdentityChanged(this.state, {
        sessionId: stringField(rpcState, "sessionId"),
        sessionFile,
      })
    )
      this.invalidateExtensionDialogs();
    this.state = {
      connected: true,
      busy: Boolean(this.shellActive) || this.promptActive || Boolean(rpcState.isStreaming),
      model: recordField(rpcState, "model"),
      thinkingLevel: stringField(rpcState, "thinkingLevel"),
      sessionFile,
      sessionId: stringField(rpcState, "sessionId"),
      sessionName: stringField(rpcState, "sessionName"),
      availableModels: models.filter(isRecord),
      availableThinkingLevels: thinkingLevels,
      commands: commands
        .filter(isRecord)
        .filter((command) => typeof command.name !== "string" || !/^vscode-pi-/i.test(command.name)),
      stats,
      queue: this.state.queue,
      pendingQueue: this.state.pendingQueue,
      queueable: this.state.queueable,
      recoveredDrafts: this.state.recoveredDrafts,
    };
    this.stateEmitter.fire(this.state);
  }

  private seedTrackedQueue(queue: PiRpcQueue): void {
    for (const kind of ["steering", "followUp"] as const) {
      const tracked = this.trackedQueue[kind];
      const remote = queue[kind];
      if (!tracked.length) tracked.push(...remote.map((text) => this.textOnlyQueueRecord(kind, text)));
    }
  }

  private reconcileTrackedQueue(queue: PiRpcQueue): TrackedQueueInstruction[] {
    const reconciled: Record<RuntimeQueueKind, TrackedQueueInstruction[]> = { steering: [], followUp: [] };
    const delivered: Record<RuntimeQueueKind, TrackedQueueInstruction[]> = { steering: [], followUp: [] };
    for (const kind of ["steering", "followUp"] as const) {
      const records = [...this.trackedQueue[kind]];
      const remote = queue[kind];
      const pending = this.pendingInstruction;
      const protectedPending = pending?.record.kind === kind && !pending.observed ? pending.record : undefined;
      const protectedIndex = protectedPending ? records.findIndex((record) => record.id === protectedPending.id) : -1;
      if (protectedIndex >= 0) records.splice(protectedIndex, 1);
      if (!records.length) {
        records.push(...remote.map((text) => this.textOnlyQueueRecord(kind, text)));
      } else {
        const texts = records.map((record) => record.message);
        let deliveredCount = -1;
        for (let offset = 0; offset <= texts.length; offset += 1) {
          if (arraysEqual(texts.slice(offset), remote)) {
            deliveredCount = offset;
            break;
          }
        }
        if (deliveredCount >= 0) {
          delivered[kind].push(...records.splice(0, deliveredCount));
        } else if (arraysEqual(remote.slice(0, texts.length), texts)) {
          records.push(...remote.slice(texts.length).map((text) => this.textOnlyQueueRecord(kind, text)));
        } else {
          throw new Error(`Pi reported an inconsistent ${kind === "steering" ? "steering" : "follow-up"} queue.`);
        }
      }
      if (protectedPending && !records.some((record) => record.id === protectedPending.id))
        records.push(protectedPending);
      reconciled[kind] = records;
    }
    this.trackedQueue.steering.splice(0, this.trackedQueue.steering.length, ...reconciled.steering);
    this.trackedQueue.followUp.splice(0, this.trackedQueue.followUp.length, ...reconciled.followUp);
    return [...delivered.steering, ...delivered.followUp];
  }

  private takeClearedInstructions(cleared: PiRpcQueue): TrackedQueueInstruction[] {
    const validated: Record<RuntimeQueueKind, TrackedQueueInstruction[]> = { steering: [], followUp: [] };
    for (const kind of ["steering", "followUp"] as const) {
      const tracked = this.trackedQueue[kind];
      const remote = cleared[kind];
      const records = tracked.length ? [...tracked] : remote.map((text) => this.textOnlyQueueRecord(kind, text));
      if (
        !arraysEqual(
          records.map((record) => record.message),
          remote,
        )
      ) {
        throw new Error(`Pi cleared an unexpected ${kind === "steering" ? "steering" : "follow-up"} queue.`);
      }
      validated[kind] = records;
    }
    this.trackedQueue.steering.splice(0);
    this.trackedQueue.followUp.splice(0);
    return [...validated.steering, ...validated.followUp];
  }

  private textOnlyQueueRecord(kind: RuntimeQueueKind, text: string): TrackedQueueInstruction {
    return { id: randomUUID(), kind, message: text, recoveryText: text, hasAttachments: false, recoveryBytes: 0 };
  }

  private resetQueueTracking(): void {
    this.trackedQueue.steering.splice(0);
    this.trackedQueue.followUp.splice(0);
    this.awaitingQueueStarts.splice(0);
    this.pendingInstruction = undefined;
  }

  private hasQueueInstruction(id: string): boolean {
    return [...this.trackedQueue.steering, ...this.trackedQueue.followUp, ...this.awaitingQueueStarts].some(
      (record) => record.id === id,
    );
  }

  private pendingQueueState(): PiRuntimePendingQueue {
    const awaiting = (kind: RuntimeQueueKind) =>
      this.awaitingQueueStarts.filter((record) => record.kind === kind).map((record) => publicQueueInstruction(record));
    return {
      steering: [
        ...awaiting("steering"),
        ...this.trackedQueue.steering.map((record) => publicQueueInstruction(record)),
      ],
      followUp: [
        ...awaiting("followUp"),
        ...this.trackedQueue.followUp.map((record) => publicQueueInstruction(record)),
      ],
    };
  }

  private confirmQueueStart(event: PiRpcEvent): void {
    const text = userMessageText(event);
    if (text === undefined) return;
    const index = this.awaitingQueueStarts.findIndex((record) => record.message === text);
    if (index < 0) return;
    const [record] = this.awaitingQueueStarts.splice(index, 1);
    if (!record) return;
    if (this.pendingInstruction?.record.id === record.id) this.pendingInstruction.delivered = true;
    const delivered: QueueInstructionDeliveredEvent = {
      type: "queue_instruction_delivered",
      instruction: publicQueueInstruction(record),
    };
    this.eventEmitter.fire(delivered);
    this.updateState({ pendingQueue: this.pendingQueueState() });
  }

  private handleEvent(event: PiRpcEvent): void {
    if (event.type === "extension_ui_request" && event.method === "notify" &&
      typeof event.message === "string" && event.message.startsWith("PI_VSCODE_CONTROL_RESULT:")) return;
    if (event.type === "process_exit") this.invalidateExtensionDialogs();
    if (event.type === "extension_ui_request") {
      const client = this.client;
      const generation = this.dialogGeneration;
      if (client) {
        const request = this.extensionDialogs.accept(event, (response) => {
          if (this.client === client && client.isRunning && generation === this.dialogGeneration)
            client.sendExtensionUiResponse(event.id as string, response);
        });
        if (request) this.dialogOrigins.set(event, request);
      }
    }
    this.eventEmitter.fire(event);
    if (event.type === "queue_update") {
      const queue = parseRpcQueue(event);
      const pending = this.pendingInstruction;
      if (pending) {
        const occurrences = queue[pending.record.kind].filter((text) => text === pending.record.message).length;
        if (occurrences > pending.minimumOccurrences) pending.observed = true;
        else pending.minimumOccurrences = Math.min(pending.minimumOccurrences, occurrences);
      }
      this.queueRevision++;
      if (!this.queueStopping) {
        try {
          const awaitingStarts = this.reconcileTrackedQueue(queue);
          for (const record of awaitingStarts) {
            if (!this.awaitingQueueStarts.some((candidate) => candidate.id === record.id))
              this.awaitingQueueStarts.push(record);
          }
        } catch (error) {
          this.eventEmitter.fire({
            type: "runtime_warning",
            warningCode: "queue-uncertain",
            message: `${formatError(error)} Pi disconnected without replay.`,
          });
          void this.client?.stop();
          return;
        }
      }
      this.updateState({ queue, pendingQueue: this.pendingQueueState() });
      if (this.queueStopping && (queue.steering.length || queue.followUp.length)) {
        void this.client?.stop();
        this.eventEmitter.fire({
          type: "runtime_warning",
          warningCode: "queue-uncertain",
          message: "Queue changed during cancellation; disconnected to prevent hidden continuation.",
        });
      }
    } else if (event.type === "message_start") {
      this.confirmQueueStart(event);
    } else if (event.type === "agent_start") {
      this.updateState({ busy: true });
    } else if (event.type === "agent_settled") {
      this.promptActive = false;
      this.trackedQueue.steering.splice(0);
      this.trackedQueue.followUp.splice(0);
      if (this.awaitingQueueStarts.length) {
        const uncertain = this.awaitingQueueStarts.splice(0);
        this.recoverQueue(uncertain, true);
        this.eventEmitter.fire({
          type: "runtime_warning",
          warningCode: "queue-uncertain",
          message:
            "Pi settled after removing queued instructions without matching user-message delivery events. Review recovered drafts before resending.",
        });
      }
      this.updateState({
        busy: false,
        queueable: false,
        queue: { steering: [], followUp: [] },
        pendingQueue: emptyPendingQueue(),
      });
      void this.refreshState(false).catch((error) => {
        this.eventEmitter.fire({ type: "runtime_warning", message: formatError(error) });
      });
    } else if (event.type === "process_exit") {
      this.promptActive = false;
      this.clientSubscription?.dispose();
      this.clientSubscription = undefined;
      this.client = undefined;
      const queue = this.state.queue ?? { steering: [], followUp: [] };
      const records: TrackedQueueInstruction[] = [...this.awaitingQueueStarts];
      const pending = this.pendingInstruction;
      for (const kind of ["steering", "followUp"] as const) {
        const tracked = this.trackedQueue[kind];
        const remote = queue[kind];
        let delivered = -1;
        if (remote.length > 0) {
          const texts = tracked.map((record) => record.message);
          for (let offset = 0; offset <= texts.length; offset += 1) {
            if (arraysEqual(texts.slice(offset), remote)) {
              delivered = offset;
              break;
            }
          }
        }
        if (delivered >= 0) {
          records.push(...tracked.slice(delivered));
          continue;
        }
        for (let index = 0; index < remote.length; index += 1) {
          const text = remote[index]!;
          const record = tracked[index];
          records.push(record?.message === text ? record : this.textOnlyQueueRecord(kind, text));
        }
        for (const record of tracked) {
          if (record.id !== pending?.record.id && !records.some((candidate) => candidate.id === record.id))
            records.push(record);
        }
      }
      if (
        pending &&
        !pending.delivered &&
        (!pending.observed || !queue[pending.record.kind].includes(pending.record.message)) &&
        !records.some((record) => record.id === pending.record.id)
      )
        records.push(pending.record);
      this.trackedQueue.steering.splice(0);
      this.trackedQueue.followUp.splice(0);
      this.awaitingQueueStarts.splice(0);
      this.recoverQueue(records, true);
      this.pendingInstruction = undefined;
      this.updateState({
        connected: false,
        busy: false,
        queueable: false,
        queue: { steering: [], followUp: [] },
        pendingQueue: emptyPendingQueue(),
      });
    }
  }

  private createSettledWaiter(timeoutMs = 30 * 60 * 1_000): {
    promise: Promise<string | undefined>;
    dispose: () => void;
  } {
    const response = new ConversationResponseCapture();
    let finish: (() => void) | undefined;
    let subscription: vscode.Disposable | undefined;
    let timeout: NodeJS.Timeout | undefined;
    const promise = new Promise<string | undefined>((resolve, reject) => {
      finish = () => resolve(undefined);
      timeout = setTimeout(() => {
        subscription?.dispose();
        reject(new Error("Timed out waiting for Pi to settle."));
      }, timeoutMs);
      subscription = this.onEvent((event) => {
        response.accept(event);
        if (event.type === "agent_settled") {
          if (timeout) {
            clearTimeout(timeout);
          }
          subscription?.dispose();
          resolve(response.response);
        } else if (event.type === "process_exit") {
          if (timeout) {
            clearTimeout(timeout);
          }
          subscription?.dispose();
          reject(new Error("Pi exited before completing the request."));
        }
      });
    });
    return {
      promise,
      dispose: () => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = undefined;
        }
        subscription?.dispose();
        subscription = undefined;
        finish?.();
        finish = undefined;
      },
    };
  }

  private updateState(changes: Partial<PiRuntimeState>): void {
    this.state = { ...this.state, ...changes };
    this.stateEmitter.fire(this.state);
  }

  private requireClient(): PiRpcClient {
    if (!this.client?.isRunning) {
      throw new Error("Pi RPC is not running.");
    }
    return this.client;
  }

  private async stopDetachedClient(client: PiRpcClient | undefined): Promise<void> {
    if (!client) return;
    // The old session is detached. Forward cleanup warnings, not late state events.
    const subscription = client.onEvent((event) => {
      if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") {
        this.eventEmitter.fire(event);
      }
    });
    try {
      await client.stop();
    } finally {
      subscription.dispose();
    }
  }

  private async stopClient(): Promise<void> {
    this.invalidateExtensionDialogs();
    this.resetExtensionUi();
    const client = this.client;
    this.clientSubscription?.dispose();
    this.clientSubscription = undefined;
    this.client = undefined;
    await this.stopDetachedClient(client);
    this.resetQueueTracking();
    this.updateState({
      connected: false,
      busy: false,
      queueable: false,
      queue: { steering: [], followUp: [] },
      pendingQueue: emptyPendingQueue(),
    });
  }
}

function publicQueueInstruction(record: TrackedQueueInstruction): PendingQueueInstruction {
  const text =
    record.recoveryText.length > maxPendingQueueDisplayCharacters
      ? `${record.recoveryText.slice(0, maxPendingQueueDisplayCharacters - 1)}…`
      : record.recoveryText;
  return {
    id: record.id,
    kind: record.kind,
    text,
    hasAttachments: record.hasAttachments,
  };
}

function emptyPendingQueue(): PiRuntimePendingQueue {
  return { steering: [], followUp: [] };
}

function userMessageText(event: PiRpcEvent): string | undefined {
  if (event.type !== "message_start" || !isRecord(event.message) || event.message.role !== "user") return undefined;
  const content = event.message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  return content
    .filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map((part) => String(part.text))
    .join("");
}

function emptyState(): PiRuntimeState {
  return {
    connected: false,
    busy: false,
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
    pendingQueue: emptyPendingQueue(),
  };
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : undefined;
}

function recordField(record: Record<string, unknown>, key: string): Record<string, unknown> | undefined {
  return isRecord(record[key]) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function arraysEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function withDeadline<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
