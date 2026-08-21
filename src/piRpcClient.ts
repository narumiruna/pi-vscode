import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type * as vscode from "vscode";

const maxDiagnosticBytes = 1024 * 1024;
const maxJsonLineBytes = 5 * 1024 * 1024;
const defaultRequestTimeoutMs = 30_000;

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

export interface PiRpcClientOptions {
  readonly executablePath: string;
  readonly executableArgs?: readonly string[];
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly tools?: readonly string[];
  readonly appendSystemPrompt?: string;
  readonly sessionPath?: string;
  readonly approveProjectResources?: boolean;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

interface PendingRequest {
  readonly command: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

interface PiRpcResponse {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export class StrictJsonLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: Buffer): void {
    this.buffer += this.decoder.write(chunk);
    this.drain();
    if (Buffer.byteLength(this.buffer, "utf8") > maxJsonLineBytes) {
      throw new Error("Pi RPC emitted a JSON line larger than 5 MiB.");
    }
  }

  public end(): void {
    this.buffer += this.decoder.end();
    if (this.buffer.length > 0) {
      this.onLine(stripCarriageReturn(this.buffer));
      this.buffer = "";
    }
  }

  private drain(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.onLine(stripCarriageReturn(line));
    }
  }
}

export class PiRpcClient {
  private process: ChildProcessWithoutNullStreams | undefined;
  private readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private requestId = 0;
  private stderr = "";
  private stopping = false;

  public constructor(private readonly options: PiRpcClientOptions) {}

  public get isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  public get diagnostics(): string {
    return this.stderr;
  }

  public async start(): Promise<void> {
    if (this.process) {
      throw new Error("Pi RPC client is already started.");
    }

    this.stopping = false;
    this.stderr = "";
    const child = spawn(
      this.options.executablePath,
      [...(this.options.executableArgs ?? []), ...buildRpcArguments(this.options)],
      {
        cwd: this.options.cwd,
        env: { ...process.env, ...this.options.env, NO_COLOR: "1" },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.process = child;

    const lineDecoder = new StrictJsonLineDecoder(line => this.handleLine(line));
    child.stdout.on("data", (chunk: Buffer) => {
      try {
        lineDecoder.push(chunk);
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stdout.on("end", () => {
      try {
        lineDecoder.end();
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = appendBounded(this.stderr, chunk.toString("utf8"), maxDiagnosticBytes);
    });
    child.stdin.on("error", error => {
      this.failProcess(new Error(`Pi RPC stdin failed: ${error.message}`));
    });
    child.once("error", error => {
      this.failProcess(new Error(`Could not start Pi RPC using '${this.options.executablePath}': ${error.message}`));
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) {
        return;
      }
      this.process = undefined;
      const error = new Error(
        `Pi RPC exited${code === null ? ` with signal ${signal ?? "unknown"}` : ` with code ${code}`}.${formatDiagnostics(this.stderr)}`,
      );
      this.rejectPending(error);
      this.emit({ type: "process_exit", code, signal, expected: this.stopping });
    });

    try {
      await this.command("get_state");
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  public async stop(): Promise<void> {
    const child = this.process;
    if (!child) {
      return;
    }
    this.stopping = true;
    this.rejectPending(new Error("Pi RPC client stopped."));
    child.kill("SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.process === child) {
      this.process = undefined;
    }
  }

  public onEvent(listener: (event: PiRpcEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public async prompt(message: string): Promise<void> {
    await this.command("prompt", { message });
  }

  public async abort(): Promise<void> {
    if (this.isRunning) {
      await this.command("abort");
    }
  }

  public async newSession(): Promise<unknown> {
    return this.commandData("new_session");
  }

  public async getState(): Promise<Record<string, unknown>> {
    return this.commandData("get_state");
  }

  public async getMessages(): Promise<unknown[]> {
    const data = await this.commandData("get_messages");
    return Array.isArray(data.messages) ? data.messages : [];
  }

  public async getAvailableModels(): Promise<unknown[]> {
    const data = await this.commandData("get_available_models");
    return Array.isArray(data.models) ? data.models : [];
  }

  public async getAvailableThinkingLevels(): Promise<string[]> {
    const data = await this.commandData("get_available_thinking_levels");
    return Array.isArray(data.levels) ? data.levels.filter(level => typeof level === "string") : [];
  }

  public async getSessionStats(): Promise<Record<string, unknown>> {
    return this.commandData("get_session_stats");
  }

  public async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.commandData("set_model", { provider, modelId });
  }

  public async setThinkingLevel(level: string): Promise<void> {
    await this.command("set_thinking_level", { level });
  }

  public async setSessionName(name: string): Promise<void> {
    await this.command("set_session_name", { name });
  }

  public async compact(customInstructions?: string): Promise<unknown> {
    return this.commandData("compact", { customInstructions });
  }

  public async switchSession(sessionPath: string): Promise<unknown> {
    return this.commandData("switch_session", { sessionPath });
  }

  public async getCommands(): Promise<unknown[]> {
    const data = await this.commandData("get_commands");
    return Array.isArray(data.commands) ? data.commands : [];
  }

  public sendExtensionUiResponse(id: string, fields: Record<string, unknown>): void {
    this.writeRecord({ type: "extension_ui_response", id, ...fields });
  }

  private async commandData(type: string, fields: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const response = await this.command(type, fields);
    return isRecord(response.data) ? response.data : {};
  }

  private command(type: string, fields: Record<string, unknown> = {}): Promise<PiRpcResponse> {
    const child = this.process;
    if (!child || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
      return Promise.reject(new Error(`Pi RPC is not running.${formatDiagnostics(this.stderr)}`));
    }

    const id = `vscode_${++this.requestId}`;
    const request = { ...fields, id, type };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for Pi RPC command '${type}'.${formatDiagnostics(this.stderr)}`));
      }, this.options.requestTimeoutMs ?? defaultRequestTimeoutMs);
      this.pending.set(id, { command: type, timer, resolve, reject });
      try {
        this.writeRecord(request);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(timer);
        pending?.reject(asError(error));
      }
    });
  }

  private writeRecord(record: Record<string, unknown>): void {
    const child = this.process;
    if (!child || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
      throw new Error(`Pi RPC is not running.${formatDiagnostics(this.stderr)}`);
    }
    child.stdin.write(`${JSON.stringify(record)}\n`);
  }

  private handleLine(line: string): void {
    if (!line) {
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.emit({ type: "protocol_error", message: "Pi RPC emitted invalid JSON.", line: line.slice(0, 1_000) });
      return;
    }
    if (!isRecord(value) || typeof value.type !== "string") {
      this.emit({ type: "protocol_error", message: "Pi RPC emitted an invalid record." });
      return;
    }

    if (value.type === "response" && typeof value.id === "string") {
      const pending = this.pending.get(value.id);
      if (pending) {
        this.pending.delete(value.id);
        clearTimeout(pending.timer);
        const response = value as unknown as PiRpcResponse;
        if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error ?? `Pi RPC command '${pending.command}' failed.`));
        }
        return;
      }
    }
    this.emit(value as PiRpcEvent);
  }

  private emit(event: PiRpcEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private failProcess(error: Error): void {
    this.rejectPending(error);
    this.emit({ type: "protocol_error", message: error.message });
    this.process?.kill();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildRpcArguments(options: PiRpcClientOptions): string[] {
  const args = ["--mode", "rpc"];
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinkingLevel) {
    args.push("--thinking", options.thinkingLevel);
  }
  if (options.tools) {
    args.push("--tools", options.tools.join(","));
  }
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  }
  if (options.approveProjectResources) {
    args.push("--approve");
  }
  return args;
}

function appendBounded(current: string, next: string, maxBytes: number): string {
  const combined = current + next;
  const bytes = Buffer.from(combined, "utf8");
  return bytes.length <= maxBytes ? combined : bytes.subarray(bytes.length - maxBytes).toString("utf8");
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function formatDiagnostics(stderr: string): string {
  const details = stderr.trim();
  return details ? ` Stderr: ${details.slice(-4_000)}` : "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
