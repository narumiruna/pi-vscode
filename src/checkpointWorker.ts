import { parentPort } from "node:worker_threads";
import {
  type CaptureRecord,
  captureRecordBytes,
  checkpointReader,
  compareCheckpoint,
  maxCaptureBatchBytes,
  maxCaptureBatchEntries,
  type SettlementChange,
  type SettlementEntry,
  scanCheckpoint,
} from "./checkpointCapture";

export type CaptureCommand =
  | { type: "start"; id: number; root: string; dirty: string[] }
  | { type: "compare"; id: number; root: string; entries: SettlementEntry[] }
  | { type: "ack" | "cancel"; id: number };
export type CaptureReply =
  | { type: "batch"; id: number; records: CaptureRecord[]; done: boolean }
  | { type: "settled"; id: number; changes: SettlementChange[] }
  | { type: "cancelled" | "failed"; id: number };

const port = parentPort;
if (!port) throw new Error("Checkpoint worker requires a parent port.");
let active: { id: number; scan: ReturnType<typeof scanCheckpoint>; held?: CaptureRecord } | undefined;
port.on("message", (command: CaptureCommand) => {
  const { id } = command;
  if (command.type === "start" && !active) active = { id, scan: scanCheckpoint(command.root, new Set(command.dirty)) };
  if (command.type === "compare" && !active) {
    const read = checkpointReader(command.root);
    const changes: SettlementChange[] = [];
    for (const entry of command.entries) {
      const change = compareCheckpoint(read, entry);
      if (change) changes.push(change);
    }
    port.postMessage({ type: "settled", id, changes } satisfies CaptureReply);
    return;
  }
  if (command.type === "cancel" && (!active || active.id === id)) {
    active = undefined;
    port.postMessage({ type: "cancelled", id } satisfies CaptureReply);
    return;
  }
  if (active?.id !== id) return;
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
