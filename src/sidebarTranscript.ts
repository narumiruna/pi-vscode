import { isDeepStrictEqual } from "node:util";
import type { SidebarMessage } from "./sidebarState";

export interface TranscriptTailPatch {
  readonly type: "transcriptTailPatch";
  readonly baseRevision: number;
  readonly id: string;
  readonly content: string;
  readonly html: string;
}

export function assistantTextTail(
  previous: readonly SidebarMessage[],
  current: readonly SidebarMessage[],
  streamId: string,
): SidebarMessage | undefined {
  const before = previous.at(-1);
  const after = current.at(-1);
  if (
    !before ||
    !after ||
    after.id !== streamId ||
    after.role !== "assistant" ||
    previous.length !== current.length ||
    !isDeepStrictEqual({ ...before, content: after.content }, after)
  )
    return undefined;
  for (let index = 0; index < current.length - 1; index += 1) {
    if (!isDeepStrictEqual(previous[index], current[index])) return undefined;
  }
  return after;
}

/** Keep a complete display snapshot for inactive Sidebar entries and visibility changes. */
export function patchRetainedTranscript(
  state: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (
    !state ||
    typeof patch.baseRevision !== "number" ||
    state.transcriptRevision !== patch.baseRevision ||
    !Array.isArray(state.messages) ||
    typeof patch.id !== "string" ||
    typeof patch.content !== "string" ||
    typeof patch.html !== "string"
  )
    return undefined;
  const tail = state.messages.at(-1);
  if (tail?.id !== patch.id || tail.role !== "assistant") return undefined;
  const messages = state.messages.slice();
  messages[messages.length - 1] = { ...tail, content: patch.content, html: patch.html };
  return { ...state, messages, transcriptRevision: patch.baseRevision + 1 };
}
