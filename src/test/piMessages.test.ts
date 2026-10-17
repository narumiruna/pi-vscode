import assert from "node:assert/strict";
import { ConversationResponseCapture } from "../conversationController";
import { ImageAssetCache } from "../imageAssets";
import { piMessageContentText } from "../piMessages";
import { installVscodeMock } from "./vscodeMock";

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
