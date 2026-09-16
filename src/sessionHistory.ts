import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const maxHeadBytes = 256 * 1024;
const maxTailBytes = 256 * 1024;
const maxTitleCharacters = 160;
const defaultLimit = 100;
const maxCandidates = 500;

export interface PiSessionSummary {
  readonly key: string;
  readonly path: string;
  readonly sessionId: string;
  readonly title: string;
  readonly updatedAt: number;
}

export function piSessionKey(sessionPath: string): string {
  return createHash("sha256").update(sessionPath).digest("hex").slice(0, 24);
}

/** List bounded metadata for recent sessions stored beside the active workspace session. */
export async function listRecentPiSessions(
  activeSessionFile: string,
  cwd: string,
  limit = defaultLimit,
): Promise<PiSessionSummary[]> {
  if (!path.isAbsolute(activeSessionFile) || activeSessionFile.includes("\0")) return [];
  const requestedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, defaultLimit)) : defaultLimit;
  if (requestedLimit === 0) return [];

  const directory = path.dirname(activeSessionFile);
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = await Promise.all(entries
    .filter(entry => entry.isFile() && entry.name.endsWith(".jsonl"))
    .slice(0, maxCandidates)
    .map(async entry => {
      const filePath = path.join(directory, entry.name);
      try {
        const stats = await lstat(filePath);
        return stats.isFile() ? { path: filePath, updatedAt: stats.mtimeMs } : undefined;
      } catch {
        return undefined;
      }
    }));
  candidates.sort((left, right) => (right?.updatedAt ?? 0) - (left?.updatedAt ?? 0));

  const canonicalCwd = await realpath(cwd);
  const summaries: PiSessionSummary[] = [];
  for (const candidate of candidates) {
    if (!candidate || summaries.length >= requestedLimit) continue;
    const summary = await readSessionSummary(candidate.path, canonicalCwd, candidate.updatedAt);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function readSessionSummary(
  sessionPath: string,
  canonicalCwd: string,
  fallbackUpdatedAt: number,
): Promise<PiSessionSummary | undefined> {
  let handle;
  try {
    handle = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;

    const headLength = Math.min(stats.size, maxHeadBytes);
    const headBuffer = Buffer.alloc(headLength);
    const { bytesRead: headBytesRead } = await handle.read(headBuffer, 0, headLength, 0);
    const head = headBuffer.subarray(0, headBytesRead).toString("utf8");
    const headerLineEnd = head.indexOf("\n");
    if (headerLineEnd < 0 || headerLineEnd > 16_384) return undefined;
    const header = parseRecord(head.slice(0, headerLineEnd));
    if (!header || header.type !== "session" || typeof header.id !== "string" || typeof header.cwd !== "string" || !path.isAbsolute(header.cwd)) return undefined;
    if (!await sameWorkspace(header.cwd, canonicalCwd)) return undefined;

    let tail = "";
    let tailStartsAtFileBeginning = false;
    if (stats.size > headBytesRead) {
      const tailLength = Math.min(stats.size, maxTailBytes);
      const tailOffset = stats.size - tailLength;
      const tailBuffer = Buffer.alloc(tailLength);
      const { bytesRead: tailBytesRead } = await handle.read(tailBuffer, 0, tailLength, tailOffset);
      tail = tailBuffer.subarray(0, tailBytesRead).toString("utf8");
      tailStartsAtFileBeginning = tailOffset === 0;
    }

    const parsedHeadLines = completeLines(head, true);
    const parsedTailLines = tail ? completeLines(tail, tailStartsAtFileBeginning) : [];
    const sessionName = latestSessionName([...parsedHeadLines, ...parsedTailLines]);
    const firstPrompt = firstUserPrompt(parsedHeadLines) ?? extractUserTextPrefix(head);
    return {
      key: piSessionKey(sessionPath),
      path: sessionPath,
      sessionId: header.id.slice(0, 200),
      title: normalizeTitle(sessionName ?? firstPrompt ?? "New conversation"),
      updatedAt: Number.isFinite(stats.mtimeMs) ? stats.mtimeMs : fallbackUpdatedAt,
    };
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function sameWorkspace(source: string, canonicalCwd: string): Promise<boolean> {
  try {
    return await realpath(source) === canonicalCwd;
  } catch {
    return false;
  }
}

function completeLines(value: string, startsAtFileBeginning: boolean): Record<string, unknown>[] {
  const lines = value.split("\n");
  if (!startsAtFileBeginning) lines.shift();
  if (!value.endsWith("\n")) lines.pop();
  return lines.flatMap(line => {
    const parsed = parseRecord(line);
    return parsed ? [parsed] : [];
  });
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  if (!value || value.length > maxHeadBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch {
    return undefined;
  }
}

function latestSessionName(entries: readonly Record<string, unknown>[]): string | undefined {
  let name: string | undefined;
  for (const entry of entries) {
    if (entry.type === "session_info") name = typeof entry.name === "string" && entry.name.trim() ? entry.name : undefined;
  }
  return name;
}

function firstUserPrompt(entries: readonly Record<string, unknown>[]): string | undefined {
  for (const entry of entries) {
    if (entry.type !== "message" || !isRecord(entry.message) || entry.message.role !== "user") continue;
    const text = contentText(entry.message.content);
    if (text) return text;
  }
  return undefined;
}

function contentText(content: unknown): string | undefined {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return undefined;
  for (const block of content) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim()) return block.text;
  }
  return undefined;
}

/** Recover an early user text block even when a following base64 image makes the JSONL record too large to parse. */
function extractUserTextPrefix(value: string): string | undefined {
  const roleIndex = value.indexOf('"role":"user"');
  if (roleIndex < 0) return undefined;
  for (const field of ['"text":', '"content":']) {
    const fieldIndex = value.indexOf(field, roleIndex);
    if (fieldIndex < 0) continue;
    const quoteIndex = value.indexOf('"', fieldIndex + field.length);
    if (quoteIndex < 0) continue;
    const encoded = scanJsonString(value, quoteIndex);
    if (!encoded) continue;
    try {
      const decoded: unknown = JSON.parse(encoded);
      if (typeof decoded === "string" && decoded.trim()) return decoded;
    } catch { /* Ignore malformed or truncated metadata. */ }
  }
  return undefined;
}

function scanJsonString(value: string, start: number): string | undefined {
  let escaped = false;
  for (let index = start + 1; index < value.length; index += 1) {
    const character = value[index];
    if (escaped) {
      escaped = false;
    } else if (character === "\\") {
      escaped = true;
    } else if (character === '"') {
      return value.slice(start, index + 1);
    }
  }
  return undefined;
}

function normalizeTitle(value: string): string {
  const request = /^\s*<<<PICODE_REQUEST_START>>>\s*([\s\S]*?)(?:\s*<<<PICODE_REQUEST_END>>>|$)/.exec(value)?.[1] ?? value;
  const compact = request.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact.length > maxTitleCharacters ? `${compact.slice(0, maxTitleCharacters - 1).trimEnd()}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
