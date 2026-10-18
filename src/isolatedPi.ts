import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { PiInvocationOptions } from "./piClient";
import { PiProcessOwner } from "./piProcess";
import { buildPiProcessEnvironment, planPiSpawn } from "./piSpawn";

export const isolatedProtocol = "pi-vscode-isolated-v1";
const maxFrameBytes = 16_384;
const maxOutputBytes = 256 * 1024;
export type IsolatedPiAuthType = "api_key" | "oauth";
export interface IsolatedPiProviderAuthSummary {
  readonly id: string;
  readonly methods: readonly IsolatedPiAuthType[];
}
/** Helper protocol projection, not the pi-ai AuthPrompt interface. */
export interface IsolatedPiAuthPrompt {
  readonly id: number;
  readonly kind: "text" | "secret" | "manual_code" | "select";
  readonly options?: readonly { id: string; label: string }[];
}
export interface IsolatedPiAuthInteraction {
  prompt(value: IsolatedPiAuthPrompt, signal: AbortSignal): Promise<string | undefined>;
  openUrl(url: string, code: string | undefined, signal: AbortSignal): Promise<boolean>;
}
export type IsolatedPiRequest =
  | { operation: "discover"; agentDir: string }
  | { operation: "login"; agentDir: string; provider: string; method: IsolatedPiAuthType }
  | { operation: "logout"; agentDir: string; provider: string }
  | { operation: "export" | "import"; cwd: string; input: string; output: string; leaf?: string | null };
export interface IsolatedPiResult {
  readonly status: "providers" | "changed" | "complete" | "changed-refresh-failed";
  readonly providers?: readonly IsolatedPiProviderAuthSummary[];
  readonly cleanupWarning?: string;
}
/** Host helper failure, not an SDK ModelRuntime or AgentSessionRuntime exception. */
export class IsolatedPiHelperError extends Error {
  public constructor(
    public readonly category: "unsupported" | "cancelled" | "failed" | "uncertain",
    public readonly cleanupUnverified = false,
  ) {
    super(
      category === "unsupported"
        ? "This Pi installation does not support the isolated Pi 1.3.0 helper. No operation was retried."
        : category === "cancelled"
          ? "The isolated Pi operation was cancelled."
          : category === "uncertain"
            ? "The Pi operation did not finish with a verified result. Check the Pi store or retained import before retrying."
            : "The isolated Pi operation failed. Provider output was omitted to protect credentials.",
    );
    if (cleanupUnverified) this.message += " Process descendant cleanup could not be verified.";
  }
}

export function authUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > 4_096 || /[\s\\]/u.test(value) || hasControl(value))
    throw new IsolatedPiHelperError("failed");
  const url = new URL(value);
  if (url.protocol !== "https:" || !url.hostname || url.username || url.password || url.hash)
    throw new IsolatedPiHelperError("failed");
  return value; // Preserve the complete URL. Do not rebuild a remote redirect URI.
}

export function buildIsolatedPiHelperArguments(helperPath: string): string[] {
  return [
    "--mode",
    "rpc",
    "--offline",
    "--no-approve",
    "--no-extensions",
    "--no-mcp",
    "--no-tools",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-themes",
    "--no-session",
    "--extension",
    helperPath,
  ];
}

/** Only OS/runtime lookup and proxy settings cross into the disposable bootstrap environment. */
export function buildIsolatedPiHelperEnvironment(
  directory: string,
  cwd: string,
  base = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(base)) {
    if (
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|LANG|LC_ALL|PI_PACKAGE_DIR|HTTPS?_PROXY|NO_PROXY)$/i.test(
        key,
      )
    )
      environment[key] = value;
  }
  const env = buildPiProcessEnvironment(environment);
  if (process.platform !== "win32" && env.PATH)
    env.PATH = env.PATH.split(path.delimiter)
      .filter(Boolean)
      .map((part) => path.resolve(cwd, part))
      .join(path.delimiter);
  return {
    ...env,
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: directory,
    XDG_CONFIG_HOME: directory,
    PI_CODING_AGENT_DIR: path.join(directory, "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
}

export async function runIsolatedPiHelper(
  invocation: PiInvocationOptions,
  helperPath: string,
  request: IsolatedPiRequest,
  interaction?: IsolatedPiAuthInteraction,
  signal?: AbortSignal,
): Promise<IsolatedPiResult> {
  if (signal?.aborted) throw new IsolatedPiHelperError("cancelled");
  const directory = await mkdtemp(path.join(tmpdir(), "pi-isolated-"));
  try {
    const env = buildIsolatedPiHelperEnvironment(directory, invocation.cwd);
    const executable =
      /[/\\]/.test(invocation.executablePath) && !path.isAbsolute(invocation.executablePath)
        ? path.resolve(invocation.cwd, invocation.executablePath)
        : invocation.executablePath;
    const plan = planPiSpawn(executable, buildIsolatedPiHelperArguments(helperPath), { cwd: invocation.cwd, env });
    const child = spawn(plan.command, plan.args, {
      cwd: directory,
      env,
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const owner = new PiProcessOwner(child);
    return await new Promise<IsolatedPiResult>((resolve, reject) => {
      let ready = false;
      let sent = false;
      let settled = false;
      let result: IsolatedPiResult | undefined;
      let buffer = Buffer.alloc(0);
      let bytes = 0;
      let prompt: { id: number; controller: AbortController } | undefined;
      let sequence = 0;
      let interactions = 0;
      let pending = Promise.resolve();
      const lifetime = new AbortController();
      const startupTimer = setTimeout(() => fail(new IsolatedPiHelperError("unsupported")), 15_000);
      const timer = setTimeout(
        () => fail(new IsolatedPiHelperError(sent && request.operation !== "discover" ? "uncertain" : "failed")),
        300_000,
      );
      const clear = (): void => {
        clearTimeout(timer);
        clearTimeout(startupTimer);
        lifetime.abort();
        signal?.removeEventListener("abort", abort);
        prompt?.controller.abort();
        prompt = undefined;
      };
      const fail = (error: IsolatedPiHelperError): void => {
        if (settled) return;
        settled = true;
        clear();
        void owner
          .stop()
          .then((cleanup) => reject(new IsolatedPiHelperError(error.category, Boolean(cleanup.warning))));
      };
      const abort = (): void =>
        fail(new IsolatedPiHelperError(sent && request.operation !== "discover" ? "uncertain" : "cancelled"));
      const send = (fields: Record<string, unknown>): void => {
        if (settled) return;
        const line = JSON.stringify({ protocol: isolatedProtocol, ...fields });
        if (Buffer.byteLength(line) > maxFrameBytes) throw new IsolatedPiHelperError("failed");
        child.stdin.write(`${line}\n`);
      };
      const receive = (value: unknown): void => {
        if (!record(value) || value.protocol !== isolatedProtocol || typeof value.type !== "string")
          throw new IsolatedPiHelperError("unsupported");
        if (value.type === "unsupported") throw new IsolatedPiHelperError("unsupported");
        if (value.type === "ready" && !ready && value.version === "1.3.0") {
          ready = true;
          clearTimeout(startupTimer);
          send({ type: "request", ...request });
          sent = true;
          return;
        }
        if (!ready || result) throw new IsolatedPiHelperError("failed");
        if (value.type === "providers" && request.operation === "discover") {
          result = { status: "providers", providers: parseProviderAuthSummaries(value.providers) };
        } else if (value.type === "changed" && (request.operation === "login" || request.operation === "logout")) {
          if (prompt) throw new IsolatedPiHelperError("failed");
          result = { status: "changed" };
        } else if (value.type === "complete" && (request.operation === "import" || request.operation === "export")) {
          result = { status: "complete" };
        } else if (value.type === "failure") {
          if (
            value.category === "changed-refresh-failed" &&
            (request.operation === "login" || request.operation === "logout")
          )
            result = { status: "changed-refresh-failed" };
          else throw new IsolatedPiHelperError(value.category === "cancelled" ? "cancelled" : "failed");
        } else if (value.type === "dismiss" && prompt && value.id === prompt.id) {
          prompt.controller.abort();
          prompt = undefined;
        } else if (request.operation === "login" && interaction && value.type === "prompt") {
          if (prompt || sequence >= 100 || !Number.isSafeInteger(value.id) || value.id !== ++sequence)
            throw new IsolatedPiHelperError("failed");
          const parsed = parseAuthPrompt(value);
          const active = { id: parsed.id, controller: new AbortController() };
          prompt = active;
          pending = pending
            .then(async () => {
              if (settled || active.controller.signal.aborted) return;
              let answer = await interaction.prompt(parsed, active.controller.signal);
              if (settled || active.controller.signal.aborted || prompt !== active) return;
              prompt = undefined;
              if (answer === undefined) throw new IsolatedPiHelperError("cancelled");
              if (
                answer.length > 8_192 ||
                (parsed.kind === "select" && !parsed.options?.some((option) => option.id === answer))
              )
                throw new IsolatedPiHelperError("failed");
              send({ type: "answer", id: parsed.id, value: answer });
              answer = undefined;
            })
            .catch(() => fail(new IsolatedPiHelperError("cancelled")));
        } else if (request.operation === "login" && interaction && (value.type === "url" || value.type === "device")) {
          if (++interactions > 20) throw new IsolatedPiHelperError("failed");
          const url = authUrl(value.url);
          const code = value.type === "device" ? boundedString(value.code, 256) : undefined;
          pending = pending
            .then(async () => {
              if (!settled && !(await interaction.openUrl(url, code, lifetime.signal)))
                throw new IsolatedPiHelperError("cancelled");
            })
            .catch(() => fail(new IsolatedPiHelperError("cancelled")));
        } else throw new IsolatedPiHelperError("failed");
      };
      child.stdout.on("data", (chunk: Buffer) => {
        if (settled) return;
        bytes += chunk.length;
        if (bytes > maxOutputBytes) return fail(new IsolatedPiHelperError("failed"));
        buffer = Buffer.concat([buffer, chunk]);
        try {
          let newline = buffer.indexOf(10);
          while (newline >= 0) {
            if (newline > maxFrameBytes) throw new IsolatedPiHelperError("failed");
            const line = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, newline));
            buffer = buffer.subarray(newline + 1);
            receive(JSON.parse(line));
            if (settled) return;
            newline = buffer.indexOf(10);
          }
          if (buffer.length > maxFrameBytes) throw new IsolatedPiHelperError("failed");
        } catch (error) {
          fail(error instanceof IsolatedPiHelperError ? error : new IsolatedPiHelperError("failed"));
        }
      });
      // Drain and bound diagnostics, but never retain or report arbitrary provider/CLI text.
      child.stderr.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > maxOutputBytes) fail(new IsolatedPiHelperError("failed"));
      });
      child.stdin.on("error", () => fail(new IsolatedPiHelperError(sent ? "uncertain" : "unsupported")));
      child.once("error", () => fail(new IsolatedPiHelperError("unsupported")));
      child.once("exit", (code) => {
        void owner.stop().then((cleanup) => {
          if (settled) return;
          settled = true;
          clear();
          if (code !== 0 || !result || buffer.length || !cleanup.pipesClosed)
            reject(
              new IsolatedPiHelperError(
                sent && request.operation !== "discover" ? "uncertain" : "unsupported",
                Boolean(cleanup.warning),
              ),
            );
          else resolve({ ...result, cleanupWarning: cleanup.warning });
        });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function parseProviderAuthSummaries(value: unknown): IsolatedPiProviderAuthSummary[] {
  if (!Array.isArray(value) || value.length > 100) throw new IsolatedPiHelperError("failed");
  const ids = new Set<string>();
  return value.map((item) => {
    if (
      !record(item) ||
      typeof item.id !== "string" ||
      !/^[a-z0-9][a-z0-9._-]{0,127}$/i.test(item.id) ||
      ids.has(item.id) ||
      !Array.isArray(item.methods) ||
      item.methods.length > 2 ||
      item.methods.some((method) => method !== "api_key" && method !== "oauth") ||
      new Set(item.methods).size !== item.methods.length
    )
      throw new IsolatedPiHelperError("failed");
    ids.add(item.id);
    return { id: item.id, methods: item.methods };
  });
}
function parseAuthPrompt(value: Record<string, unknown>): IsolatedPiAuthPrompt {
  if (!["text", "secret", "manual_code", "select"].includes(String(value.kind)))
    throw new IsolatedPiHelperError("failed");
  let options: { id: string; label: string }[] | undefined;
  if (value.kind === "select") {
    if (!Array.isArray(value.options) || !value.options.length || value.options.length > 50)
      throw new IsolatedPiHelperError("failed");
    options = value.options.map((option) => {
      if (!record(option)) throw new IsolatedPiHelperError("failed");
      return { id: boundedString(option.id, 128), label: boundedString(option.label, 256) };
    });
    if (new Set(options.map((option) => option.id)).size !== options.length) throw new IsolatedPiHelperError("failed");
  }
  return { id: value.id as number, kind: value.kind as IsolatedPiAuthPrompt["kind"], options };
}
function boundedString(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max || hasControl(value))
    throw new IsolatedPiHelperError("failed");
  return value;
}
function hasControl(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
