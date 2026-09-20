import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { parseAgentPrompt } from "./prompts";

const maxHeaderBytes = 16_385;
const maxHeadBytes = 256 * 1024;
const metadataChunkBytes = 64 * 1024;
const maxMetadataLineBytes = 256 * 1024;
const maxMetadataScanBytes = 512 * 1024;
const maxDiscoveryReadBytes = 64 * 1024 * 1024;
const minCandidateBudgetBytes = metadataChunkBytes;
const maxTitleCharacters = 160;
const defaultLimit = 100;
const statBatchSize = 50;

interface ReadBudget {
  remaining: number;
}

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

/** List bounded metadata for recent sessions, or return undefined when root discovery is unavailable. */
export async function listRecentPiSessions(
  activeSessionFile: string,
  cwd: string,
  limit = defaultLimit,
): Promise<PiSessionSummary[] | undefined> {
  if (!path.isAbsolute(activeSessionFile) || activeSessionFile.includes("\0")) return [];
  const requestedLimit = Number.isSafeInteger(limit) ? Math.max(0, Math.min(limit, defaultLimit)) : defaultLimit;
  if (requestedLimit === 0) return [];

  let canonicalCwd: string;
  try {
    canonicalCwd = await realpath(cwd);
  } catch {
    return undefined;
  }

  const directory = path.dirname(activeSessionFile);
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return undefined;
  }

  const sessionEntries = entries.filter((entry) => entry.name.endsWith(".jsonl"));
  const candidates: { readonly path: string; readonly updatedAt: number }[] = [];
  for (let offset = 0; offset < sessionEntries.length; offset += statBatchSize) {
    const batch = await Promise.all(
      sessionEntries.slice(offset, offset + statBatchSize).map(async (entry) => {
        const filePath = path.join(directory, entry.name);
        try {
          const stats = await lstat(filePath);
          return stats.isFile() ? { path: filePath, updatedAt: stats.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      }),
    );
    candidates.push(
      ...batch.filter((candidate): candidate is { path: string; updatedAt: number } => Boolean(candidate)),
    );
  }
  candidates.sort((left, right) => right.updatedAt - left.updatedAt);

  const budget: ReadBudget = { remaining: maxDiscoveryReadBytes };
  const summaries: PiSessionSummary[] = [];
  for (const candidate of candidates) {
    if (summaries.length >= requestedLimit || budget.remaining === 0) break;
    const budgetBefore = budget.remaining;
    const summary = await readSessionSummary(candidate.path, canonicalCwd, candidate.updatedAt, budget);
    const consumed = budgetBefore - budget.remaining;
    budget.remaining = Math.max(0, budget.remaining - Math.max(0, minCandidateBudgetBytes - consumed));
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function readSessionSummary(
  sessionPath: string,
  canonicalCwd: string,
  fallbackUpdatedAt: number,
  budget: ReadBudget,
): Promise<PiSessionSummary | undefined> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(sessionPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stats = await handle.stat();
    if (!stats.isFile()) return undefined;

    const headLength = Math.min(stats.size, maxHeadBytes);
    const headBuffer = Buffer.alloc(headLength);
    const headerLength = Math.min(headLength, maxHeaderBytes);
    let headBytesRead = await readBounded(handle, headBuffer, 0, headerLength, 0, budget);
    const headerText = headBuffer.subarray(0, headBytesRead).toString("utf8");
    const headerLineEnd = headerText.indexOf("\n");
    if (headerLineEnd < 0 || headerLineEnd >= maxHeaderBytes) return undefined;
    const header = parseRecord(headerText.slice(0, headerLineEnd));
    if (
      !header ||
      header.type !== "session" ||
      typeof header.id !== "string" ||
      typeof header.cwd !== "string" ||
      !path.isAbsolute(header.cwd)
    )
      return undefined;
    if (!(await sameWorkspace(header.cwd, canonicalCwd))) return undefined;

    if (headBytesRead < headLength) {
      headBytesRead += await readBounded(
        handle,
        headBuffer,
        headBytesRead,
        headLength - headBytesRead,
        headBytesRead,
        budget,
      );
    }
    const head = headBuffer.subarray(0, headBytesRead).toString("utf8");
    const parsedHeadLines = completeLines(head);
    const sessionName = await readLatestSessionName(handle, stats.size, budget);
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
    return (await realpath(source)) === canonicalCwd;
  } catch {
    return false;
  }
}

async function readBounded(
  handle: FileHandle,
  buffer: Buffer,
  bufferOffset: number,
  length: number,
  position: number,
  budget: ReadBudget,
): Promise<number> {
  let total = 0;
  while (total < length && budget.remaining > 0) {
    const requested = Math.min(length - total, budget.remaining);
    const { bytesRead } = await handle.read(buffer, bufferOffset + total, requested, position + total);
    if (bytesRead === 0) break;
    total += bytesRead;
    budget.remaining -= bytesRead;
  }
  return total;
}

async function readLatestSessionName(
  handle: FileHandle,
  size: number,
  budget: ReadBudget,
): Promise<string | undefined> {
  const scanStart = Math.max(0, size - maxMetadataScanBytes);
  let offset = size;
  let suffix = Buffer.alloc(0);
  let overlong = false;

  while (offset > scanStart && budget.remaining > 0) {
    const length = Math.min(metadataChunkBytes, offset - scanStart, budget.remaining);
    offset -= length;
    const buffer = Buffer.alloc(length);
    const bytesRead = await readBounded(handle, buffer, 0, length, offset, budget);
    const chunk = buffer.subarray(0, bytesRead);
    let lineEnd = chunk.length;

    for (let index = chunk.length - 1; index >= 0; index -= 1) {
      if (chunk[index] !== 0x0a) continue;
      const segment = chunk.subarray(index + 1, lineEnd);
      if (!overlong && segment.length + suffix.length <= maxMetadataLineBytes) {
        const parsed = parseRecord(Buffer.concat([segment, suffix]).toString("utf8"));
        if (parsed?.type === "session_info") {
          return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : undefined;
        }
      }
      suffix = Buffer.alloc(0);
      overlong = false;
      lineEnd = index;
    }

    const prefix = chunk.subarray(0, lineEnd);
    if (!overlong && prefix.length + suffix.length <= maxMetadataLineBytes) {
      suffix = Buffer.concat([prefix, suffix]);
    } else {
      suffix = Buffer.alloc(0);
      overlong = true;
    }
  }

  if (!overlong && suffix.length > 0) {
    const parsed = parseRecord(suffix.toString("utf8"));
    if (parsed?.type === "session_info") {
      return typeof parsed.name === "string" && parsed.name.trim() ? parsed.name : undefined;
    }
  }
  return undefined;
}

function completeLines(value: string): Record<string, unknown>[] {
  const lines = value.split("\n");
  if (!value.endsWith("\n")) lines.pop();
  return lines.flatMap((line) => {
    const parsed = parseRecord(line);
    return parsed ? [parsed] : [];
  });
}

function parseRecord(value: string): Record<string, unknown> | undefined {
  if (!value || value.length > maxHeadBytes) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
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
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim())
      return block.text;
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
    } catch {
      /* Ignore malformed or truncated metadata. */
    }
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
  const compact = parseAgentPrompt(value).request.replace(/\s+/g, " ").trim();
  if (!compact) return "New conversation";
  return compact.length > maxTitleCharacters ? `${compact.slice(0, maxTitleCharacters - 1).trimEnd()}…` : compact;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
