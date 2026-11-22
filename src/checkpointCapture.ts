import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, realpathSync } from "node:fs";
import path from "node:path";
import { safeRelativePath } from "./workspaceFiles";

export const maxCheckpointFile = 2 * 1024 * 1024;
export const maxCheckpointBytes = 20 * 1024 * 1024;
export const maxCaptureBatchEntries = 512;
export const maxCaptureBatchBytes = maxCheckpointFile + 16 * 1024;
const maxVisited = 10_000;
const excluded = new Set([".git", "node_modules", ".aru"]);

export interface CaptureEntry {
  readonly name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}
export type CaptureListing = ReadonlyMap<string, readonly CaptureEntry[]>;
export type CaptureRecord = { readonly path: string; readonly before: string } | { readonly exclusion: string };
export type SettlementEntry = { readonly path: string; readonly before: string; readonly expected?: string };
export type SettlementChange = { readonly path: string; readonly matched: boolean };
export const maxSettlementBatchBytes = 2 * maxCheckpointFile + 16 * 1024;

export function settlementEntryBytes(entry: SettlementEntry): number {
  return (
    128 + Buffer.byteLength(entry.path) + Buffer.byteLength(entry.before) + Buffer.byteLength(entry.expected ?? "")
  );
}

export const skipCaptureDirectory = (name: string): boolean => excluded.has(name);
export const checkpointPathKey = (absolute: string): string =>
  process.platform === "win32" ? absolute.toLowerCase() : absolute;

function canonical(absolute: string): boolean {
  try {
    if (realpathSync.native(absolute) === absolute) return true;
  } catch {
    // Confirm with the original resolver if native lookup cannot verify the path.
  }
  return realpathSync(absolute) === absolute;
}

export function compareCheckpoint(
  read: ReturnType<typeof checkpointReader>,
  entry: SettlementEntry,
): SettlementChange | undefined {
  // Text can have a UTF-8 BOM that is stripped by the decoder.
  const maxBytes = Math.max(Buffer.byteLength(entry.before), Buffer.byteLength(entry.expected ?? "")) + 3;
  const after = read(entry.path, maxBytes);
  if (after !== entry.before) return { path: entry.path, matched: after !== undefined && after === entry.expected };
}

export function checkpointReader(root: string): (relative: string, maxBytes?: number) => string | undefined {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let scratch = Buffer.alloc(0);
  return (relative, maxBytes = maxCheckpointFile) => {
    try {
      if (!safeRelativePath(relative)) return undefined;
      const target = path.join(root, relative);
      if (!canonical(path.dirname(target))) return undefined;
      // Where the OS supports both flags, reject symlink leaves at open and avoid blocking on a raced FIFO.
      // Other platforms still need the explicit leaf check before opening.
      if (!(constants.O_NOFOLLOW && constants.O_NONBLOCK) && !lstatSync(target).isFile()) return undefined;
      const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const stat = fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > Math.min(maxBytes, maxCheckpointFile)) return undefined;
        if (scratch.length < stat.size + 1) scratch = Buffer.allocUnsafe(stat.size + 1);
        const count = readSync(fd, scratch, 0, stat.size + 1, 0);
        const after = fstatSync(fd);
        if (count !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) return undefined;
        const bytes = scratch.subarray(0, count);
        return bytes.includes(0) ? undefined : decoder.decode(bytes);
      } finally {
        closeSync(fd);
      }
    } catch {
      return undefined;
    }
  };
}

export function* scanCheckpoint(
  root: string,
  dirty: ReadonlySet<string>,
  listing?: CaptureListing,
): Generator<CaptureRecord | undefined> {
  const read = checkpointReader(root);
  let bytes = 0;
  let visited = 0;
  const pending = [""];
  yield {
    exclusion:
      "Coverage: pre-captured existing regular text files only; new files, deletions, and shell effects are unsupported.",
  };
  while (pending.length && visited < maxVisited && bytes < maxCheckpointBytes) {
    const relative = pending.pop() ?? "";
    const directory = path.join(root, relative);
    try {
      if (!canonical(directory)) {
        yield { exclusion: `${relative}: symlink directory` };
        continue;
      }
      const entries = listing ? listing.get(directory) : readdirSync(directory, { withFileTypes: true });
      if (!entries) throw new Error("Workspace listing changed.");
      for (const entry of entries) {
        if (++visited > maxVisited) break;
        const name = path.posix.join(relative.replace(/\\/g, "/"), entry.name);
        if (skipCaptureDirectory(entry.name)) yield { exclusion: `${name}: excluded directory` };
        else if (entry.isDirectory()) {
          pending.push(name);
          yield undefined;
        } else if (!entry.isFile() || dirty.has(checkpointPathKey(path.join(root, name)))) {
          yield { exclusion: `${name}: non-regular or dirty buffer` };
        } else {
          const before = read(name);
          if (before === undefined) yield { exclusion: `${name}: unavailable, non-text or oversized` };
          else {
            bytes += Buffer.byteLength(before);
            if (bytes > maxCheckpointBytes) {
              yield { exclusion: "Request-start capture overflow" };
              break;
            }
            yield { path: name, before };
          }
        }
      }
    } catch {
      yield { exclusion: `${relative}: unavailable during request-start capture` };
    }
  }
  if (pending.length || visited >= maxVisited) yield { exclusion: "Request-start enumeration limit" };
}

export function captureRecordBytes(record: CaptureRecord): number {
  return (
    128 +
    ("path" in record
      ? Buffer.byteLength(record.path) + Buffer.byteLength(record.before)
      : Buffer.byteLength(record.exclusion))
  );
}
