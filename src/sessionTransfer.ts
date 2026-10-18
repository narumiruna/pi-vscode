import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { readWorkspaceFile } from "./workspaceFiles";

export const maxSessionTransferBytes = 32 * 1024 * 1024;
export const maxSessionLineBytes = 8 * 1024 * 1024;
export const maxShareBytes = 2 * 1024 * 1024;
const idPattern = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
const entryTypes = new Set([
  "message",
  "model_change",
  "thinking_level_change",
  "usage",
  "compaction",
  "context_edit",
  "branch_summary",
  "custom",
  "custom_message",
  "label",
  "session_info",
]);
export interface ValidatedSession {
  readonly header: { id: string; cwd: string; version: 3 };
  readonly entries: readonly Record<string, unknown>[];
}

/** Same JSON.stringify(entry) + LF digest as the packaged read-only session-location query. */
export function hashSessionEntries(entries: readonly unknown[]): string {
  if (entries.length > 50_000) throw new Error("Session transfer exceeds 50,000 entries.");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (serialized === undefined) throw new Error("Invalid session entry.");
    bytes += Buffer.byteLength(serialized) + 1;
    if (bytes > maxSessionTransferBytes) throw new Error("Session transfer exceeds 32 MiB.");
    hash.update(serialized).update("\n");
  }
  return hash.digest("hex");
}

/** Validate the complete supported v3 tree, without executing or silently dropping any entry. */
export function validateSessionJsonl(bytes: Buffer): ValidatedSession {
  if (!bytes.length || bytes.length > maxSessionTransferBytes || bytes[bytes.length - 1] !== 10)
    throw new Error("The session is empty, truncated, or exceeds the 32 MiB limit.");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const lines = text.split("\n");
  lines.pop();
  if (lines.length > 50_001) throw new Error("The session exceeds 50,000 entries.");
  const values = lines.map((line) => {
    if (!line || Buffer.byteLength(line) > maxSessionLineBytes)
      throw new Error("Invalid or oversized session line (8 MiB limit).");
    const value: unknown = JSON.parse(line);
    if (!record(value)) throw new Error("Each session line must be a JSON object.");
    return value;
  });
  const header = values.shift();
  if (
    header?.type !== "session" ||
    header.version !== 3 ||
    !validId(header.id) ||
    typeof header.cwd !== "string" ||
    !path.isAbsolute(header.cwd) ||
    header.cwd.includes("\0") ||
    !timestamp(header.timestamp) ||
    (header.parentSession !== undefined &&
      (typeof header.parentSession !== "string" || header.parentSession.includes("\0")))
  )
    throw new Error(
      "A complete Pi v3 session header with an absolute working directory is required. Legacy versions are not imported.",
    );
  const entries = new Map<string, Record<string, unknown>>();
  let imageBytes = 0;
  let nodes = 0;
  let referenceBudget = 500_000;
  const branchContains = (from: unknown, target: unknown): boolean => {
    while (typeof from === "string") {
      if (--referenceBudget < 0) throw new Error("Session references exceed the validation work limit.");
      if (from === target) return true;
      from = entries.get(from)?.parentId;
    }
    return false;
  };
  const checkData = (root: unknown): void => {
    const stack = [{ value: root, depth: 0 }];
    while (stack.length) {
      const item = stack.pop();
      if (!item) break;
      if (++nodes > 500_000 || item.depth > 64) throw new Error("Session data exceeds the structural limits.");
      if (typeof item.value === "number" && !Number.isFinite(item.value)) throw new Error("Non-finite session value.");
      if (!item.value || typeof item.value !== "object") continue;
      if (record(item.value) && item.value.type === "image") {
        const { data, mimeType } = item.value;
        if (
          typeof data !== "string" ||
          !["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(mimeType)) ||
          data.length > 6_990_508 ||
          /[^A-Za-z0-9+/=]/.test(data)
        )
          throw new Error("Invalid or oversized session image.");
        const decoded = Buffer.from(data, "base64");
        imageBytes += decoded.length;
        if (
          !decoded.length ||
          decoded.length > 5 * 1024 * 1024 ||
          decoded.toString("base64") !== data ||
          imageBytes > 25 * 1024 * 1024
        )
          throw new Error("Session images exceed 5 MiB per image or 25 MiB in total.");
      }
      const count = Array.isArray(item.value) ? item.value.length : Object.keys(item.value).length;
      if (count + nodes + stack.length > 500_000) throw new Error("Session data exceeds the structural limits.");
      for (const value of Object.values(item.value)) stack.push({ value, depth: item.depth + 1 });
    }
  };
  checkData(header);
  for (const entry of values) {
    if (
      !entryTypes.has(String(entry.type)) ||
      !validId(entry.id) ||
      entries.has(entry.id) ||
      !timestamp(entry.timestamp) ||
      (entry.parentId !== null && (!validId(entry.parentId) || !entries.has(entry.parentId)))
    )
      throw new Error("Invalid session entry, duplicate ID, orphan, cycle, or unsupported entry type.");
    const requireReference = (value: unknown, self = false): void => {
      if (!validId(value) || (!entries.has(value) && !(self && value === entry.id)))
        throw new Error("Invalid session entry reference.");
    };
    switch (entry.type) {
      case "message":
        validateMessage(entry.message);
        break;
      case "model_change":
        strings(entry, ["provider", "modelId"]);
        break;
      case "thinking_level_change":
        if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(String(entry.thinkingLevel)))
          throw new Error("Invalid thinking level.");
        break;
      case "usage":
        strings(entry, ["kind", "provider", "model"]);
        usage(entry.usage);
        break;
      case "compaction":
        strings(entry, ["summary"]);
        if (!Number.isFinite(entry.tokensBefore) || Number(entry.tokensBefore) < 0)
          throw new Error("Invalid compaction size.");
        requireReference(entry.firstKeptEntryId, true);
        if (entry.firstKeptEntryId !== entry.id && !branchContains(entry.parentId, entry.firstKeptEntryId))
          throw new Error("Compaction refers outside its branch.");
        if (entry.systemMessage !== undefined) {
          validateMessage(entry.systemMessage);
          if (!record(entry.systemMessage) || entry.systemMessage.role !== "system")
            throw new Error("Invalid compaction system checkpoint.");
        }
        break;
      case "context_edit":
        requireReference(entry.targetId);
        if (
          !branchContains(entry.parentId, entry.targetId) ||
          !(entry.replacement === null || typeof entry.replacement === "string" || Array.isArray(entry.replacement))
        )
          throw new Error("Invalid context edit target or replacement.");
        {
          const target = entries.get(String(entry.targetId));
          const message = target?.type === "message" && record(target.message) ? target.message : undefined;
          if (
            target?.type !== "custom_message" &&
            (!message || !["user", "assistant", "toolResult", "custom"].includes(String(message.role)))
          )
            throw new Error("Invalid context edit target type.");
          if (entry.replacement !== null)
            content(
              entry.replacement,
              message?.role === "assistant" ? ["text", "thinking", "toolCall"] : ["text", "image"],
            );
        }
        break;
      case "branch_summary":
        strings(entry, ["summary"]);
        if (entry.fromId !== null) requireReference(entry.fromId);
        break;
      case "custom":
        strings(entry, ["customType"]);
        break;
      case "custom_message":
        strings(entry, ["customType"]);
        content(entry.content);
        if (typeof entry.display !== "boolean") throw new Error("Invalid custom display flag.");
        break;
      case "label":
        requireReference(entry.targetId);
        if (entry.label !== undefined && typeof entry.label !== "string") throw new Error("Invalid label.");
        break;
      case "session_info":
        strings(entry, ["name"]);
        break;
    }
    if (entry.usage !== undefined) usage(entry.usage);
    checkData(entry);
    entries.set(entry.id, entry);
  }
  return { header: { id: header.id, cwd: header.cwd, version: 3 }, entries: values };
}

export async function readTransferFile(filename: string, maxBytes = maxSessionTransferBytes): Promise<Buffer> {
  if (!path.isAbsolute(filename) || filename.includes("\0") || (await realpath(filename)) !== filename)
    throw new Error("Select a regular file without symbolic links or path aliases.");
  const bytes = await readWorkspaceFile(path.dirname(filename), path.basename(filename), maxBytes);
  if (!bytes) throw new Error("The selected file no longer exists.");
  return bytes;
}
export async function assertTransferWorkspace(session: ValidatedSession, cwd: string): Promise<void> {
  if ((await realpath(session.header.cwd)) !== (await realpath(cwd)))
    throw new Error("This session belongs to another workspace. Open its working directory before importing it.");
}

/** Never overwrite an existing name, follow a link, or remove a failed output automatically. */
export async function writeTransferFile(filename: string, bytes: Buffer): Promise<void> {
  if (
    !path.isAbsolute(filename) ||
    filename.includes("\0") ||
    (await realpath(path.dirname(filename))) !== path.dirname(filename)
  )
    throw new Error("Select a destination directory without symbolic links or path aliases.");
  const parent = await lstat(path.dirname(filename));
  const handle = await open(
    filename,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const named = await lstat(filename);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || named.ino !== opened.ino || named.dev !== opened.dev)
      throw new Error("The destination changed before writing.");
    const beforeWrite = await lstat(path.dirname(filename));
    if (
      beforeWrite.dev !== parent.dev ||
      beforeWrite.ino !== parent.ino ||
      (await realpath(path.dirname(filename))) !== path.dirname(filename)
    )
      throw new Error("The destination directory changed before writing.");
    await handle.writeFile(bytes);
    await handle.sync();
    const after = await lstat(path.dirname(filename));
    const target = await lstat(filename);
    if (
      after.dev !== parent.dev ||
      after.ino !== parent.ino ||
      target.ino !== opened.ino ||
      target.dev !== opened.dev ||
      !target.isFile() ||
      target.nlink !== 1 ||
      !(await readTransferFile(filename, bytes.length)).equals(bytes)
    )
      throw new Error("The destination changed during writing.");
  } catch {
    throw new Error(
      `The local write could not be verified. Inspect the retained output at ${filename}. Nothing was overwritten or removed.`,
    );
  } finally {
    await handle.close();
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function validId(value: unknown): value is string {
  return typeof value === "string" && idPattern.test(value);
}
function timestamp(value: unknown): boolean {
  return typeof value === "string" && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
}
function strings(value: Record<string, unknown>, keys: string[]): void {
  if (keys.some((key) => typeof value[key] !== "string")) throw new Error("Missing session entry text.");
}
function content(value: unknown, allowed = ["text", "image"]): void {
  if (typeof value === "string") return;
  if (!Array.isArray(value)) throw new Error("Invalid session content.");
  for (const block of value) {
    if (!record(block) || !allowed.includes(String(block.type)))
      throw new Error("Invalid content block for its message role.");
    switch (block.type) {
      case "text":
        strings(block, ["text"]);
        break;
      case "image":
        strings(block, ["data", "mimeType"]);
        break;
      case "thinking":
        if (
          typeof block.thinking !== "string" &&
          !(block.redacted === true && typeof block.thinkingSignature === "string")
        )
          throw new Error("Invalid thinking block.");
        break;
      case "toolCall":
        strings(block, ["id", "name"]);
        if (!record(block.arguments)) throw new Error("Invalid tool arguments.");
        break;
      default:
        throw new Error("Unsupported content block.");
    }
  }
}
function usage(value: unknown): void {
  if (
    !record(value) ||
    !record(value.cost) ||
    ["input", "output", "cacheRead", "cacheWrite", "totalTokens"].some(
      (key) => !Number.isFinite(value[key]) || Number(value[key]) < 0,
    ) ||
    ["input", "output", "cacheRead", "cacheWrite", "total"].some(
      (key) =>
        !Number.isFinite((value.cost as Record<string, unknown>)[key]) ||
        Number((value.cost as Record<string, unknown>)[key]) < 0,
    )
  )
    throw new Error("Invalid session usage.");
}
function validateMessage(value: unknown): void {
  if (
    !record(value) ||
    typeof value.role !== "string" ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  )
    throw new Error("Invalid session message.");
  if (value.role === "bashExecution") {
    strings(value, ["command", "output"]);
    if (typeof value.cancelled !== "boolean" || typeof value.truncated !== "boolean")
      throw new Error("Invalid shell entry.");
  } else if (value.role === "branchSummary" || value.role === "compactionSummary") strings(value, ["summary"]);
  else {
    if (!["system", "user", "assistant", "toolResult", "custom"].includes(value.role))
      throw new Error("Unsupported message role.");
    content(
      value.content,
      value.role === "assistant"
        ? ["text", "thinking", "toolCall"]
        : value.role === "system"
          ? ["text"]
          : ["text", "image"],
    );
    if (value.role === "assistant") {
      strings(value, ["api", "provider", "model"]);
      if (
        !Array.isArray(value.content) ||
        !["stop", "length", "toolUse", "error", "aborted", "deferred"].includes(String(value.stopReason))
      )
        throw new Error("Invalid finalized assistant message.");
      usage(value.usage);
    }
    if (value.role === "toolResult") {
      strings(value, ["toolCallId", "toolName"]);
      if (!Array.isArray(value.content) || typeof value.isError !== "boolean") throw new Error("Invalid tool result.");
    }
    if (value.role === "custom") {
      strings(value, ["customType"]);
      if (typeof value.display !== "boolean") throw new Error("Invalid custom message.");
    }
  }
}
