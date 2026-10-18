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

export function emptyConversationHistory(): ConversationHistoryWindow {
  return { mode: "latest", start: 0, end: 0, total: 0, omittedBefore: 0, omittedAfter: 0, truncated: false };
}

export function historyRequestIsCurrent(
  captured: { readonly generation: number; readonly session: string },
  current: { readonly generation: number; readonly session: string; readonly busy: boolean },
): boolean {
  return captured.generation === current.generation && captured.session === current.session && !current.busy;
}
