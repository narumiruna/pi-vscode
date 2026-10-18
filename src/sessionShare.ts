import { spawn } from "node:child_process";
import { PiProcessOwner } from "./piProcess";
import { buildPiProcessEnvironment, planPiSpawn } from "./piSpawn";
import { maxShareBytes } from "./sessionTransfer";

export function gistUrl(value: string): string {
  if (!/^https:\/\/gist\.github\.com\/[a-z0-9](?:[a-z0-9-]{0,38})\/[a-f0-9]{1,64}$/i.test(value))
    throw new Error("GitHub did not return a verified gist URL. Check your gists before retrying.");
  return value;
}
export const gistCreateArguments = ["gist", "create", "--public=false", "--filename", "pi-session.jsonl", "-"] as const;

/** Called only after exact payload inspection and a separate modal upload approval. Never retries. */
export async function uploadSessionGist(
  payload: Buffer,
  cwd: string,
  signal?: AbortSignal,
  executable = "gh",
): Promise<string> {
  if (!payload.length || payload.length > maxShareBytes)
    throw new Error("A shared session must be between 1 byte and 2 MiB.");
  if (signal?.aborted) throw new Error("Upload cancelled before launch. Nothing was sent.");
  const env = buildPiProcessEnvironment(process.env, { GH_HOST: "github.com", GH_PROMPT_DISABLED: "1", GH_DEBUG: "" });
  const plan = planPiSpawn(executable, gistCreateArguments, { cwd, env });
  const child = spawn(plan.command, plan.args, {
    cwd,
    env,
    shell: false,
    detached: process.platform !== "win32",
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const owner = new PiProcessOwner(child);
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let output = Buffer.alloc(0);
    let bytes = 0;
    const clear = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    };
    const fail = (): void => {
      if (settled) return;
      settled = true;
      clear();
      void owner
        .stop()
        .then((cleanup) =>
          reject(
            new Error(
              `Upload completion is unknown. Check GitHub gists before retrying. No automatic retry was made.${cleanup.warning ? " Process descendant cleanup is unverified." : ""}`,
            ),
          ),
        );
    };
    const abort = (): void => fail();
    const timer = setTimeout(fail, 60_000);
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) return fail();
      output = Buffer.concat([output, chunk]);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > 65_536) fail(); // Drain but never retain CLI diagnostics that can contain credentials.
    });
    child.once("error", fail);
    child.stdin.once("error", fail);
    child.once("exit", (code) => {
      void owner.stop().then((cleanup) => {
        if (settled) return;
        if (code !== 0 || !cleanup.pipesClosed) return fail();
        try {
          const url = gistUrl(new TextDecoder("utf-8", { fatal: true }).decode(output).trim());
          settled = true;
          clear();
          if (cleanup.warning)
            reject(
              new Error(
                `Uploaded non-public gist: ${url}. Process descendant cleanup is unverified. Do not retry; delete it separately on GitHub.`,
              ),
            );
          else resolve(url);
        } catch {
          fail();
        }
      });
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    if (!settled) child.stdin.end(payload);
  });
}

/** Redact string values, not JSON syntax, and retain every entry and branch link. */
export function redactSessionPayload(payload: Buffer, literal: string): Buffer {
  if (!literal || literal.length > 8_192) throw new Error("Enter between 1 and 8,192 characters to redact.");
  const redact = (value: unknown): unknown => {
    if (typeof value === "string") return value.split(literal).join("[REDACTED]");
    if (Array.isArray(value)) return value.map(redact);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
    return value;
  };
  const lines = payload
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.stringify(redact(JSON.parse(line))));
  const result = Buffer.from(`${lines.join("\n")}\n`);
  if (result.length > maxShareBytes) throw new Error("Redacted payload exceeds 2 MiB. Choose a smaller session.");
  return result;
}
