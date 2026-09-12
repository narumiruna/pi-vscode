import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";

/** Read only the bounded JSONL header; never load a full session to identify its workspace. */
export async function assertSessionWorkspace(sessionFile: string, cwd: string): Promise<void> {
  if (!path.isAbsolute(sessionFile) || sessionFile.includes("\0")) throw new Error("Invalid Pi session path.");
  const handle = await open(sessionFile, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!(await handle.stat()).isFile()) throw new Error("Pi session is not a regular file.");
    const bytes = Buffer.alloc(16_384);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const newline = bytes.subarray(0, bytesRead).indexOf(10);
    if (newline < 0) throw new Error("Pi session header is missing or oversized.");
    const header: unknown = JSON.parse(bytes.subarray(0, newline).toString("utf8"));
    if (!header || typeof header !== "object" || (header as Record<string, unknown>).type !== "session") throw new Error("Invalid Pi session header.");
    const source = (header as Record<string, unknown>).cwd;
    if (typeof source !== "string" || !path.isAbsolute(source) || await realpath(source) !== await realpath(cwd)) throw new Error("Pi session belongs to another working directory. Open that workspace explicitly before resuming.");
  } finally { await handle.close(); }
}
