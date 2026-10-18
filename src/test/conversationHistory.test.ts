import assert from "node:assert/strict";
import {
  type ConversationHistoryWindow,
  emptyConversationHistory,
  historyRequestIsCurrent,
} from "../conversationHistory";
import { ImageAssetCache } from "../imageAssets";
import { installVscodeMock } from "./vscodeMock";

function cache(): ImageAssetCache {
  return new ImageAssetCache({ maxImageBytes: 100, maxTotalBytes: 1024, maxAssets: 10 });
}

function messages(count: number): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    timestamp: 42,
    content: [{ type: "text", text: `Message ${index}: duplicate label 日本語 🐈 [.*]` }],
  }));
}

test("bounded history replaces windows with source offsets and no duplicate-label ambiguity", () => {
  const mock = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const values = messages(205);
    let metadata: ConversationHistoryWindow = emptyConversationHistory();
    const options = {
      imageAssets: cache(),
      maxMessages: 100,
      maxCharacters: 250_000,
      onHistoryWindow: (window: ConversationHistoryWindow) => {
        metadata = window;
      },
    };
    const latest = convertPiMessages(values, options);
    assert.equal(latest.length, 100);
    assert.equal(metadata.start, 105);
    assert.equal(metadata.omittedBefore, 105);
    assert.equal(metadata.omittedAfter, 0);
    assert.equal(metadata.total, 205);
    const earlier = convertPiMessages(values, { ...options, historyBefore: metadata.start });
    assert.equal(earlier.length, 100);
    assert.equal(metadata.start, 5);
    assert.equal(metadata.omittedAfter, 100);
    assert.equal(metadata.mode, "earlier");
    assert.match(earlier[0]!.content, /Message 5:/);
    assert.equal(new Set(earlier.map((message) => message.id)).size, 100);
    const oldest = convertPiMessages(values, { ...options, historyBefore: metadata.start });
    assert.equal(oldest.length, 5);
    assert.equal(metadata.omittedBefore, 0);
    assert.equal(metadata.omittedAfter, 200);
    assert.deepEqual(convertPiMessages(values, options), latest);
    const overlapping = convertPiMessages(values, { ...options, historyBefore: 200 });
    const knownIds = new Map(latest.map((message) => [message.content, message.id]));
    for (const message of overlapping) {
      if (knownIds.has(message.content)) assert.equal(message.id, knownIds.get(message.content));
    }
  } finally {
    mock.restore();
  }
});

test("character-bound windows expose omitted long-message text and permit earlier message navigation", () => {
  const mock = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const values = [...messages(110), { role: "assistant", content: [{ type: "text", text: "x".repeat(300_000) }] }];
    let metadata = emptyConversationHistory();
    const options = {
      imageAssets: cache(),
      maxMessages: 100,
      maxCharacters: 250_000,
      onHistoryWindow: (window: ConversationHistoryWindow) => {
        metadata = window;
      },
    };
    const latest = convertPiMessages(values, options);
    assert.equal(latest.length, 1);
    assert.equal(latest[0]!.content.length, 250_000);
    assert.equal(latest[0]!.truncated, true);
    assert.equal(metadata.truncated, true);
    assert.equal(metadata.start, 110);
    const earlier = convertPiMessages(values, { ...options, historyBefore: metadata.start });
    assert.equal(earlier.length, 100);
    assert.match(earlier[0]!.content, /Message 10:/);
    assert.ok(earlier.reduce((sum, message) => sum + message.content.length, 0) <= 250_000);
  } finally {
    mock.restore();
  }
});

test("history counts only displayable entries and shares bounds with thinking and shell", () => {
  const mock = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    let metadata = emptyConversationHistory();
    const converted = convertPiMessages(
      [
        { role: "toolResult", content: [{ type: "text", text: "excluded tool details" }] },
        { role: "assistant", content: [{ type: "thinking", thinking: "visible thought" }] },
        {
          role: "bashExecution",
          command: "echo fixture",
          output: "x".repeat(300_000),
          exitCode: 0,
          cancelled: false,
          truncated: false,
        },
      ],
      {
        imageAssets: cache(),
        maxMessages: 100,
        maxCharacters: 250_000,
        onHistoryWindow: (window) => {
          metadata = window;
        },
      },
    );
    assert.equal(metadata.total, 2);
    assert.ok(
      converted.reduce(
        (sum, message) =>
          sum +
          message.content.length +
          (message.thinking ?? []).reduce((length, block) => length + block.text.length, 0),
        0,
      ) <= 250_000,
    );
    assert.equal(metadata.truncated, true);
  } finally {
    mock.restore();
  }
});

test("history action validation rejects invalid generations and directions", () => {
  const mock = installVscodeMock();
  try {
    const { isWebviewMessage } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    assert.equal(isWebviewMessage({ type: "historyWindow", direction: "earlier", generation: 4 }, 100), true);
    for (const generation of [-1, NaN, Infinity, "4", 0.5]) {
      assert.equal(isWebviewMessage({ type: "historyWindow", direction: "earlier", generation }, 100), false);
    }
    assert.equal(isWebviewMessage({ type: "historyWindow", direction: "path", generation: 4 }, 100), false);
  } finally {
    mock.restore();
  }
});

test("stale origin, session, history generation and active requests cannot replace a history window", () => {
  const origin = { generation: 7, session: "session-a/client-a" };
  assert.equal(historyRequestIsCurrent(origin, { ...origin, busy: false }), true);
  assert.equal(historyRequestIsCurrent(origin, { ...origin, busy: true }), false);
  assert.equal(historyRequestIsCurrent(origin, { ...origin, generation: 8, busy: false }), false);
  assert.equal(historyRequestIsCurrent(origin, { ...origin, session: "session-b/client-b", busy: false }), false);
});
