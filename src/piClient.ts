import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { PiProcessOwner } from "./piProcess";
import type { PiLaunchDescription } from "./piRuntimeSelection";
import { buildPiProcessEnvironment, planPiSpawn } from "./piSpawn";

const maxOutputBytes = 5 * 1024 * 1024;

export interface PiInvocationOptions extends PiLaunchDescription {
  readonly cwd: string;
  readonly provider?: string;
  readonly model?: string;
  readonly thinkingLevel?: string;
}

export class PiInvocationError extends Error {
  public constructor(
    message: string,
    public readonly kind: "aborted" | "launch" | "exit" | "output",
    public readonly details?: string,
  ) {
    super(message);
    this.name = "PiInvocationError";
  }
}

export function buildPiArguments(options: PiInvocationOptions): string[] {
  const args = ["--print", "--no-session", "--no-tools"];
  if (options.provider) {
    args.push("--provider", options.provider);
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.thinkingLevel) {
    args.push("--thinking", options.thinkingLevel);
  }
  return args;
}

export function invokePi(prompt: string, options: PiInvocationOptions, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PiInvocationError("Pi request was cancelled.", "aborted"));
      return;
    }

    const env = buildPiProcessEnvironment(process.env, options.env, options.unsetEnv);
    let child: ChildProcessWithoutNullStreams;
    try {
      const plan = planPiSpawn(
        options.executablePath,
        [...(options.executableArgs ?? []), ...buildPiArguments(options)],
        {
          cwd: options.cwd,
          env,
        },
      );
      child = spawn(plan.command, plan.args, {
        cwd: options.cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      reject(
        new PiInvocationError(
          "Could not plan or start Pi.",
          "launch",
          error instanceof Error ? error.message : String(error),
        ),
      );
      return;
    }
    const owner = new PiProcessOwner(child);

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let errorBytes = 0;
    let settled = false;

    const cleanup = (): void => {
      signal?.removeEventListener("abort", abort);
    };

    const fail = (error: PiInvocationError): void => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      void owner.stop().then((result) => {
        reject(
          new PiInvocationError(error.message, error.kind, [error.details, result.warning].filter(Boolean).join(" ")),
        );
      });
    };

    const abort = (): void => {
      fail(new PiInvocationError("Pi request was cancelled.", "aborted"));
    };

    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();

    child.once("error", (error) => {
      fail(new PiInvocationError(`Could not start Pi using '${options.executablePath}'.`, "launch", error.message));
    });

    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        fail(new PiInvocationError("Pi produced more than 5 MiB of output.", "output"));
        return;
      }
      stdout.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (errorBytes >= maxOutputBytes) {
        return;
      }
      const remainingBytes = maxOutputBytes - errorBytes;
      const capturedChunk = chunk.subarray(0, remainingBytes);
      stderr.push(capturedChunk);
      errorBytes += capturedChunk.length;
    });

    child.once("exit", (code, closeSignal) => {
      void owner.stop().then((cleanupResult) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (!cleanupResult.pipesClosed) {
          reject(new PiInvocationError("Pi output pipes did not close.", "output", cleanupResult.warning));
          return;
        }

        const result = Buffer.concat(stdout).toString("utf8");
        const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
        if (code !== 0) {
          reject(
            new PiInvocationError(
              `Pi exited with ${code === null ? `signal ${closeSignal ?? "unknown"}` : `code ${code}`}.`,
              "exit",
              [errorOutput, cleanupResult.warning].filter(Boolean).join(" "),
            ),
          );
          return;
        }
        if (result.trim().length === 0) {
          reject(
            new PiInvocationError(
              "Pi returned an empty response.",
              "output",
              [errorOutput, cleanupResult.warning].filter(Boolean).join(" "),
            ),
          );
          return;
        }
        resolve(result);
      });
    });

    child.stdin.once("error", (error) => {
      fail(new PiInvocationError("Could not send the prompt to Pi.", "launch", error.message));
    });
    child.stdin.end(prompt);
  });
}
