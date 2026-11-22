import assert from "node:assert/strict";
import { limitSidebarMessages, type SidebarMessage } from "../sidebarState";
import { assistantTextTail, patchRetainedTranscript } from "../sidebarTranscript";

const user: SidebarMessage = { id: "user", role: "user", content: "Start" };
const before: SidebarMessage = { id: "reply", role: "assistant", content: "First" };
const after = { ...before, content: "First tail" };

test("only text replacement of the same final assistant can use a transcript patch", () => {
  assert.equal(assistantTextTail([user, before], [{ ...user }, after], before.id), after);
  for (const next of [
    [user, after, { ...user, id: "next" }],
    [after],
    [{ ...user, content: "Changed" }, after],
    [user, { ...after, id: "new" }],
    [user, { ...after, truncated: true as const }],
    [user, { ...after, thinking: [{ contentIndex: 1, text: "Thinking" }] }],
    limitSidebarMessages([user, after], 100, 12),
  ]) {
    assert.equal(assistantTextTail([user, before], next, before.id), undefined);
  }
  assert.equal(assistantTextTail([user, before], [user, after], "a different stream"), undefined);
});

test("applying a retained patch preserves prior messages and other state without mutating the snapshot", () => {
  const state = {
    transcriptRevision: 1,
    status: "Working",
    messages: [user, { ...before, html: "<p>First</p>" }],
  };
  const patch = { baseRevision: 1, id: before.id, content: after.content, html: "<p>First tail</p>" };
  const updated = patchRetainedTranscript(state, patch);
  assert.deepEqual(updated, {
    ...state,
    transcriptRevision: 2,
    messages: [user, { ...after, html: patch.html }],
  });
  assert.equal(state.messages.at(-1)?.content, before.content);
  assert.equal(patchRetainedTranscript(updated, patch), undefined);
  assert.equal(patchRetainedTranscript(state, { ...patch, baseRevision: 3 }), undefined);
  assert.equal(patchRetainedTranscript(state, { ...patch, id: user.id }), undefined);
});
