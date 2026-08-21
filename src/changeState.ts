import { createHash } from "node:crypto";

export interface FileVersionState {
  readonly exists: boolean;
  readonly hash?: string;
}

export function fileVersion(content: Uint8Array | undefined): FileVersionState {
  return content === undefined
    ? { exists: false }
    : { exists: true, hash: createHash("sha256").update(content).digest("hex") };
}

export function hasFileChanged(before: FileVersionState, after: FileVersionState): boolean {
  return before.exists !== after.exists || before.hash !== after.hash;
}

export function canSafelyRevert(recordedAfter: FileVersionState, current: FileVersionState): boolean {
  return recordedAfter.exists === current.exists && recordedAfter.hash === current.hash;
}
