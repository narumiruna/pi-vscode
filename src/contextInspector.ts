export interface ContextMetadata {
  readonly revision: number;
  readonly capturedAt: number;
  readonly originalLength: number;
  readonly includedLength: number;
  readonly truncated: boolean;
  readonly pinned: boolean;
  readonly kind?: "text" | "debug" | "test";
  readonly sourceVersion?: number;
  readonly range?: {
    readonly startLine: number;
    readonly startCharacter: number;
    readonly endLine: number;
    readonly endCharacter: number;
  };
}
export interface InspectableContext {
  readonly id: string;
  readonly label: string;
  readonly content?: string;
  readonly image?: { readonly data: string; readonly mimeType: string };
  readonly metadata?: ContextMetadata;
  readonly uri?: { toString(): string };
}
export function contextMetadata(
  content: string,
  originalLength = content.length,
  revision = 1,
  extra: Partial<ContextMetadata> = {},
): ContextMetadata {
  const original =
    Number.isSafeInteger(originalLength) && originalLength >= content.length ? originalLength : content.length;
  return {
    ...extra,
    revision: Number.isSafeInteger(revision) && revision > 0 ? revision : 1,
    capturedAt: Date.now(),
    originalLength: original,
    includedLength: content.length,
    truncated: original > content.length,
    pinned: extra.pinned === true,
  };
}
export function contextWarnings(
  label: string,
  content: string,
  sensitiveNames: readonly string[] = [".env", "credential", "secret", "id_rsa", "id_ed25519"],
): string[] {
  const warnings: string[] = [];
  if (
    sensitiveNames
      .slice(0, 50)
      .some(
        (name) =>
          typeof name === "string" && name.length > 0 && label.toLowerCase().includes(name.slice(0, 100).toLowerCase()),
      )
  )
    warnings.push("Sensitive filename");
  if (
    /-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,})|(?:api[_-]?key|password|token)\s*[:=]\s*["']?[^\s"']{8,}/i.test(
      content,
    )
  )
    warnings.push("Possible secret pattern");
  return warnings;
}
export function inspectContext(items: readonly InspectableContext[]): {
  text: string;
  characters: number;
  bytes: number;
  estimatedTextTokens: number;
  imageUsage: string;
} {
  let characters = 0;
  let bytes = 0;
  let images = 0;
  const sections = items.map((item) => {
    const text = item.content ?? "";
    const itemBytes = Buffer.byteLength(text);
    characters += text.length;
    bytes += itemBytes;
    if (item.image) {
      images++;
      bytes += Buffer.byteLength(item.image.data, "base64");
    }
    const metadata = item.metadata;
    const excluded =
      metadata && Number.isSafeInteger(metadata.originalLength)
        ? Math.max(0, metadata.originalLength - text.length)
        : "unknown";
    const range = metadata?.range;
    const validRange =
      range &&
      [range.startLine, range.startCharacter, range.endLine, range.endCharacter].every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      ) &&
      (range.endLine > range.startLine ||
        (range.endLine === range.startLine && range.endCharacter >= range.startCharacter));
    const source = `Source: ${item.uri?.toString() ?? "local snapshot (no file source)"}; version ${metadata?.sourceVersion ?? "unknown"}; ${validRange ? `range ${range.startLine + 1}:${range.startCharacter + 1}–${range.endLine + 1}:${range.endCharacter + 1} (end exclusive)` : "whole item / range unavailable"}`;
    return `${item.label}\n${source}\nSnapshot ${item.id}; revision ${metadata?.revision ?? "unknown"}; capture ${metadata && Number.isFinite(metadata.capturedAt) && metadata.capturedAt >= 0 && metadata.capturedAt <= 8.64e15 ? new Date(metadata.capturedAt).toISOString() : "unknown"}\n${text.length} included characters / ${itemBytes} text bytes; ${excluded} excluded characters${metadata?.pinned ? "; pinned (refresh is explicit)" : ""}${item.image ? "; image usage unknown" : ""}\n${contextWarnings(item.label, text).join("; ")}\n\n${text}`;
  });
  const estimatedTextTokens = Math.ceil(
    items.reduce((sum, item) => sum + Buffer.byteLength(item.content ?? ""), 0) / 4,
  );
  const imageUsage = images ? "unknown" : "none";
  return {
    characters,
    bytes,
    estimatedTextTokens,
    imageUsage,
    text: `Attachment snapshots only — not Pi history, system instructions, or later tool reads.\n${characters} text characters; ${bytes} bytes including images.\nHeuristic text tokens ≈ ${estimatedTextTokens} (UTF-8 bytes / 4; not a provider token count or context-window estimate). Image usage: ${imageUsage}.\nSecret detection is best-effort, not a guarantee.\n\n${sections.join("\n\n---\n\n")}`,
  };
}
export function consumedUnpinnedIds(items: readonly InspectableContext[], consumed: readonly string[]): string[] {
  return items.filter((item) => consumed.includes(item.id) && !item.metadata?.pinned).map((item) => item.id);
}
