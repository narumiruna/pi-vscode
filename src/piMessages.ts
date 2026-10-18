/** Text shown in live responses and transcript history; queue matching has separate framing. */
export function piMessageContentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part) => typeof part === "object" && part !== null && part.type === "text" && typeof part.text === "string",
    )
    .map((part) => String(part.text))
    .join("\n");
}

export const maxVisibleThinkingBlocks = 128;
export const maxVisibleThinkingCharacters = 250_000;

/** Presentation only. Provider signatures must never be copied into this type. */
export interface VisibleThinkingBlock {
  readonly contentIndex: number;
  readonly text: string;
  readonly redacted?: true;
  readonly truncated?: true;
}

export function visibleThinkingText(text: string): string {
  return text.replace(/[\p{Cc}\u202a-\u202e\u2066-\u2069]/gu, (character) =>
    character === "\n" || character === "\t" ? character : "",
  );
}

export function piMessageThinking(content: unknown): VisibleThinkingBlock[] {
  if (!Array.isArray(content)) return [];
  const blocks: VisibleThinkingBlock[] = [];
  let remaining = maxVisibleThinkingCharacters;
  for (let contentIndex = 0; contentIndex < content.length; contentIndex += 1) {
    const part: unknown = content[contentIndex];
    if (typeof part !== "object" || part === null || !("type" in part) || part.type !== "thinking") continue;
    if (blocks.length >= maxVisibleThinkingBlocks) {
      const last = blocks.at(-1);
      if (last) blocks[blocks.length - 1] = { ...last, truncated: true };
      break;
    }
    if ("redacted" in part && part.redacted !== undefined && typeof part.redacted !== "boolean") continue;
    if ("redacted" in part && part.redacted === true) {
      blocks.push({ contentIndex, text: "", redacted: true });
    } else if ("thinking" in part && typeof part.thinking === "string") {
      const text = visibleThinkingText(part.thinking.slice(0, remaining));
      if (text || part.thinking.length > remaining) {
        blocks.push({ contentIndex, text, ...(part.thinking.length > remaining ? { truncated: true } : {}) });
        remaining -= text.length;
      }
    }
  }
  return blocks;
}
