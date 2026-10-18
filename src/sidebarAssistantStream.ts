import { maxVisibleThinkingBlocks, piMessageContentText, piMessageThinking, visibleThinkingText } from "./piMessages";
import { limitSidebarMessages, type SidebarMessage } from "./sidebarState";

interface StreamBlock {
  readonly type: "text" | "thinking";
  readonly text: string;
  readonly truncated: boolean;
}

/** One assistant message. Only allowlisted visible fields enter retained stream state. */
export class SidebarAssistantStream {
  private readonly blocks = new Map<number, StreamBlock>();
  private omitted = false;

  public constructor(
    public readonly id: string,
    private readonly maxCharacters: number,
  ) {}

  public update(value: unknown): SidebarMessage | undefined {
    if (typeof value !== "object" || value === null) return undefined;
    const update = value as Record<string, unknown>;
    if (typeof update.type !== "string" || !/^(text|thinking)_(start|delta|end)$/.test(update.type)) return undefined;
    if (!Number.isSafeInteger(update.contentIndex) || Number(update.contentIndex) < 0) return undefined;
    const index = Number(update.contentIndex);
    const type = update.type.startsWith("thinking_") ? "thinking" : "text";
    const previous = this.blocks.get(index);
    if (previous && previous.type !== type) return undefined;
    if (!previous && this.blocks.size >= maxVisibleThinkingBlocks) {
      this.omitted = true;
      return this.snapshot();
    }
    const end = update.type.endsWith("_end");
    const delta = update.type.endsWith("_delta");
    const input = end ? update.content : delta ? update.delta : "";
    if (typeof input !== "string") return undefined;
    // Duplicate starts must not erase accumulated deltas.
    if (!end && !delta && previous) return this.snapshot();
    const oldText = delta ? (previous?.text ?? "") : "";
    const used = [...this.blocks.values()].reduce((sum, block) => sum + block.text.length, 0);
    const room = Math.max(0, this.maxCharacters - used + (previous?.text.length ?? 0) - oldText.length);
    const incoming = input.slice(0, room);
    const text = oldText + (type === "thinking" ? visibleThinkingText(incoming) : incoming);
    this.blocks.set(index, {
      type,
      text,
      truncated: (delta && previous?.truncated === true) || input.length > room,
    });
    return this.snapshot();
  }

  public complete(content: unknown): SidebarMessage {
    this.blocks.clear();
    const thinking = piMessageThinking(content);
    return limitSidebarMessages(
      [
        {
          id: this.id,
          role: "assistant",
          content: piMessageContentText(content),
          ...(thinking.length ? { thinking } : {}),
        },
      ],
      1,
      this.maxCharacters,
    )[0]!;
  }

  private snapshot(): SidebarMessage {
    const entries = [...this.blocks.entries()].sort(([left], [right]) => left - right);
    const thinking = entries.flatMap(([contentIndex, block]) =>
      block.type === "thinking"
        ? [{ contentIndex, text: block.text, ...(block.truncated ? { truncated: true as const } : {}) }]
        : [],
    );
    const textBlocks = entries.filter(([, block]) => block.type === "text");
    return limitSidebarMessages(
      [
        {
          id: this.id,
          role: "assistant",
          content: textBlocks.map(([, block]) => block.text).join("\n"),
          ...(thinking.length ? { thinking } : {}),
          ...(this.omitted || textBlocks.some(([, block]) => block.truncated) ? { truncated: true } : {}),
        },
      ],
      1,
      this.maxCharacters,
    )[0]!;
  }
}
