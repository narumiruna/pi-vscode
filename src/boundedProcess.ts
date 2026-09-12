import { spawn } from "node:child_process";

export interface ProcessResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly exitCode: number | null;
  readonly status: "exited" | "timeout" | "cancelled" | "output-limit";
  readonly cleanup: string;
}

/** Own a process group on POSIX; never use shell parsing or inherit stdin. */
export function runBoundedProcess(executable: string, args: readonly string[], options: {
  cwd: string; signal?: AbortSignal; timeoutMs?: number; maxBytes?: number; env?: NodeJS.ProcessEnv;
}): Promise<ProcessResult> {
  if (!executable || executable.includes("\0") || args.some(arg => typeof arg !== "string" || arg.includes("\0"))) {
    return Promise.reject(new Error("Invalid executable or argument vector."));
  }
  if (options.signal?.aborted) return Promise.reject(new Error("Operation cancelled."));
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32";
    const child = spawn(executable, [...args], {
      cwd: options.cwd, env: options.env ?? process.env, shell: false, windowsHide: true,
      detached: grouped, stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let size = 0;
    let status: ProcessResult["status"] = "exited";
    let done = false;
    let killTimer: NodeJS.Timeout | undefined;
    let finishTimer: NodeJS.Timeout | undefined;
    const kill = (signal: NodeJS.Signals) => {
      try {
        if (grouped && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* Already exited. */ }
    };
    const stop = (reason: ProcessResult["status"]) => {
      if (status !== "exited" || done) return;
      status = reason;
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 200);
      // An escaped descendant can retain a pipe even after the owned group exits.
      finishTimer = setTimeout(() => {
        if (done) return;
        cleanup();
        child.stdout.destroy(); child.stderr.destroy(); child.unref();
        resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode: child.exitCode, status,
          cleanup: "Termination attempted; descendant cleanup could not be verified" });
      }, 1000);
    };
    const collect = (chunks: Buffer[], chunk: Buffer) => {
      const remaining = Math.max(0, (options.maxBytes ?? 1024 * 1024) - size);
      chunks.push(chunk.subarray(0, remaining));
      size += chunk.length;
      if (chunk.length > remaining) stop("output-limit");
    };
    child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
    const cancel = () => stop("cancelled");
    options.signal?.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => stop("timeout"), options.timeoutMs ?? 30_000);
    const cleanup = () => {
      done = true;
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      if (finishTimer) clearTimeout(finishTimer);
      options.signal?.removeEventListener("abort", cancel);
      // Descendants must not outlive a bounded invocation, including inherited output pipes.
      if (grouped) kill("SIGKILL");
    };
    child.once("error", error => { if (done) return; cleanup(); reject(new Error(`Could not run ${executable}: ${error.message}`)); });
    child.once("exit", () => { if (grouped) kill("SIGKILL"); });
    child.once("close", exitCode => {
      if (done) return;
      cleanup();
      resolve({ stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), exitCode, status,
        cleanup: grouped ? "Owned process group terminated" : "Direct process terminated; descendant cleanup is not guaranteed on Windows" });
    });
    if (options.signal?.aborted) cancel();
  });
}
