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
