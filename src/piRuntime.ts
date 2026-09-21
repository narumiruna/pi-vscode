import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { picodeConfiguration } from "./configuration";
import { ConversationResponseCapture, ExclusiveOperationGate } from "./conversationController";
import {
  PiRpcClient,
  type PiRpcClientOptions,
  type PiRpcEvent,
  type PiRpcImage,
  type PiRpcQueue,
  parseRpcQueue,
} from "./piRpcClient";
import { assertSessionWorkspace } from "./sessionIdentity";
import { VscodeBridgeServer } from "./vscodeBridge";
import {
  vscodeBridgeExtensionEnvironmentKey,
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
} from "./vscodeBridgeProtocol";
import { readPiInvocationOptions } from "./vscodePi";

const sessionPathKey = "picode.rpc.sessionPath.v1";
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
  private queueStopping = false;
  private promptActive = false;
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
    return path.join(this.context.extensionUri.fsPath, "resources", "picode-bridge.ts");
  }

  private async bridgeEnvironment(): Promise<NodeJS.ProcessEnv> {
    return {
      ...(await this.bridge.start()),
      [vscodeBridgeExtensionEnvironmentKey]: this.bridgeExtensionPath,
    };
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
  ): Promise<string | undefined> {
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
        await client.prompt(message, images);
        onAccepted?.();
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
    const client = this.client;
    if (!client) return;
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
        message: `The conversation was deleted. ${warnings.join(" ")}`,
      });
  }

  public async setSessionName(name: string): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().setSessionName(name);
    await this.refreshState(false);
  }

  public async switchSession(sessionPath: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Stop or wait for Pi before switching session.");
      await this.ensureStarted(this.resource);
      await assertSessionWorkspace(sessionPath, this.currentCwd);
      const result = await this.requireClient().switchSession(sessionPath);
      if (isRecord(result) && result.cancelled) throw new Error("Pi cancelled the session switch.");
      this.resetQueueTracking();
      this.updateState({ queue: { steering: [], followUp: [] }, pendingQueue: emptyPendingQueue(), queueable: false });
      await this.refreshState(true);
    });
  }

  public async compact(customInstructions?: string): Promise<void> {
    return this.owned(async () => {
      if (this.state.busy) throw new Error("Wait for Pi before compacting the session.");
      await this.ensureStarted(this.resource);
      this.updateState({ busy: true });
      try {
        await this.requireClient().compact(customInstructions);
        await this.refreshState(false);
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

  public sendExtensionUiResponse(id: string, fields: Record<string, unknown>): void {
    this.client?.sendExtensionUiResponse(id, fields);
  }

  public async exportSession(outputPath?: string): Promise<string> {
    await this.ensureStarted(this.resource);
    return this.requireClient().exportHtml(outputPath);
  }

  public async openInTerminal(): Promise<void> {
    await this.ensureStarted(this.resource);
    const sessionFile = this.state.sessionFile;
    const invocation = readPiInvocationOptions(this.resource);
    const bridgeEnvironment = await this.bridgeEnvironment();
    const shellArgs = ["--extension", this.bridgeExtensionPath];
    if (sessionFile) {
      shellArgs.push("--session", sessionFile);
    }
    const terminal = vscode.window.createTerminal({
      name: "Pi",
      cwd: invocation.cwd,
      shellPath: invocation.executablePath,
      shellArgs,
      env: bridgeEnvironment,
    });
    terminal.show();
  }

  public dispose(): void {
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
        message: "The previous Pi session could not be restored, so a new session was started.",
      });
    }
  }

  private async createAndStartClient(sessionPath: string | undefined): Promise<void> {
    if (sessionPath) await assertSessionWorkspace(sessionPath, this.currentCwd);
    const bridgeEnvironment = await this.bridgeEnvironment();
    const options = this.buildClientOptions(sessionPath, bridgeEnvironment);
    const client = new PiRpcClient(options);
    this.clientSubscription?.dispose();
    this.clientSubscription = client.onEvent((event) => this.handleEvent(event));
    this.client = client;
    try {
      await client.start();
      await this.refreshState(true);
    } catch (error) {
      this.clientSubscription.dispose();
      this.clientSubscription = undefined;
      this.client = undefined;
      await client.stop();
      throw error;
    }
  }

  private buildClientOptions(
    sessionPath: string | undefined,
    bridgeEnvironment: NodeJS.ProcessEnv,
  ): PiRpcClientOptions {
    const invocation = readPiInvocationOptions(this.resource);
    const configuration = picodeConfiguration();
    return {
      executablePath: invocation.executablePath,
      cwd: invocation.cwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      extensions: [
        this.bridgeExtensionPath,
        path.join(this.context.extensionUri.fsPath, "resources", "picode-permission-gate.ts"),
        path.join(this.context.extensionUri.fsPath, "resources", "picode-read-only-gate.ts"),
      ],
      sessionPath,
      approveProjectResources: configuration.get<boolean>("approveProjectResources", false),
      env: {
        ...bridgeEnvironment,
        PICODE_PERMISSION_MODE: configuration.get<string>("agent.confirmToolCalls", "dangerous"),
      },
    };
  }

  private async refreshState(includeCatalogs: boolean): Promise<void> {
    const client = this.requireClient();
    const revision = ++this.refreshRevision;
    const [rpcState, stats, models, thinkingLevels, commands] = await Promise.all([
      client.getState(),
      client.getSessionStats().catch(() => undefined),
      includeCatalogs ? client.getAvailableModels().catch(() => []) : Promise.resolve(this.state.availableModels),
      includeCatalogs
        ? client.getAvailableThinkingLevels().catch(() => [])
        : Promise.resolve(this.state.availableThinkingLevels),
      includeCatalogs ? client.getCommands().catch(() => []) : Promise.resolve(this.state.commands),
    ]);
    if (revision !== this.refreshRevision || this.client !== client) return;
    const sessionFile = stringField(rpcState, "sessionFile");
    if (sessionFile) {
      await this.context.workspaceState.update(sessionPathKey, sessionFile);
    }
    if (revision !== this.refreshRevision || this.client !== client) return;
    this.state = {
      connected: true,
      busy: this.promptActive || Boolean(rpcState.isStreaming),
      model: recordField(rpcState, "model"),
      thinkingLevel: stringField(rpcState, "thinkingLevel"),
      sessionFile,
      sessionId: stringField(rpcState, "sessionId"),
      sessionName: stringField(rpcState, "sessionName"),
      availableModels: models.filter(isRecord),
      availableThinkingLevels: thinkingLevels,
      commands: commands.filter(isRecord),
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

  private async stopClient(): Promise<void> {
    const client = this.client;
    this.clientSubscription?.dispose();
    this.clientSubscription = undefined;
    this.client = undefined;
    if (client) {
      await client.stop();
    }
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
