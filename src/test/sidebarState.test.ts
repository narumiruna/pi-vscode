import assert from "node:assert/strict";
import {
  historySyncFailureState,
  limitSidebarMessages,
  persistableSidebarMessages,
  restoreSidebarMessages,
  shortTranscriptLabel,
  sidebarMessagesForWebview,
  type SidebarMessage,
} from "../sidebarState";

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

test("restore accepts legacy text-only records and converts the legacy context label", () => {
  const expected = {
    role: "user" as const,
    content: "hello",
    attachments: [{ type: "context" as const, label: "src/legacy.ts:1-2", fullLabel: "src/legacy.ts:1-2" }],
  };
  assert.deepEqual(restoreSidebarMessages([
    { id: "legacy", role: "user", content: "hello", contextLabel: "src/legacy.ts:1-2" },
    { id: "malformed", role: "user", content: "hello", contextLabel: "src/legacy.ts:1-2", attachments: "invalid" },
  ], 10, 100), [
    { id: "legacy", ...expected },
    { id: "malformed", ...expected },
  ]);
});

test("restore rejects malformed transcript metadata, bounds descriptors, and never restores payload bytes", () => {
  const assetId = `sha256-${"a".repeat(64)}`;
  const attachments = [
    { type: "context", label: "ok", fullLabel: "src/ok.ts" },
    { type: "context", label: "x".repeat(81), fullLabel: "too long" },
    { type: "image", assetId, label: "photo.png", fullLabel: "photos/photo.png", mimeType: "image/png", width: 2, height: 3, availability: "available", data: "must-not-survive" },
    { type: "image", assetId: "unsafe", label: "bad", fullLabel: "bad", mimeType: "image/svg+xml", availability: "available" },
  ];
  const restored = restoreSidebarMessages([{ id: "m", role: "user", content: "look", attachments }], 10, 100);
  assert.deepEqual(restored[0]?.attachments, [
    { type: "context", label: "ok", fullLabel: "src/ok.ts" },
    { type: "image", assetId, label: "photo.png", fullLabel: "photos/photo.png", mimeType: "image/png", width: 2, height: 3, availability: "unavailable" },
  ]);
  assert.doesNotMatch(JSON.stringify(persistableSidebarMessages(restored)), /must-not-survive|data/);
  const streamed = sidebarMessagesForWebview(restored, () => true);
  assert.doesNotMatch(JSON.stringify(streamed), /must-not-survive|data/);
  const streamedImage = streamed[0]?.attachments?.[1];
  assert.equal(streamedImage?.type === "image" && streamedImage.availability, "available");
});

test("restore caps transcript descriptor and image counts", () => {
  const contexts = Array.from({ length: 10 }, (_, index) => ({ type: "context", label: `c${index}`, fullLabel: `context-${index}` }));
  const restored = restoreSidebarMessages([{ id: "bounded", role: "user", content: "request", attachments: contexts }], 10, 100);
  assert.equal(restored[0]?.attachments?.length, 8);
});

test("transcript labels are single-line and preserve long path suffixes within bounds", () => {
  const label = `folder/${"nested/".repeat(80)}file.ts:100-200`;
  const short = shortTranscriptLabel(label);
  assert.equal(short.length, 80);
  assert.match(short, /^…/);
  assert.match(short, /file\.ts:100-200$/);
  assert.equal(shortTranscriptLabel("line\nname"), "line name");

  const restored = restoreSidebarMessages([{ id: "legacy", role: "user", content: "hello", contextLabel: label }], 10, 100);
  const context = restored[0]?.attachments?.[0];
  assert.equal(context?.type, "context");
  if (context?.type !== "context") assert.fail("expected a restored context attachment");
  assert.equal(context.fullLabel.length, 500);
  assert.match(context.fullLabel, /^folder\//);
  assert.match(context.fullLabel, /file\.ts:100-200$/);
  assert.match(context.label, /file\.ts:100-200$/);
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
