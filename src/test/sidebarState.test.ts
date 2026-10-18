import assert from "node:assert/strict";
import { extensionUiLimits, SidebarExtensionUi } from "../sidebarExtensionUi";
import {
  historySyncFailureState,
  limitSidebarMessages,
  persistableSidebarMessages,
  restoreSidebarMessages,
  runtimeNoticeSummary,
  type SidebarMessage,
  shortTranscriptLabel,
  sidebarMessagesForWebview,
} from "../sidebarState";

test("extension UI preserves keyed order, replacement, removal, empty widgets and placements", () => {
  const ui = new SidebarExtensionUi();
  const status = (statusKey: string, statusText?: unknown) => ui.update({ method: "setStatus", statusKey, statusText });
  const widget = (widgetKey: string, widgetLines?: unknown, widgetPlacement?: unknown) =>
    ui.update({ method: "setWidget", widgetKey, widgetLines, widgetPlacement });
  assert.equal(status("second", "two"), true);
  status("first", "one");
  status("second", "updated");
  assert.deepEqual(ui.state.statuses, [
    { key: "second", text: "updated" },
    { key: "first", text: "one" },
  ]);
  assert.equal(status("second", "updated"), false, "identical updates do not change visible state");
  widget("default", ["one", "two"]);
  widget("below", ["below"], "belowEditor");
  widget("empty", []);
  assert.deepEqual(ui.state.widgets, [
    { key: "default", lines: ["one", "two"], placement: "aboveEditor" },
    { key: "below", lines: ["below"], placement: "belowEditor" },
    { key: "empty", lines: [], placement: "aboveEditor" },
  ]);
  assert.equal(widget("default", ["one", "two"], "aboveEditor"), false);
  widget("default", ["replacement"], "belowEditor");
  status("second");
  widget("below");
  assert.equal(status("absent"), false);
  assert.deepEqual(
    ui.state.statuses.map((entry) => entry.key),
    ["first"],
  );
  assert.deepEqual(
    ui.state.widgets.map((entry) => entry.key),
    ["default", "empty"],
  );
  status("__proto__", "safe map key");
  assert.equal(ui.state.statuses.at(-1)?.key, "__proto__");
  ui.clear();
  assert.deepEqual(ui.state, { statuses: [], widgets: [] });
});

test("extension UI removes ANSI, OSC, string controls and bidi while keeping inert source text", () => {
  const ui = new SidebarExtensionUi();
  const source = "<script>alert(1)</script> **text** [link](command:workbench.action.closeWindow)";
  ui.update({
    method: "setStatus",
    statusKey: "raw\u001b[31mkey",
    statusText: `\u001b[31m${source}\u001b[0m\u0008\u202e`,
  });
  ui.update({
    method: "setWidget",
    widgetKey: "raw",
    widgetLines: [
      "\u001b]8;;https://example.invalid\u0007visible\u001b]8;;\u001b\\",
      "before\u001b]52;c;secret\u0007after",
      "\u009d0;title\u009ctext\u001bPprivate\u001b\\end",
      "start\u001b]unterminated payload",
      "\u001b[2Jline\r\n\tend",
    ],
  });
  assert.deepEqual(ui.state.statuses, [{ key: "rawkey", text: source }]);
  assert.deepEqual(ui.state.widgets[0]?.lines, ["visible", "beforeafter", "textend", "start", "lineend"]);
  ui.update({ method: "setStatus", statusKey: "raw\u001b[31mkey" });
  assert.equal(ui.state.statuses.length, 0, "raw protocol keys remain removal identities");
});

test("extension UI rejects malformed records, exact bounds and floods without evicting earlier state", () => {
  assert.deepEqual(extensionUiLimits, {
    statusKeys: 16,
    widgetKeys: 16,
    keyCharacters: 128,
    lines: 20,
    lineCharacters: 1000,
    retainedCharacters: 32000,
  });
  const ui = new SidebarExtensionUi();
  ui.update({ method: "setWidget", widgetKey: "kept", widgetLines: ["kept"] });
  const invalid = [
    { method: "setStatus", statusKey: "", statusText: "x" },
    { method: "setStatus", statusKey: "k".repeat(129), statusText: "x" },
    { method: "setStatus", statusKey: "key", statusText: null },
    { method: "setStatus", statusKey: "key", statusText: "x".repeat(1001) },
    { method: "setWidget", widgetKey: "kept", widgetLines: "not array" },
    { method: "setWidget", widgetKey: "kept", widgetLines: [null] },
    { method: "setWidget", widgetKey: "kept", widgetLines: Array(21).fill("") },
    { method: "setWidget", widgetKey: "kept", widgetLines: ["x".repeat(1001)] },
    ...["invalid", null, false].map((widgetPlacement) => ({
      method: "setWidget",
      widgetKey: "kept",
      widgetLines: [],
      widgetPlacement,
    })),
  ];
  for (const event of invalid) ui.update(event);
  assert.deepEqual(ui.state.widgets[0]?.lines, ["kept"]);
  assert.ok(ui.state.diagnostic);
  assert.ok(ui.state.diagnostic.length < 120);
  assert.equal(ui.update(invalid[0]!), false, "one fixed diagnostic per generation, not a notice flood");
  ui.clear();
  ui.update({ method: "setStatus", statusKey: "k".repeat(128), statusText: "x".repeat(1000) });
  ui.update({ method: "setWidget", widgetKey: "k".repeat(128), widgetLines: Array(20).fill("x".repeat(1000)) });
  assert.equal(ui.state.statuses.length, 1);
  assert.equal(ui.state.widgets.length, 1);
  // Exactly 32,000 retained characters, counting both raw keys and text.
  ui.update({
    method: "setWidget",
    widgetKey: "tail",
    widgetLines: Array(10).fill("x".repeat(1000)).concat("x".repeat(740)),
  });
  assert.equal(ui.state.widgets.length, 2);
  ui.update({ method: "setStatus", statusKey: "overflow", statusText: "x" });
  assert.equal(ui.state.statuses.length, 1);
  ui.update({ method: "setWidget", widgetKey: "tail", widgetLines: [] });
  ui.update({ method: "setStatus", statusKey: "overflow", statusText: "x" });
  assert.equal(ui.state.statuses.length, 2, "replacement releases its previous budget");
  ui.clear();
  for (let index = 0; index < 10_000; index++) {
    ui.update({ method: "setStatus", statusKey: String(index), statusText: "x" });
    ui.update({ method: "setWidget", widgetKey: String(index), widgetLines: [] });
  }
  assert.equal(ui.state.statuses.length, 16);
  assert.equal(ui.state.widgets.length, 16);
  assert.equal(ui.state.statuses[0]?.key, "0");
  assert.equal(ui.state.widgets[0]?.key, "0");
});

test("runtime notices use bounded known causes and never interpolate diagnostics", () => {
  const unknown = runtimeNoticeSummary({ type: "runtime_warning", warningCode: "/secret/path <script>" });
  assert.match(unknown, /View diagnostic/);
  assert.doesNotMatch(unknown, /secret|script/);
  assert.match(runtimeNoticeSummary({ type: "protocol_error" }), /invalid response.*View diagnostic/);
  for (const [code, expected] of [
    ["session-replaced", /new session was started/],
    ["state-refresh", /Reconnect.*do not repeat/],
    ["deleted-cleanup", /deleted.*View diagnostic/],
    ["cleanup-unverified", /cleanup is unverified/],
    ["queue-delivered", /do not resend/],
    ["queue-uncertain", /Check history.*nothing is replayed automatically/],
  ] as const) {
    const summary = runtimeNoticeSummary({ type: "runtime_warning", warningCode: code });
    assert.match(summary, expected);
    assert.ok(summary.length < 160);
    assert.doesNotMatch(summary, /safe to|can continue|retry now/i);
    if (code === "cleanup-unverified") assert.doesNotMatch(summary, /stopped responding/);
  }
});

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

test("thinking shares the retained text budget but never enters workspace persistence or restore", () => {
  const limited = limitSidebarMessages(
    [
      { id: "old", role: "user", content: "older" },
      { id: "assistant", role: "assistant", content: "answer", thinking: [{ contentIndex: 0, text: "reasoning" }] },
    ],
    100,
    10,
  );
  assert.equal(limited.length, 1);
  assert.equal(limited[0]?.content, "answer");
  assert.deepEqual(limited[0]?.thinking, [{ contentIndex: 0, text: "reas", truncated: true }]);
  const persisted = persistableSidebarMessages(limited);
  assert.doesNotMatch(JSON.stringify(persisted), /thinking|reas|contentIndex/);
  // Untrusted cache fields, including signatures and visible thinking, are never restored.
  const restored = restoreSidebarMessages([{ ...limited[0], thinkingSignature: "secret" }], 100, 100);
  assert.equal(restored[0]?.thinking, undefined);
  assert.doesNotMatch(JSON.stringify(restored), /secret|reas/);
  assert.deepEqual(sidebarMessagesForWebview(limited, () => false)[0]?.thinking, limited[0]?.thinking);
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
  assert.deepEqual(
    restoreSidebarMessages(
      [
        { id: "legacy", role: "user", content: "hello", contextLabel: "src/legacy.ts:1-2" },
        { id: "malformed", role: "user", content: "hello", contextLabel: "src/legacy.ts:1-2", attachments: "invalid" },
      ],
      10,
      100,
    ),
    [
      { id: "legacy", ...expected },
      { id: "malformed", ...expected },
    ],
  );
});

test("restore rejects malformed transcript metadata, bounds descriptors, and never restores payload bytes", () => {
  const assetId = `sha256-${"a".repeat(64)}`;
  const attachments = [
    { type: "context", label: "ok", fullLabel: "src/ok.ts" },
    { type: "context", label: "x".repeat(81), fullLabel: "too long" },
    {
      type: "image",
      assetId,
      label: "photo.png",
      fullLabel: "photos/photo.png",
      mimeType: "image/png",
      width: 2,
      height: 3,
      availability: "available",
      data: "must-not-survive",
    },
    {
      type: "image",
      assetId: "unsafe",
      label: "bad",
      fullLabel: "bad",
      mimeType: "image/svg+xml",
      availability: "available",
    },
  ];
  const restored = restoreSidebarMessages([{ id: "m", role: "user", content: "look", attachments }], 10, 100);
  assert.deepEqual(restored[0]?.attachments, [
    { type: "context", label: "ok", fullLabel: "src/ok.ts" },
    {
      type: "image",
      assetId,
      label: "photo.png",
      fullLabel: "photos/photo.png",
      mimeType: "image/png",
      width: 2,
      height: 3,
      availability: "unavailable",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(persistableSidebarMessages(restored)), /must-not-survive|data/);
  const streamed = sidebarMessagesForWebview(restored, () => true);
  assert.doesNotMatch(JSON.stringify(streamed), /must-not-survive|data/);
  const streamedImage = streamed[0]?.attachments?.[1];
  assert.equal(streamedImage?.type === "image" && streamedImage.availability, "available");
});

test("restore caps transcript descriptor and image counts", () => {
  const contexts = Array.from({ length: 10 }, (_, index) => ({
    type: "context",
    label: `c${index}`,
    fullLabel: `context-${index}`,
  }));
  const restored = restoreSidebarMessages(
    [{ id: "bounded", role: "user", content: "request", attachments: contexts }],
    10,
    100,
  );
  assert.equal(restored[0]?.attachments?.length, 8);
});

test("transcript labels are single-line and preserve long path suffixes within bounds", () => {
  const label = `folder/${"nested/".repeat(80)}file.ts:100-200`;
  const short = shortTranscriptLabel(label);
  assert.equal(short.length, 80);
  assert.match(short, /^…/);
  assert.match(short, /file\.ts:100-200$/);
  assert.equal(shortTranscriptLabel("line\nname"), "line name");

  const restored = restoreSidebarMessages(
    [{ id: "legacy", role: "user", content: "hello", contextLabel: label }],
    10,
    100,
  );
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
