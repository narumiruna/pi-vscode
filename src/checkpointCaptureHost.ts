import { opendir, realpath } from "node:fs/promises";
import path from "node:path";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { Worker } from "node:worker_threads";
import { type CaptureEntry, type CaptureRecord, scanCheckpoint, skipCaptureDirectory } from "./checkpointCapture";
import type { CaptureCommand, CaptureReply } from "./checkpointWorker";

const maxInlineEntries = 128;
const maxCaptureJobs = 9;
const cancelled = () => new Error("Pi request was cancelled.");

async function smallListing(root: string, signal: AbortSignal): Promise<Map<string, CaptureEntry[]> | undefined> {
  const pending = [root];
  const listing = new Map<string, CaptureEntry[]>();
  let count = 0;
  while (pending.length) {
    if (signal.aborted) throw cancelled();
    const directory = pending.pop() ?? root;
    try {
      if ((await realpath(directory)) !== directory) return undefined;
      const dir = await opendir(directory, { bufferSize: 16 });
      const items: { bytes: Buffer; entry: CaptureEntry }[] = [];
      try {
        for (let entry = await dir.read(); entry; entry = await dir.read()) {
          if (signal.aborted || ++count > maxInlineEntries) return undefined;
          const name = entry.name;
          if (name.includes("\uFFFD")) return undefined;
          const isDirectory = entry.isDirectory();
          const isFile = entry.isFile();
          if (isDirectory && !skipCaptureDirectory(name)) pending.push(path.join(directory, name));
          items.push({
            bytes: Buffer.from(name),
            entry: { name, isDirectory: () => isDirectory, isFile: () => isFile },
          });
        }
      } finally {
        await dir.close();
      }
      // Match readdir's byte order, not the filesystem order returned by the directory stream.
      listing.set(
        directory,
        items.sort((a, b) => Buffer.compare(a.bytes, b.bytes)).map(({ entry }) => entry),
      );
    } catch {
      return undefined;
    }
  }
  return listing;
}

type Job = {
  id: number;
  root: string;
  dirty: ReadonlySet<string>;
  signal: AbortSignal;
  accept: (record: CaptureRecord) => void;
  cancel: () => void;
  finish: (error?: Error) => void;
};

export class CheckpointCaptureWorker {
  private worker: Worker | undefined;
  private active: Job | undefined;
  private readonly waiting: Job[] = [];
  private id = 0;
  private closing: Promise<unknown> | undefined;

  public constructor(
    private readonly createWorker = () =>
      new Worker(path.join(__dirname, "checkpointWorker.js"), { env: {}, execArgv: [] }),
  ) {}

  public capture(root: string, dirty: ReadonlySet<string>, signal: AbortSignal, accept: Job["accept"]): Promise<void> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.closing) return Promise.reject(new Error("Checkpoint worker is stopping."));
    if (this.waiting.length + Number(Boolean(this.active)) >= maxCaptureJobs)
      return Promise.reject(new Error("Checkpoint capture queue is full."));
    return new Promise((resolve, reject) => {
      const job: Job = {
        id: ++this.id,
        root,
        dirty,
        signal,
        accept,
        cancel: () => {
          if (this.active === job) this.send({ type: "cancel", id: job.id });
          else {
            const index = this.waiting.indexOf(job);
            if (index !== -1) this.waiting.splice(index, 1);
            job.finish(cancelled());
          }
        },
        finish: (error) => {
          signal.removeEventListener("abort", job.cancel);
          if (error) reject(error);
          else resolve();
        },
      };
      signal.addEventListener("abort", job.cancel, { once: true });
      this.waiting.push(job);
      this.startNext();
    });
  }

  private startNext(): void {
    if (this.active) return;
    const job = this.waiting.shift();
    if (!job) {
      this.worker?.unref();
      return;
    }
    this.active = job;
    try {
      if (!this.worker) {
        const worker = this.createWorker();
        this.worker = worker;
        worker.on("message", (reply: CaptureReply) => {
          try {
            this.receive(worker, reply);
          } catch {
            this.fail(worker);
          }
        });
        worker.on("error", () => this.fail(worker));
        worker.on("exit", () => this.fail(worker));
      }
      this.worker.ref();
      this.worker.postMessage({
        type: "start",
        id: job.id,
        root: job.root,
        dirty: [...job.dirty],
      } satisfies CaptureCommand);
    } catch {
      this.fail(this.worker);
    }
  }

  private receive(worker: Worker, reply: CaptureReply): void {
    const job = this.active;
    if (worker !== this.worker || !job || job.id !== reply.id) return;
    if (reply.type === "batch" && !job.signal.aborted) {
      for (const record of reply.records) {
        if (job.signal.aborted) break;
        job.accept(record);
      }
      if (!reply.done) {
        setImmediate(() => {
          if (this.active === job && !job.signal.aborted) this.send({ type: "ack", id: job.id });
        });
        return;
      }
    } else if (reply.type === "batch" && !reply.done) return;
    this.active = undefined;
    job.finish(
      job.signal.aborted || reply.type === "cancelled"
        ? cancelled()
        : reply.type === "failed"
          ? new Error("Checkpoint worker could not capture the workspace.")
          : undefined,
    );
    this.startNext();
  }

  private send(command: CaptureCommand): void {
    try {
      this.worker?.postMessage(command);
    } catch {
      this.fail(this.worker);
    }
  }

  private fail(worker: Worker | undefined): void {
    if (worker !== this.worker) return;
    void this.close().catch(() => {});
  }

  public async close(): Promise<void> {
    if (this.closing) {
      await this.closing;
      return;
    }
    const worker = this.worker;
    this.worker = undefined;
    this.closing = worker?.terminate();
    const failure = new Error("Checkpoint worker stopped before capture completed.");
    this.active?.finish(failure);
    this.active = undefined;
    for (const job of this.waiting.splice(0)) job.finish(failure);
    try {
      await this.closing;
    } finally {
      this.closing = undefined;
    }
  }
}

export const checkpointCaptureWorker = new CheckpointCaptureWorker();

export async function captureCheckpoint(
  root: string,
  dirty: ReadonlySet<string>,
  signal: AbortSignal,
  accept: Job["accept"],
): Promise<void> {
  const listing = await smallListing(root, signal);
  if (signal.aborted) throw cancelled();
  if (!listing) return checkpointCaptureWorker.capture(root, dirty, signal, accept);
  let steps = 0;
  let deadline = performance.now() + 2;
  for (const record of scanCheckpoint(root, dirty, listing)) {
    if (record) accept(record);
    if (++steps % 16 === 0 || performance.now() >= deadline) {
      await yieldTurn();
      if (signal.aborted) throw cancelled();
      deadline = performance.now() + 2;
    }
  }
}
