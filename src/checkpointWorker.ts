import { parentPort } from "node:worker_threads";
import {
  type CaptureRecord,
  captureRecordBytes,
  maxCaptureBatchBytes,
  maxCaptureBatchEntries,
  scanCheckpoint,
} from "./checkpointCapture";

export type CaptureCommand =
  | { type: "start"; id: number; root: string; dirty: string[] }
  | { type: "ack" | "cancel"; id: number };
export type CaptureReply =
  | { type: "batch"; id: number; records: CaptureRecord[]; done: boolean }
  | { type: "cancelled" | "failed"; id: number };

const port = parentPort;
if (!port) throw new Error("Checkpoint worker requires a parent port.");
let active: { id: number; scan: ReturnType<typeof scanCheckpoint>; held?: CaptureRecord } | undefined;
port.on("message", (command: CaptureCommand) => {
  const { id } = command;
  if (command.type === "start" && !active) active = { id, scan: scanCheckpoint(command.root, new Set(command.dirty)) };
  if (active?.id !== id) return;
  if (command.type === "cancel") {
    active = undefined;
    port.postMessage({ type: "cancelled", id } satisfies CaptureReply);
    return;
  }
  try {
    const records: CaptureRecord[] = [];
    let bytes = 0;
    let done = false;
    for (let entries = 0; entries < maxCaptureBatchEntries; entries++) {
      const step: IteratorResult<CaptureRecord | undefined> = active.held
        ? { value: active.held, done: false }
        : active.scan.next();
      active.held = undefined;
      if (step.done) {
        active = undefined;
        done = true;
        break;
      }
      if (!step.value) continue;
      const cost = captureRecordBytes(step.value);
      if (cost > maxCaptureBatchBytes) throw new Error("Checkpoint record exceeds its transfer limit.");
      if (bytes + cost > maxCaptureBatchBytes) {
        active.held = step.value;
        break;
      }
      bytes += cost;
      records.push(step.value);
    }
    port.postMessage({ type: "batch", id, records, done } satisfies CaptureReply);
  } catch {
    active = undefined;
    port.postMessage({ type: "failed", id } satisfies CaptureReply);
  }
});
