import assert from "node:assert/strict";
import { ConversationResponseCapture } from "../conversationController";
import { ImageAssetCache } from "../imageAssets";
import { piMessageContentText, piMessageThinking } from "../piMessages";
import { installVscodeMock } from "./vscodeMock";

test("visible thinking has indexed allowlisted fields, never signatures or answer text", () => {
  const content = [
    { type: "thinking", thinking: "first\u0000\u001b\u202e\nline", thinkingSignature: "secret-one" },
    { type: "text", text: "answer", textSignature: "secret-two" },
    { type: "thinking", thinking: "must not display", redacted: true, thinkingSignature: "encrypted-secret" },
    null,
    { type: "thinking", thinking: "no signature required" },
    { type: "thinking", thinking: 42 },
  ];
  assert.deepEqual(piMessageThinking(content), [
    { contentIndex: 0, text: "first\nline" },
    { contentIndex: 2, text: "", redacted: true },
    { contentIndex: 4, text: "no signature required" },
  ]);
  assert.equal(piMessageContentText(content), "answer");
  assert.doesNotMatch(JSON.stringify(piMessageThinking(content)), /secret|must not display|Signature/);
  for (const malformed of [undefined, null, {}, "text", 1, [null, {}, { type: "thinking", text: "wrong" }]]) {
    assert.deepEqual(piMessageThinking(malformed), []);
  }
});

test("thinking extraction bounds characters and blocks with explicit truncation", () => {
  const oversized = piMessageThinking([{ type: "thinking", thinking: "x".repeat(300_000) }]);
  assert.equal(oversized[0]?.text.length, 250_000);
  assert.equal(oversized[0]?.truncated, true);
  const many = piMessageThinking(Array.from({ length: 200 }, () => ({ type: "thinking", redacted: true })));
  assert.equal(many.length, 128);
  assert.equal(many.at(-1)?.truncated, true);
});

test("live capture and history preserve the same text-block content", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const imageAssets = new ImageAssetCache({ maxImageBytes: 100, maxTotalBytes: 100, maxAssets: 1 });
    const cases: { content: unknown; expected: string }[] = [
      { content: "  plain\r\ntext\n", expected: "  plain\r\ntext\n" },
      { content: "", expected: "" },
      { content: undefined, expected: "" },
      { content: null, expected: "" },
      { content: 42, expected: "" },
      { content: { type: "text", text: "not a block array" }, expected: "" },
      { content: [], expected: "" },
      { content: [{ type: "text", text: "" }], expected: "" },
      {
        content: [
          null,
          false,
          { type: "text", text: 42 },
          { type: "thinking", text: "hidden" },
          { type: "image", data: "ignored" },
          { type: "text", text: "  first\n" },
          { type: "text", text: "" },
          { type: "text", text: "last  " },
        ],
        expected: "  first\n\n\nlast  ",
      },
    ];
    for (const { content, expected } of cases) {
      assert.equal(piMessageContentText(content), expected);
      const capture = new ConversationResponseCapture();
      capture.accept({ type: "message_end", message: { role: "assistant", content } });
      assert.equal(capture.response, expected);
      const history = convertPiMessages([{ role: "assistant", content }], { imageAssets });
      assert.deepEqual(
        history.map((message) => message.content),
        expected ? [expected] : [],
      );
    }
  } finally {
    vscode.restore();
  }
});
