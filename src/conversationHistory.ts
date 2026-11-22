import type { SidebarMessage } from "./sidebarState";

// History cursors are source-array offsets, not session paths or Pi entry IDs.
export interface ConversationHistoryWindow {
  readonly mode: "latest" | "earlier";
  readonly start: number;
  readonly end: number;
  readonly total: number;
  readonly omittedBefore: number;
  readonly omittedAfter: number;
  readonly truncated: boolean;
}

export interface ConversationHistoryState extends ConversationHistoryWindow {
  readonly generation: number;
  readonly available: boolean;
  readonly loading: boolean;
  readonly canNavigate: boolean;
}

export interface ConversationHistoryPage {
  readonly window: ConversationHistoryWindow;
  readonly messages: SidebarMessage[];
}

// Each controller owns at most three display pages (not raw RPC records or image bytes).
// The interactive-session limit bounds this to at most 15 MiB of estimated page data per Extension Host.
const pageBudget = 1_500_000;
const pageCount = 3;

export class ConversationHistoryPages {
  private readonly pages = new Map<number | undefined, { page: ConversationHistoryPage; cost: number }>();
  private bytes = 0;
  private origin: string | undefined;

  public bind(origin: string): void {
    if (origin !== this.origin) this.clear();
    this.origin = origin;
  }

  public get(before: number | undefined, assetAvailable: (id: string) => boolean): ConversationHistoryPage | undefined {
    const entry = this.pages.get(before);
    if (!entry) return undefined;
    if (
      entry.page.messages.some((message) =>
        message.attachments?.some(
          (attachment) =>
            attachment.type === "image" &&
            (attachment.availability === "available") !== assetAvailable(attachment.assetId),
        ),
      )
    )
      return undefined;
    this.pages.delete(before);
    this.pages.set(before, entry);
    return entry.page;
  }

  public remember(before: number | undefined, page: ConversationHistoryPage): void {
    const cost = JSON.stringify(page).length * 2 + page.messages.length * 256;
    if (cost > pageBudget) return;
    this.bytes -= this.pages.get(before)?.cost ?? 0;
    this.pages.delete(before);
    for (const [key, entry] of this.pages) {
      if (this.pages.size < pageCount && this.bytes + cost <= pageBudget) break;
      this.pages.delete(key);
      this.bytes -= entry.cost;
    }
    this.pages.set(before, { page, cost });
    this.bytes += cost;
  }

  public clear(): void {
    this.pages.clear();
    this.bytes = 0;
  }
}

export function emptyConversationHistory(): ConversationHistoryWindow {
  return { mode: "latest", start: 0, end: 0, total: 0, omittedBefore: 0, omittedAfter: 0, truncated: false };
}

export function historyRequestIsCurrent(
  captured: { readonly generation: number; readonly session: string },
  current: { readonly generation: number; readonly session: string; readonly busy: boolean },
): boolean {
  return captured.generation === current.generation && captured.session === current.session && !current.busy;
}
