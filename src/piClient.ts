import { spawn } from "node:child_process";

const maxOutputBytes = 5 * 1024 * 1024;

export interface PiInvocationOptions {
  readonly executablePath: string;
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

export function invokePi(
  prompt: string,
  options: PiInvocationOptions,
  signal?: AbortSignal,
): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new PiInvocationError("Pi request was cancelled.", "aborted"));
      return;
    }

    const child = spawn(options.executablePath, buildPiArguments(options), {
      cwd: options.cwd,
      env: { ...process.env, NO_COLOR: "1" },
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

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
      child.kill();
      reject(error);
    };

    const abort = (): void => {
      fail(new PiInvocationError("Pi request was cancelled.", "aborted"));
    };

    signal?.addEventListener("abort", abort, { once: true });

    child.once("error", (error) => {
      fail(
        new PiInvocationError(
          `Could not start Pi using '${options.executablePath}'.`,
          "launch",
          error.message,
        ),
      );
    });

    child.stdout.on("data", (chunk: Buffer) => {
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

    child.once("close", (code, closeSignal) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();

      const result = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code !== 0) {
        reject(
          new PiInvocationError(
            `Pi exited with ${code === null ? `signal ${closeSignal ?? "unknown"}` : `code ${code}`}.`,
            "exit",
            errorOutput,
          ),
        );
        return;
      }
      if (result.trim().length === 0) {
        reject(new PiInvocationError("Pi returned an empty response.", "output", errorOutput));
        return;
      }
      resolve(result);
    });

    child.stdin.once("error", (error) => {
      fail(new PiInvocationError("Could not send the prompt to Pi.", "launch", error.message));
    });
    child.stdin.end(prompt);
  });
}
