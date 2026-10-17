import type { ChildProcessWithoutNullStreams } from "node:child_process";

export interface PiProcessCleanup {
  readonly pipesClosed: boolean;
  readonly warning?: string;
}

// Own the direct child and, on POSIX, its detached process group. No shell is used.
export class PiProcessOwner {
  private rootExited = false;
  private pipesClosed = false;
  private resolveExit!: () => void;
  private resolveClose!: () => void;
  private readonly exit = new Promise<void>((resolve) => {
    this.resolveExit = resolve;
  });
  private readonly close = new Promise<void>((resolve) => {
    this.resolveClose = resolve;
  });
  private stopping: Promise<PiProcessCleanup> | undefined;

  private readonly onExit = (): void => {
    this.rootExited = true;
    this.resolveExit();
  };
  private readonly onError = (): void => {
    if (!this.child.pid) this.onExit();
  };
  private readonly onClose = (): void => {
    this.pipesClosed = true;
    this.resolveClose();
  };

  public constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.once("exit", this.onExit);
    child.once("error", this.onError);
    child.once("close", this.onClose);
  }

  public stop(): Promise<PiProcessCleanup> {
    this.stopping ??= this.stopOwnedProcess();
    return this.stopping;
  }

  private signal(signal: NodeJS.Signals): void {
    try {
      if (process.platform !== "win32" && this.child.pid) process.kill(-this.child.pid, signal);
      else if (!this.rootExited) this.child.kill(signal);
    } catch {
      /* Exit and pipe observations determine the cleanup result. */
    }
  }

  private async stopOwnedProcess(): Promise<PiProcessCleanup> {
    if (!this.rootExited && this.child.pid) {
      this.signal("SIGTERM");
      await within(this.exit, 1_000);
    }
    // Kill remaining group members even when the POSIX root has already exited.
    if (this.child.pid) this.signal("SIGKILL");
    await within(this.close, 1_000);
    const rootExited = this.rootExited || !this.child.pid;
    const pipesClosed = this.pipesClosed;
    let warning: string | undefined;
    if (!rootExited || !pipesClosed) {
      warning = "Pi cleanup deadline reached; process or descendant cleanup could not be verified.";
    } else if (process.platform === "win32" && this.child.pid) {
      warning = "Pi process exited; Windows descendant cleanup could not be verified.";
    }
    this.child.removeListener("exit", this.onExit);
    this.child.removeListener("error", this.onError);
    this.child.removeListener("close", this.onClose);
    this.child.stdin.destroy();
    this.child.stdout.destroy();
    this.child.stderr.destroy();
    this.child.unref();
    return { pipesClosed, warning };
  }
}

async function within(promise: Promise<void>, milliseconds: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
