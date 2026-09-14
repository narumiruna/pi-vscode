import assert from "node:assert/strict";
import { historySyncFailureState, limitSidebarMessages, type SidebarMessage } from "../sidebarState";

const messages: SidebarMessage[] = [
  { id: "1", role: "user", content: "oldest" },
  { id: "2", role: "assistant", content: "middle" },
  { id: "3", role: "user", content: "newest-request", contextLabel: "src/app.ts:1-3" },
];

test("limitSidebarMessages keeps the newest message count", () => {
  assert.deepEqual(limitSidebarMessages(messages, 2, 100), messages.slice(-2));
});

test("limitSidebarMessages bounds total content and preserves metadata", () => {
  assert.deepEqual(limitSidebarMessages(messages, 10, 10), [
    {
      id: "3",
      role: "user",
      content: "st-request",
      contextLabel: "src/app.ts:1-3",
      truncated: true,
    },
  ]);
});

test("limitSidebarMessages handles disabled limits", () => {
  assert.deepEqual(limitSidebarMessages(messages, 0, 100), []);
  assert.deepEqual(limitSidebarMessages(messages, 10, 0), []);
});

test("history synchronization failures expose the available recovery path", () => {
  assert.deepEqual(historySyncFailureState(true), {
    status: "History unavailable · Refresh available",
    historyRecoveryAvailable: true,
  });
  assert.deepEqual(historySyncFailureState(false), {
    status: "Disconnected · Reconnect available",
    historyRecoveryAvailable: false,
  });
});
