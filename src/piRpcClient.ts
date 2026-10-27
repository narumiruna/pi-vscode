import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import {
  type BashResultView,
  cleanShellText,
  maxShellOutputCharacters,
  parseBashResultView,
  shellAbortDeadlineMs,
  shellExecutionDeadlineMs,
  validateShellCommand,
} from "./directShell";
import {
  type ErrorCategory,
  type Logger,
  type LogMetadata,
  nullLogger,
  type OperationId,
  safeRpcCommand,
} from "./logging";
import type { PiInvocationOptions } from "./piClient";
import { type PiSessionTree, parseSessionTree, validId } from "./piControl";
import { PiProcessOwner } from "./piProcess";
import { buildPiProcessEnvironment, planPiSpawn } from "./piSpawn";
import { maxRpcJsonLineBytes, RpcFrameTooLargeError } from "./rpcFrame";

export { buildPiProcessEnvironment } from "./piSpawn";

import type * as vscode from "vscode";

const maxDiagnosticBytes = 1024 * 1024;
const defaultRequestTimeoutMs = 30_000;
const maxQueuedImages = 5;
const maxQueuedImageCharacters = Math.ceil((5 * 1024 * 1024) / 3) * 4 + 4;

export type PiRpcEvent = Record<string, unknown> & { readonly type: string };

export interface PiRpcQueue {
  readonly steering: readonly string[];
  readonly followUp: readonly string[];
}
export function parseRpcQueue(value: unknown): PiRpcQueue {
  if (!isRecord(value) || !Array.isArray(value.steering) || !Array.isArray(value.followUp))
    throw new Error("Invalid Pi queue state.");
  const messages = [...value.steering, ...value.followUp];
  if (
    messages.length > 10 ||
    messages.some((message) => typeof message !== "string") ||
    messages.reduce((sum, message) => sum + message.length, 0) > 50_000
  )
    throw new Error("Pi queue exceeds 10 messages / 50,000 characters.");
  return { steering: [...value.steering], followUp: [...value.followUp] };
}

export interface PiRpcImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export interface PiRpcClientOptions extends PiInvocationOptions {
  readonly appendSystemPrompt?: string;
  readonly extensions?: readonly string[];
  readonly sessionPath?: string;
  readonly approveProjectResources?: boolean;
  readonly requestTimeoutMs?: number;
}

export interface PiRpcDiagnostics {
  readonly logger: Logger;
  readonly generation: number;
  readonly operationId?: OperationId;
}

interface PendingRequest {
  readonly command: string;
  readonly timer: NodeJS.Timeout;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error, category?: ErrorCategory) => void;
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
  private bufferedBytes = 0;
  private newlineIndex = -1;
  private failed = false;

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: Buffer): void {
    if (this.failed) return;
    const decoded = this.decoder.write(chunk);
    // The retained prefix has already been scanned. Do not flatten and rescan it for every chunk.
    if (this.newlineIndex < 0) {
      const newline = decoded.indexOf("\n");
      if (newline >= 0) this.newlineIndex = this.buffer.length + newline;
    }
    this.buffer += decoded;
    this.bufferedBytes += Buffer.byteLength(decoded, "utf8");
    this.drain();
    this.assertLineSize(this.bufferedBytes);
  }

  public end(): void {
    if (this.failed) return;
    this.buffer += this.decoder.end();
    this.bufferedBytes = Buffer.byteLength(this.buffer, "utf8");
    if (this.buffer.length > 0) {
      this.assertLineSize(this.bufferedBytes);
      this.onLine(stripCarriageReturn(this.buffer));
      this.buffer = "";
      this.bufferedBytes = 0;
      this.newlineIndex = -1;
    }
  }

  private assertLineSize(bytes: number): void {
    if (bytes <= maxRpcJsonLineBytes) return;
    this.failed = true;
    this.buffer = "";
    this.bufferedBytes = 0;
    this.newlineIndex = -1;
    throw new RpcFrameTooLargeError();
  }

  private drain(): void {
    while (this.newlineIndex >= 0) {
      const line = this.buffer.slice(0, this.newlineIndex);
      const lineBytes = Buffer.byteLength(line, "utf8");
      this.assertLineSize(lineBytes);
      this.buffer = this.buffer.slice(this.newlineIndex + 1);
      this.bufferedBytes -= lineBytes + 1;
      this.newlineIndex = this.buffer.indexOf("\n");
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
  private owner: PiProcessOwner | undefined;
  private exitExpected: boolean | undefined;
  private protocolFailed = false;

  public constructor(
    private readonly options: PiRpcClientOptions,
    private readonly diagnosticContext: PiRpcDiagnostics = { logger: nullLogger, generation: 0 },
  ) {}

  public get isRunning(): boolean {
    return this.process !== undefined && this.process.exitCode === null;
  }

  public get processId(): number | undefined {
    return this.process?.pid;
  }

  public get diagnostics(): string {
    return this.stderr;
  }

  public async start(): Promise<void> {
    if (this.process || this.stopPromise) {
      throw new Error("Pi RPC client is already started or stopping.");
    }

    this.stopping = false;
    this.protocolFailed = false;
    this.exitExpected = undefined;
    this.stderr = "";
    const rpcArguments = [...(this.options.executableArgs ?? []), ...buildRpcArguments(this.options)];
    const env = buildPiProcessEnvironment(process.env, this.options.env, this.options.unsetEnv);
    const plan = planPiSpawn(this.options.executablePath, rpcArguments, { cwd: this.options.cwd, env });
    const child = spawn(plan.command, plan.args, {
      cwd: this.options.cwd,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.process = child;
    const owner = new PiProcessOwner(child);
    this.owner = owner;

    const lineDecoder = new StrictJsonLineDecoder((line) => {
      if (!this.protocolFailed) this.handleLine(line);
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (this.process !== child || this.protocolFailed) return;
      try {
        lineDecoder.push(chunk);
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stdout.on("end", () => {
      if (this.process !== child || this.protocolFailed) return;
      try {
        lineDecoder.end();
      } catch (error) {
        this.failProcess(asError(error));
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (this.process !== child) return;
      this.stderr = appendBounded(this.stderr, chunk.toString("utf8"), maxDiagnosticBytes);
    });
    child.stdin.on("error", (error) => {
      if (this.process !== child) return;
      this.failProcess(new Error(`Pi RPC stdin failed: ${error.message}`), "disconnect");
    });
    child.once("error", (error) => {
      if (this.process !== child) return;
      this.failProcess(
        new Error(`Could not start Pi RPC using '${this.options.executablePath}': ${error.message}`),
        "disconnect",
      );
    });
    child.once("exit", (code, signal) => {
      if (this.process !== child) return;
      this.exitExpected = this.stopping;
      this.rejectPending(
        new Error(
          `Pi RPC exited${code === null ? ` with signal ${signal ?? "unknown"}` : ` with code ${code}`}.${formatDiagnostics(this.stderr)}`,
        ),
      );
      void owner.stop().then((cleanup) => this.finishChild(child, cleanup.warning));
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
    try {
      await this.stopPromise;
    } finally {
      this.stopPromise = undefined;
    }
  }

  private async stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
    this.stopping = true;
    this.rejectPending(new Error("Pi RPC client stopped."));
    const cleanup = await this.owner?.stop();
    this.finishChild(child, cleanup?.warning);
  }

  private finishChild(child: ChildProcessWithoutNullStreams, warning?: string): void {
    if (this.process !== child) return;
    if (warning) this.emit({ type: "runtime_warning", warningCode: "cleanup-unverified", message: warning });
    this.process = undefined;
    this.owner = undefined;
    this.emit({
      type: "process_exit",
      code: child.exitCode,
      signal: child.signalCode,
      expected: this.exitExpected ?? this.stopping,
    });
  }

  public onEvent(listener: (event: PiRpcEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public async prompt(message: string, images?: readonly PiRpcImage[]): Promise<string | undefined> {
    const data = await this.commandData("prompt", { message, images });
    return typeof data.disposition === "string" ? data.disposition : undefined;
  }

  public async steer(message: string, images?: readonly PiRpcImage[]): Promise<void> {
    await this.queueCommand("steer", message, images);
  }
  public async followUp(message: string, images?: readonly PiRpcImage[]): Promise<void> {
    await this.queueCommand("follow_up", message, images);
  }
  public async clearQueue(): Promise<PiRpcQueue> {
    return parseRpcQueue((await this.command("clear_queue")).data);
  }
  private async queueCommand(
    type: "steer" | "follow_up",
    message: string,
    images?: readonly PiRpcImage[],
  ): Promise<void> {
    if (!message.trim() || message.length > 50_000 || message.trimStart().startsWith("/"))
      throw new Error("Only bounded plain text, not slash commands, can be queued.");
    if (
      images &&
      (images.length > maxQueuedImages ||
        images.some(
          (image) =>
            image.type !== "image" ||
            !image.data ||
            image.data.length > maxQueuedImageCharacters ||
            !image.mimeType ||
            image.mimeType.length > 100,
        ))
    )
      throw new Error("Queued images exceed the supported attachment limits.");
    await this.command(type, { message, ...(images?.length ? { images } : {}) });
  }

  public async abort(): Promise<void> {
    if (this.isRunning) {
      await this.command("abort");
    }
  }

  public async bash(
    command: string,
    excludeFromContext: boolean,
    onUpdate: (result: BashResultView) => void,
  ): Promise<BashResultView> {
    validateShellCommand(command);
    const id = `vscode_shell_${++this.requestId}`;
    let rawOutput = "";
    let truncated = false;
    const subscription = this.onEvent((event) => {
      if (event.type !== "bash_execution_update" || event.id !== id) return;
      if (typeof event.delta !== "string") {
        this.failProcess(new Error("Invalid correlated shell output; execution is uncertain."));
        return;
      }
      truncated ||= rawOutput.length + event.delta.length > maxShellOutputCharacters;
      rawOutput = (rawOutput + event.delta).slice(-maxShellOutputCharacters);
      onUpdate({ output: cleanShellText(rawOutput), cancelled: false, truncated });
    });
    try {
      const response = await this.command(
        "bash",
        { command, excludeFromContext },
        { id, timeoutMs: shellExecutionDeadlineMs + 2 * shellAbortDeadlineMs },
      );
      // The authoritative final output replaces streaming data. Never append it.
      const result = parseBashResultView(response.data);
      onUpdate(result);
      return result;
    } finally {
      subscription.dispose();
    }
  }

  public async abortBash(): Promise<void> {
    await this.command("abort_bash", {}, { timeoutMs: shellAbortDeadlineMs });
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
    return Array.isArray(data.levels) ? data.levels.filter((level) => typeof level === "string") : [];
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

  /** These public Pi setters also request persistence to GLOBAL Pi settings. */
  public async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<void> {
    if (mode !== "all" && mode !== "one-at-a-time") throw new Error("Invalid queue mode.");
    await this.command("set_steering_mode", { mode });
  }

  public async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<void> {
    if (mode !== "all" && mode !== "one-at-a-time") throw new Error("Invalid queue mode.");
    await this.command("set_follow_up_mode", { mode });
  }

  public async setAutoCompaction(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid compaction value.");
    await this.command("set_auto_compaction", { enabled });
  }

  public async setAutoRetry(enabled: boolean): Promise<void> {
    if (typeof enabled !== "boolean") throw new Error("Invalid retry value.");
    await this.command("set_auto_retry", { enabled });
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

  public async getTree(): Promise<PiSessionTree> {
    return parseSessionTree(await this.commandData("get_tree"));
  }

  public async getForkMessages(): Promise<readonly { entryId: string; text: string }[]> {
    const data = await this.commandData("get_fork_messages");
    if (!Array.isArray(data.messages) || data.messages.length > 2_000)
      throw new Error("Invalid or oversized Pi fork-message list.");
    return data.messages.map((item: unknown) => {
      if (!isRecord(item) || !validId(item.entryId) || typeof item.text !== "string" || item.text.length > 50_000)
        throw new Error("Invalid Pi fork message.");
      return { entryId: item.entryId, text: item.text };
    });
  }

  public async fork(entryId: string): Promise<{ cancelled: boolean; text?: string }> {
    if (!validId(entryId)) throw new Error("Invalid fork entry ID.");
    const data = await this.commandData("fork", { entryId });
    if (typeof data.cancelled !== "boolean" || (data.text !== undefined && typeof data.text !== "string"))
      throw new Error("Invalid Pi fork acknowledgement; outcome is uncertain.");
    if (typeof data.text === "string" && data.text.length > 50_000)
      throw new Error("Fork draft exceeds 50,000 characters; outcome is uncertain.");
    return { cancelled: data.cancelled, text: data.text as string | undefined };
  }

  public async clone(): Promise<{ cancelled: boolean }> {
    const data = await this.commandData("clone");
    if (typeof data.cancelled !== "boolean") throw new Error("Invalid Pi clone acknowledgement; outcome is uncertain.");
    return { cancelled: data.cancelled };
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

  private command(
    type: string,
    fields: Record<string, unknown> = {},
    options: { readonly id?: string; readonly timeoutMs?: number } = {},
  ): Promise<PiRpcResponse> {
    const startedAt = Date.now();
    let operationId = this.diagnosticContext.operationId;
    try {
      if (this.diagnosticContext.logger !== nullLogger) operationId ??= this.diagnosticContext.logger.operation();
    } catch {
      // An unavailable logger must not prevent command submission.
    }
    const metadata = {
      command: safeRpcCommand(type),
      generation: this.diagnosticContext.generation,
      operationId,
    };
    this.logCommand({ ...metadata, result: "started" });
    const failed = (category: ErrorCategory) =>
      this.logCommand({ ...metadata, result: "failed", category, durationMs: Date.now() - startedAt });
    const child = this.process;
    if (!child || child.exitCode !== null || child.stdin.destroyed || !child.stdin.writable) {
      failed("disconnect");
      return Promise.reject(new Error(`Pi RPC is not running.${formatDiagnostics(this.stderr)}`));
    }

    const id = options.id ?? `vscode_${++this.requestId}`;
    const request = { ...fields, id, type };
    return new Promise((resolve, reject) => {
      const rejectCommand = (error: Error, category: ErrorCategory = "unknown") => {
        failed(category);
        reject(error);
      };
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          rejectCommand(
            new Error(`Timed out waiting for Pi RPC command '${type}'.${formatDiagnostics(this.stderr)}`),
            "timeout",
          );
        },
        options.timeoutMs ?? this.options.requestTimeoutMs ?? defaultRequestTimeoutMs,
      );
      this.pending.set(id, {
        command: type,
        timer,
        resolve: (response) => {
          this.logCommand({ ...metadata, result: "completed", durationMs: Date.now() - startedAt });
          resolve(response);
        },
        reject: rejectCommand,
      });
      try {
        this.writeRecord(request);
      } catch (error) {
        const pending = this.pending.get(id);
        this.pending.delete(id);
        clearTimeout(timer);
        pending?.reject(asError(error), "disconnect");
      }
    });
  }

  private logCommand(metadata: LogMetadata): void {
    if (this.diagnosticContext.logger === nullLogger) return;
    try {
      this.diagnosticContext.logger.record(metadata.result === "failed" ? "error" : "debug", "rpc-command", metadata);
    } catch {
      // Diagnostics must not change command results or cleanup.
    }
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
          pending.reject(
            new Error("Invalid Pi RPC command acknowledgement; acceptance is uncertain."),
            "invalid-frame",
          );
        } else if (response.success) {
          pending.resolve(response);
        } else {
          pending.reject(new Error(response.error ?? `Pi RPC command '${pending.command}' failed.`));
        }
        return;
      }
    }
    if (value.type === "queue_update") {
      try {
        parseRpcQueue(value);
      } catch (error) {
        this.failProcess(asError(error));
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

  private failProcess(error: Error, category: "invalid-frame" | "disconnect" = "invalid-frame"): void {
    if (this.protocolFailed) return;
    this.protocolFailed = true;
    const oversized = error instanceof RpcFrameTooLargeError;
    this.rejectPending(error, oversized ? "frame-too-large" : category);
    this.emit({ type: "protocol_error", message: error.message, ...(oversized ? { error } : {}) });
    if (!this.stopping) void this.stop();
  }

  private rejectPending(
    error: Error,
    category: "invalid-frame" | "frame-too-large" | "disconnect" = "disconnect",
  ): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error, category);
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
