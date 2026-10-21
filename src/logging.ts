import type * as vscode from "vscode";

export type LogLevel = "info" | "warn" | "error" | "debug" | "trace";
export type OperationId = `op-${number}`;

const events = [
  "activation",
  "deletion",
  "trash",
  "permanent-confirmation",
  "storage-cleanup",
  "recovery-startup",
  "startup",
  "stop",
  "restart",
  "restore-fallback",
  "process-exit",
  "cleanup",
  "runtime-warning",
  "rpc-command",
  "protocol-error",
  "request",
  "history-load",
  "history-refresh",
  "history-compaction",
  "history-stale",
  "cache-save",
  "sidebar-action",
  "inline-completion",
  "warnings-suppressed",
] as const;
export type LogEvent = (typeof events)[number];
const results = [
  "started",
  "ready",
  "completed",
  "failed",
  "cancelled",
  "uncertain",
  "retained",
  "deleted",
  "accepted",
  "unsupported",
  "discarded",
  "verified",
  "unverified",
] as const;
const categories = [
  "unknown",
  "timeout",
  "disconnect",
  "invalid-frame",
  "invalid-response",
  "invocation",
  "cancelled",
  "permission",
  "io",
  "unsupported",
  "storage",
  "refresh",
] as const;
export type ErrorCategory = (typeof categories)[number];
const warningCodes = [
  "cleanup-unverified",
  "deleted-cleanup",
  "session-replaced",
  "state-refresh",
  "queue-uncertain",
  "queue-delivered",
  "protocol-error",
  "unknown",
] as const;
const commands = [
  "prompt",
  "steer",
  "follow_up",
  "clear_queue",
  "abort",
  "bash",
  "abort_bash",
  "new_session",
  "get_state",
  "get_messages",
  "get_available_models",
  "get_available_thinking_levels",
  "get_session_stats",
  "set_model",
  "set_thinking_level",
  "set_steering_mode",
  "set_follow_up_mode",
  "set_auto_compaction",
  "set_auto_retry",
  "set_session_name",
  "compact",
  "switch_session",
  "get_tree",
  "get_fork_messages",
  "fork",
  "clone",
  "export_html",
  "get_commands",
] as const;
const fsCodes = ["EACCES", "EPERM", "EIO", "ENOENT", "ENOSPC", "EROFS", "EBUSY", "ENOTSUP", "EOPNOTSUPP"] as const;

/** Only projected metadata is accepted. Never pass errors, events, options, or user content. */
export interface LogMetadata {
  readonly operationId?: OperationId;
  readonly generation?: number;
  readonly durationMs?: number;
  readonly result?: (typeof results)[number];
  readonly category?: ErrorCategory;
  readonly command?: string;
  readonly warningCode?: unknown;
  readonly errorCode?: string;
  readonly exitCode?: number | null;
  readonly signal?: unknown;
  readonly expected?: boolean;
  readonly retryAvailable?: boolean;
  readonly operationCompleted?: boolean;
  readonly stage?: "migration" | "ownership" | "bridge" | "registration";
  readonly cleanupVerified?: boolean;
  readonly count?: number;
  readonly extensionVersion?: string;
  readonly vscodeVersion?: string;
  readonly platform?: string;
  readonly host?: "local" | "remote";
}
export interface Logger {
  operation(): OperationId;
  record(level: LogLevel, event: LogEvent, metadata?: LogMetadata): void;
  warning(code: unknown, generation: number, metadata?: LogMetadata): void;
  endGeneration(generation: number): void;
  show(): void;
}

export const nullLogger: Logger = {
  operation: () => "op-0",
  record() {},
  warning() {},
  endGeneration() {},
  show() {},
};

/** Reads only an allowlisted filesystem code, never message/cause/stack. */
export function safeErrorCode(error: unknown): string | undefined {
  try {
    const code = (error as { code?: unknown } | null)?.code;
    return typeof code === "string" && fsCodes.includes(code as (typeof fsCodes)[number]) ? code : undefined;
  } catch {
    return undefined;
  }
}
export function safeErrorCategory(error: unknown): ErrorCategory {
  const code = safeErrorCode(error);
  if (code === "EACCES" || code === "EPERM") return "permission";
  if (code === "ENOTSUP" || code === "EOPNOTSUPP") return "unsupported";
  return code ? "io" : "unknown";
}

/** VS Code owns storage. The only retained records here are bounded warning counters. */
export class PiLogger implements Logger, vscode.Disposable {
  private nextId = 0;
  private disposed = false;
  private readonly warnings = new Map<number, Map<string, { at: number; suppressed: number }>>();

  public constructor(
    private readonly channel: vscode.LogOutputChannel | undefined,
    private readonly now: () => number = Date.now,
  ) {}

  public operation(): OperationId {
    this.nextId = (this.nextId % Number.MAX_SAFE_INTEGER) + 1;
    return `op-${this.nextId}`;
  }

  public record(level: LogLevel, event: LogEvent, metadata: LogMetadata = {}): void {
    if (this.disposed || !this.channel) return;
    try {
      if (!events.includes(event)) return;
      const fields: Record<string, string | number | boolean | null> = {};
      const enumeration = (key: keyof LogMetadata, allowed: readonly string[]) => {
        const value = metadata[key];
        if (typeof value === "string" && allowed.includes(value)) fields[key] = value;
      };
      enumeration("result", results);
      enumeration("category", categories);
      enumeration("errorCode", fsCodes);
      enumeration("platform", ["linux", "darwin", "win32", "freebsd", "openbsd", "aix", "sunos"]);
      enumeration("host", ["local", "remote"]);
      enumeration("stage", ["migration", "ownership", "bridge", "registration"]);
      enumeration("signal", ["SIGTERM", "SIGKILL", "SIGINT", "SIGHUP", "SIGABRT", "SIGSEGV", "SIGPIPE"]);
      if (metadata.command !== undefined) fields.command = safeRpcCommand(metadata.command);
      if (metadata.warningCode !== undefined) fields.warningCode = knownWarning(metadata.warningCode);
      if (typeof metadata.operationId === "string" && /^op-[0-9]{1,16}$/.test(metadata.operationId))
        fields.operationId = metadata.operationId;
      for (const key of ["generation", "durationMs", "count"] as const) {
        const value = metadata[key];
        if (typeof value === "number" && Number.isFinite(value) && value >= 0)
          fields[key] = Math.min(Math.floor(value), Number.MAX_SAFE_INTEGER);
      }
      if (
        metadata.exitCode === null ||
        (typeof metadata.exitCode === "number" &&
          Number.isSafeInteger(metadata.exitCode) &&
          Math.abs(metadata.exitCode) <= 2_147_483_647)
      )
        fields.exitCode = metadata.exitCode;
      for (const key of ["expected", "retryAvailable", "cleanupVerified", "operationCompleted"] as const)
        if (typeof metadata[key] === "boolean") fields[key] = metadata[key];
      for (const key of ["extensionVersion", "vscodeVersion"] as const) {
        const value = metadata[key];
        if (typeof value === "string" && /^\d{1,5}\.\d{1,5}\.\d{1,5}(?:-(?:insider|insiders|dev))?$/.test(value))
          fields[key] = value;
      }
      // The projection is much smaller than the cap. Keep a final bound for future fields.
      const record = `${event} ${JSON.stringify(fields)}`.replace(/[\p{Cc}\p{Cf}]/gu, "");
      this.channel[level](record.length <= 8_000 ? record : `${record.slice(0, 7_988)} [truncated]`);
    } catch {
      // Diagnostics must not change an operation result, including during disposal.
    }
  }

  public warning(code: unknown, generation: number, metadata: LogMetadata = {}): void {
    if (this.disposed || !Number.isSafeInteger(generation) || generation < 0) return;
    const key = knownWarning(code);
    let entries = this.warnings.get(generation);
    if (!entries) {
      // Only current and outgoing generations can coexist during bounded cleanup.
      const oldest = this.warnings.keys().next().value;
      if (this.warnings.size >= 2 && oldest !== undefined) this.endGeneration(oldest);
      entries = new Map();
      this.warnings.set(generation, entries);
    }
    const previous = entries.get(key);
    const now = this.now();
    if (previous && now - previous.at < 5_000) {
      previous.suppressed = Math.min(previous.suppressed + 1, Number.MAX_SAFE_INTEGER);
      return;
    }
    if (previous?.suppressed)
      this.record("warn", "warnings-suppressed", { generation, warningCode: key, count: previous.suppressed });
    entries.set(key, { at: now, suppressed: 0 });
    this.record("warn", "runtime-warning", { ...metadata, generation, warningCode: key });
  }

  public endGeneration(generation: number): void {
    for (const [warningCode, value] of this.warnings.get(generation) ?? []) {
      if (value.suppressed)
        this.record("warn", "warnings-suppressed", { generation, warningCode, count: value.suppressed });
    }
    this.warnings.delete(generation);
  }

  public show(): void {
    if (this.disposed) return;
    try {
      this.channel?.show(true);
    } catch {
      /* Channel unavailable. */
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    for (const generation of this.warnings.keys()) this.endGeneration(generation);
    this.disposed = true;
    try {
      this.channel?.dispose();
    } catch {
      /* Already disposed by the host. */
    }
  }
}

export function safeRpcCommand(command: unknown): (typeof commands)[number] | "unknown" {
  return typeof command === "string" && commands.includes(command as (typeof commands)[number])
    ? (command as (typeof commands)[number])
    : "unknown";
}

function knownWarning(code: unknown): (typeof warningCodes)[number] {
  return typeof code === "string" && warningCodes.includes(code as (typeof warningCodes)[number])
    ? (code as (typeof warningCodes)[number])
    : "unknown";
}
