import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type * as vscode from "vscode";

const maxDiagnosticBytes = 1024 * 1024;
const maxJsonLineBytes = 5 * 1024 * 1024;
const defaultRequestTimeoutMs = 30_000;
const maxQueuedImages = 5;
const maxQueuedImageCharacters = Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4;

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

export interface PiRpcQueue { readonly steering: readonly string[]; readonly followUp: readonly string[] }
export function parseRpcQueue(value: unknown): PiRpcQueue {
  if (!isRecord(value) || !Array.isArray(value.steering) || !Array.isArray(value.followUp)) throw new Error("Invalid Pi queue state.");
  const messages = [...value.steering, ...value.followUp];
  if (messages.length > 10 || messages.some(message => typeof message !== "string") || messages.reduce((sum, message) => sum + message.length, 0) > 50_000) throw new Error("Pi queue exceeds 10 messages / 50,000 characters.");
  return { steering: [...value.steering], followUp: [...value.followUp] };
}

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcClientOptions {
  readonly executablePath: string;
  readonly executableArgs?: readonly string[];
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
  readonly appendSystemPrompt?: string;
  readonly extensions?: readonly string[];
  readonly sessionPath?: string;
  readonly approveProjectResources?: boolean;
  readonly requestTimeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly unsetEnv?: readonly string[];
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
      if (Buffer.byteLength(this.buffer) > maxJsonLineBytes) throw new Error("Pi RPC emitted a JSON line larger than 5 MiB.");
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
      if (Buffer.byteLength(line) > maxJsonLineBytes) throw new Error("Pi RPC emitted a JSON line larger than 5 MiB.");
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
  private stopPromise: Promise<void> | undefined;

  public constructor(private readonly options: PiRpcClientOptions) {}

  public get isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  public get processId(): number | undefined { return this.process?.pid; }

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
        env: buildPiProcessEnvironment(process.env, this.options.env, this.options.unsetEnv),
        shell: false,
        detached: process.platform !== "win32",
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
      killOwnedProcess(child, "SIGKILL");
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
    if (this.stopPromise) return this.stopPromise;
    const child = this.process;
    if (!child) return;
    this.stopPromise = this.stopChild(child);
    try { await this.stopPromise; } finally { this.stopPromise = undefined; }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.stopping = true;
    this.rejectPending(new Error("Pi RPC client stopped."));
    killOwnedProcess(child, "SIGTERM");
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        killOwnedProcess(child, "SIGKILL");
        resolve();
      }, 1_000);
      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    if (this.process === child) {
      this.process = undefined;
      // SIGKILL may not have produced an exit event yet. Always release runtime
      // settlement waiters; do not lose the event by clearing process first.
      this.emit({ type: "runtime_warning", message: "Pi termination deadline reached; descendant cleanup could not be verified." });
      this.emit({ type: "process_exit", code: child.exitCode, signal: child.signalCode, expected: true });
    }
    child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
  }

  public onEvent(listener: (event: PiRpcEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public async prompt(message: string, images?: readonly PiRpcImage[]): Promise<void> {
    await this.command("prompt", { message, images });
  }

  public async steer(message: string, images?: readonly PiRpcImage[]): Promise<void> { await this.queueCommand("steer", message, images); }
  public async followUp(message: string, images?: readonly PiRpcImage[]): Promise<void> { await this.queueCommand("follow_up", message, images); }
  public async clearQueue(): Promise<PiRpcQueue> { return parseRpcQueue((await this.command("clear_queue")).data); }
  private async queueCommand(type: "steer" | "follow_up", message: string, images?: readonly PiRpcImage[]): Promise<void> {
    if (!message.trim() || message.length > 50_000 || message.trimStart().startsWith("/")) throw new Error("Only bounded plain text, not slash commands, can be queued.");
    if (images && (
      images.length > maxQueuedImages ||
      images.some(image => image.type !== "image" || !image.data || image.data.length > maxQueuedImageCharacters || !image.mimeType || image.mimeType.length > 100)
    )) throw new Error("Queued images exceed the supported attachment limits.");
    await this.command(type, { message, ...(images?.length ? { images } : {}) });
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

  public async exportHtml(outputPath?: string): Promise<string> {
    const data = await this.commandData("export_html", { outputPath });
    if (typeof data.path !== "string") {
      throw new Error("Pi did not return an exported session path.");
    }
    return data.path;
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
        if (response.command !== pending.command || typeof response.success !== "boolean") {
          pending.reject(new Error("Invalid Pi RPC command acknowledgement; acceptance is uncertain."));
        } else if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error ?? `Pi RPC command '${pending.command}' failed.`));
        }
        return;
      }
    }
    if (value.type === "queue_update") {
      try { parseRpcQueue(value); } catch (error) { this.failProcess(asError(error)); return; }
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
    if (!this.stopping) void this.stop();
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

export function buildPiProcessEnvironment(
  base: NodeJS.ProcessEnv,
  overrides?: NodeJS.ProcessEnv,
  unset?: readonly string[],
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...base, ...overrides, NO_COLOR: "1" };
  for (const key of unset ?? []) {
    delete environment[key];
  }
  return environment;
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
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  for (const extension of options.extensions ?? []) {
    args.push("--extension", extension);
  }
  if (options.sessionPath) {
    args.push("--session", options.sessionPath);
  }
  args.push(options.approveProjectResources ? "--approve" : "--no-approve");
  return args;
}

function killOwnedProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch { /* The owned process group already exited. */ }
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
