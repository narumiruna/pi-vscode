import path from "node:path";
import * as vscode from "vscode";
import { ConversationResponseCapture } from "./conversationController";
import { PiRpcClient, type PiRpcClientOptions, type PiRpcEvent, type PiRpcImage } from "./piRpcClient";
import { getRuntimeProfile, normalizeMode, type PiAgentMode } from "./runtimeProfiles";
import { readPiInvocationOptions } from "./vscodePi";
import { VscodeBridgeServer } from "./vscodeBridge";
import {
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
} from "./vscodeBridgeProtocol";

const sessionPathKey = "piCodingAgent.rpc.sessionPath.v1";
const modeKey = "piCodingAgent.rpc.mode.v1";

export interface PiRuntimeState {
  readonly connected: boolean;
  readonly busy: boolean;
  readonly mode: PiAgentMode;
  readonly model?: Record<string, unknown>;
  readonly thinkingLevel?: string;
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly sessionName?: string;
  readonly availableModels: readonly Record<string, unknown>[];
  readonly availableThinkingLevels: readonly string[];
  readonly commands: readonly Record<string, unknown>[];
  readonly stats?: Record<string, unknown>;
}

export class PiRuntimeManager implements vscode.Disposable {
  private readonly eventEmitter = new vscode.EventEmitter<PiRpcEvent>();
  private readonly stateEmitter = new vscode.EventEmitter<PiRuntimeState>();
  private readonly bridge = new VscodeBridgeServer();
  private client: PiRpcClient | undefined;
  private clientSubscription: vscode.Disposable | undefined;
  private startPromise: Promise<void> | undefined;
  private resource: vscode.Uri | undefined;
  private mode: PiAgentMode;
  private state: PiRuntimeState;

  public readonly onEvent = this.eventEmitter.event;
  public readonly onDidChangeState = this.stateEmitter.event;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.mode = normalizeMode(
      context.workspaceState.get<string>(modeKey) ??
        vscode.workspace.getConfiguration("piCodingAgent").get<string>("defaultMode", "ask"),
    );
    this.state = emptyState(this.mode);
  }

  public get currentState(): PiRuntimeState {
    return this.state;
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
  ): Promise<string | undefined> {
    await this.ensureStarted(resource);
    const client = this.requireClient();
    if (this.state.busy) {
      throw new Error("Pi is already working. Send a steering message or cancel the active request first.");
    }
    beforeSubmit?.();

    const settled = this.createSettledWaiter();
    this.updateState({ busy: true });
    try {
      await client.prompt(message, images);
      onAccepted?.();
      return await settled.promise;
    } catch (error) {
      this.updateState({ busy: false });
      throw error;
    } finally {
      settled.dispose();
    }
  }

  public async abort(): Promise<void> {
    await this.client?.abort();
  }

  public async setMode(mode: PiAgentMode): Promise<void> {
    if (mode === this.mode) {
      return;
    }
    if (this.state.busy) {
      await this.abort();
    }
    await this.stopClient();
    this.mode = mode;
    await this.context.workspaceState.update(modeKey, mode);
    this.state = emptyState(mode);
    this.stateEmitter.fire(this.state);
    await this.ensureStarted(this.resource);
  }

  public async newSession(): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().newSession();
    await this.refreshState(true);
  }

  public async deleteSession(): Promise<void> {
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
    this.state = emptyState(this.mode);
    this.stateEmitter.fire(this.state);
    await this.ensureStarted(this.resource);
  }

  public async setSessionName(name: string): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().setSessionName(name);
    await this.refreshState(false);
  }

  public async switchSession(sessionPath: string): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().switchSession(sessionPath);
    await this.refreshState(true);
  }

  public async compact(customInstructions?: string): Promise<void> {
    await this.ensureStarted(this.resource);
    this.updateState({ busy: true });
    try {
      await this.requireClient().compact(customInstructions);
      await this.refreshState(false);
    } finally {
      this.updateState({ busy: false });
    }
  }

  public async setModel(provider: string, modelId: string): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().setModel(provider, modelId);
    await this.refreshState(false);
  }

  public async setThinkingLevel(level: string): Promise<void> {
    await this.ensureStarted(this.resource);
    await this.requireClient().setThinkingLevel(level);
    await this.refreshState(false);
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
    const profile = getRuntimeProfile(this.mode);
    return {
      executablePath: invocation.executablePath,
      cwd: invocation.cwd,
      provider: invocation.provider,
      model: invocation.model,
      thinkingLevel: invocation.thinkingLevel,
      tools: profile.tools,
      appendSystemPrompt: profile.systemPrompt,
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
    const [rpcState, stats, models, thinkingLevels, commands] = await Promise.all([
      client.getState(),
      client.getSessionStats().catch(() => undefined),
      includeCatalogs ? client.getAvailableModels().catch(() => []) : Promise.resolve(this.state.availableModels),
      includeCatalogs
        ? client.getAvailableThinkingLevels().catch(() => [])
        : Promise.resolve(this.state.availableThinkingLevels),
      includeCatalogs ? client.getCommands().catch(() => []) : Promise.resolve(this.state.commands),
    ]);
    const sessionFile = stringField(rpcState, "sessionFile");
    if (sessionFile) {
      await this.context.workspaceState.update(sessionPathKey, sessionFile);
    }
    this.state = {
      connected: true,
      busy: Boolean(rpcState.isStreaming),
      mode: this.mode,
      model: recordField(rpcState, "model"),
      thinkingLevel: stringField(rpcState, "thinkingLevel"),
      sessionFile,
      sessionId: stringField(rpcState, "sessionId"),
      sessionName: stringField(rpcState, "sessionName"),
      availableModels: models.filter(isRecord),
      availableThinkingLevels: thinkingLevels,
      commands: commands.filter(isRecord),
      stats,
    };
    this.stateEmitter.fire(this.state);
  }

  private handleEvent(event: PiRpcEvent): void {
    this.eventEmitter.fire(event);
    if (event.type === "agent_start") {
      this.updateState({ busy: true });
    } else if (event.type === "agent_settled") {
      this.updateState({ busy: false });
      void this.refreshState(false).catch(error => {
        this.eventEmitter.fire({ type: "runtime_warning", message: formatError(error) });
      });
    } else if (event.type === "process_exit") {
      this.clientSubscription?.dispose();
      this.clientSubscription = undefined;
      this.client = undefined;
      this.updateState({ connected: false, busy: false });
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

function emptyState(mode: PiAgentMode): PiRuntimeState {
  return {
    connected: false,
    busy: false,
    mode,
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
