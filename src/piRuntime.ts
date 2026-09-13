import path from "node:path";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { ConversationResponseCapture, ExclusiveOperationGate } from "./conversationController";
import { randomUUID } from "node:crypto";
import { assertSessionWorkspace } from "./sessionIdentity";
import { parseRpcQueue, type PiRpcQueue } from "./piRpcClient";
import { PiRpcClient, type PiRpcClientOptions, type PiRpcEvent, type PiRpcImage } from "./piRpcClient";
import { readPiInvocationOptions } from "./vscodePi";
import { VscodeBridgeServer } from "./vscodeBridge";
import {
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
} from "./vscodeBridgeProtocol";

const sessionPathKey = "piCodingAgent.rpc.sessionPath.v1";

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
  readonly queueable?: boolean;
  readonly recoveredDrafts?: readonly { id: string; text: string; uncertain: boolean }[];
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
  private pendingInstruction: { text: string; kind: "steering" | "followUp"; previousOccurrences: number; observed: boolean } | undefined;

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
    try { return await action(); }
    finally { release(); this.stateEmitter.fire(this.currentState); }
  }

  public get currentCwd(): string {
    return readPiInvocationOptions(this.resource).cwd;
  }

  public async initializeBridge(): Promise<void> {
    const environment = await this.bridge.start();
    this.context.environmentVariableCollection.description =
      "Connects standalone Pi extensions to the active Pi VS Code window.";
    this.context.environmentVariableCollection.replace(
      vscodeBridgePortEnvironmentKey,
      environment[vscodeBridgePortEnvironmentKey] ?? "",
    );
    this.context.environmentVariableCollection.replace(
      vscodeBridgeTokenEnvironmentKey,
      environment[vscodeBridgeTokenEnvironmentKey] ?? "",
    );
  }

  public broadcastToPi(event: string, data: unknown): number {
    return this.bridge.broadcast(event, data);
  }

  public async ensureStarted(resource?: vscode.Uri): Promise<void> {
    if (!vscode.workspace.isTrusted) throw new Error("Pi requires a trusted workspace.");
    if (resource && !["file", "untitled"].includes(resource.scheme)) throw new Error("Pi requires file-backed resources (or an untitled editor in a file-backed workspace).");
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
    if (resource) {
      if (!["file", "untitled"].includes(resource.scheme)) throw new Error("Pi requests require file-backed resources.");
      const target = readPiInvocationOptions(resource).cwd;
      if (await realpath(target) !== await realpath(this.currentCwd)) throw new Error("The target workspace differs from Pi's active working directory. Switch workspace/session explicitly.");
    }
    const client = this.requireClient();
    if (this.state.busy) {
      throw new Error("Pi is already working. Send a steering message or cancel the active request first.");
    }
    beforeSubmit?.();

    const settled = this.createSettledWaiter();
    void settled.promise.catch(() => undefined);
    this.promptActive = true;
    this.updateState({ busy: true, queueable: allowQueue, queue: { steering: [], followUp: [] } });
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

  public async queueInstruction(kind: "steer" | "followUp", text: string): Promise<void> {
    if (!this.state.busy || !this.state.queueable || this.queueStopping || text.trimStart().startsWith("/")) throw new Error("Only an active ordinary composer request accepts plain-text queued instructions.");
    const release = this.queueGate.acquire();
    try {
      const queue = this.state.queue ?? { steering: [], followUp: [] };
      parseRpcQueue({ steering: [...queue.steering, text], followUp: queue.followUp });
      const client = this.requireClient();
      const revision = this.queueRevision;
      const queueKind = kind === "steer" ? "steering" : "followUp";
      this.pendingInstruction = { text, kind: queueKind, previousOccurrences: queue[queueKind].filter(item => item === text).length, observed: false };
      try {
        await client[kind](text);
        if (!this.state.busy || !this.state.queueable || this.queueRevision === revision) throw new Error("Pi settled during acceptance or did not report queue_update; delivery is uncertain.");
      }
      catch (error) {
        // process_exit owns recovery, including an unacknowledged submission.
        await client.stop();
        throw new Error(`Queue acceptance is uncertain or unsupported. Pi disconnected; do not blindly resend. ${formatError(error)}`);
      }
    } finally { this.pendingInstruction = undefined; release(); }
  }

  public async clearInstructions(): Promise<void> {
    if (!this.state.queueable) throw new Error("This request does not own a composer queue.");
    const release = this.queueGate.acquire();
    this.queueStopping = true;
    try {
      const client = this.requireClient();
      try { const cleared = await client.clearQueue(); this.recoverQueue([...cleared.steering, ...cleared.followUp], false); this.updateState({ queue: { steering: [], followUp: [] } }); }
      catch (error) { await client.stop(); throw new Error(`Queue clearing unsupported/uncertain; disconnected without replay. ${formatError(error)}`); }
    } finally { release(); this.queueStopping = false; }
  }

  private recoverQueue(texts: readonly string[], uncertain: boolean): void {
    this.updateState({ recoveredDrafts: [...(this.state.recoveredDrafts ?? []), ...texts.map(text => ({ id: randomUUID(), text, uncertain }))].slice(-20) });
  }

  public async abort(): Promise<void> {
    const client = this.client; if (!client) return;
    if (this.queueGate.isPending) {
      await client.stop();
      throw new Error("Pi disconnected during an ambiguous queue operation. Check recovered drafts; no automatic replay.");
    }
    this.queueStopping = true;
    const release = this.queueGate.acquire();
    try {
      const cleared = await client.clearQueue();
      this.recoverQueue([...cleared.steering, ...cleared.followUp], false);
      this.updateState({ queue: { steering: [], followUp: [] } });
      await client.abort();
    } catch (error) {
      await client.stop();
      throw new Error(`Could not guarantee clear-queue before abort. Pi disconnected; pending delivery is uncertain. ${formatError(error)}`);
    } finally { release(); this.queueStopping = false; }
  }

  public async newSession(): Promise<void> {
    return this.owned(async () => {
    await this.ensureStarted(this.resource);
    if (this.state.busy) throw new Error("Stop or wait for Pi before starting a session.");
    const result = await this.requireClient().newSession();
    if (isRecord(result) && result.cancelled) throw new Error("Pi cancelled the session switch.");
    this.updateState({ queue: { steering: [], followUp: [] }, queueable: false });
    await this.refreshState(true);
    });
  }

  public async deleteSession(): Promise<void> {
    return this.owned(async () => {
    await this.ensureStarted(this.resource);
    if (this.state.busy) {
      throw new Error("Cancel or wait for the active request before deleting the conversation.");
    }
    const sessionFile = this.state.sessionFile;
    await this.stopClient();
    if (sessionFile) {
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(sessionFile), { useTrash: true });
      } catch (error) {
        await this.ensureStarted(this.resource).catch(() => undefined);
        throw error;
      }
    }
    await this.context.workspaceState.update(sessionPathKey, undefined);
    this.state = emptyState();
    this.stateEmitter.fire(this.state);
    await this.ensureStarted(this.resource);
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
    this.updateState({ queue: { steering: [], followUp: [] }, queueable: false });
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
    const bridgeEnvironment = await this.bridge.start();
    const shellArgs: string[] = [];
    if (sessionFile) {
      shellArgs.push("--session", sessionFile);
    }
    const terminal = vscode.window.createTerminal({
      name: "Pi Agent",
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
    const bridgeEnvironment = await this.bridge.start();
    const options = this.buildClientOptions(sessionPath, bridgeEnvironment);
    const client = new PiRpcClient(options);
    this.clientSubscription?.dispose();
    this.clientSubscription = client.onEvent(event => this.handleEvent(event));
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

  private buildClientOptions(sessionPath: string | undefined, bridgeEnvironment: NodeJS.ProcessEnv): PiRpcClientOptions {
    const invocation = readPiInvocationOptions(this.resource);
    const configuration = vscode.workspace.getConfiguration("piCodingAgent");
    return {
      executablePath: invocation.executablePath,
      cwd: invocation.cwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      extensions: [
        path.join(this.context.extensionUri.fsPath, "resources", "pi-vscode-permission-gate.ts"),
        path.join(this.context.extensionUri.fsPath, "resources", "pi-vscode-read-only-gate.ts"),
      ],
      sessionPath,
      approveProjectResources: configuration.get<boolean>("approveProjectResources", false),
      env: {
        ...bridgeEnvironment,
        PI_VSCODE_PERMISSION_MODE: configuration.get<string>("agent.confirmToolCalls", "dangerous"),
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
      queueable: this.state.queueable,
      recoveredDrafts: this.state.recoveredDrafts,
    };
    this.stateEmitter.fire(this.state);
  }

  private handleEvent(event: PiRpcEvent): void {
    this.eventEmitter.fire(event);
    if (event.type === "queue_update") {
      const queue = parseRpcQueue(event);
      const pending = this.pendingInstruction;
      if (pending && queue[pending.kind].filter(text => text === pending.text).length > pending.previousOccurrences) pending.observed = true;
      this.queueRevision++;
      this.updateState({ queue });
      if (this.queueStopping && (queue.steering.length || queue.followUp.length)) {
        void this.client?.stop();
        this.eventEmitter.fire({ type: "runtime_warning", message: "Queue changed during cancellation; disconnected to prevent hidden continuation." });
      }
    } else if (event.type === "agent_start") {
      this.updateState({ busy: true });
    } else if (event.type === "agent_settled") {
      this.promptActive = false;
      this.updateState({ busy: false, queueable: false });
      void this.refreshState(false).catch(error => {
        this.eventEmitter.fire({ type: "runtime_warning", message: formatError(error) });
      });
    } else if (event.type === "process_exit") {
      this.promptActive = false;
      this.clientSubscription?.dispose();
      this.clientSubscription = undefined;
      this.client = undefined;
      const pending = this.pendingInstruction;
      const queue = this.state.queue ?? { steering: [], followUp: [] };
      const unobserved = pending && (!pending.observed || !queue[pending.kind].includes(pending.text));
      this.recoverQueue([...queue.steering, ...queue.followUp, ...(unobserved ? [pending.text] : [])], true);
      this.pendingInstruction = undefined;
      this.updateState({ connected: false, busy: false, queueable: false, queue: { steering: [], followUp: [] } });
    }
  }

  private createSettledWaiter(
    timeoutMs = 30 * 60 * 1_000,
  ): { promise: Promise<string | undefined>; dispose: () => void } {
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
      subscription = this.onEvent(event => {
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
    this.updateState({ connected: false, busy: false });
  }
}

function emptyState(): PiRuntimeState {
  return {
    connected: false,
    busy: false,
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
