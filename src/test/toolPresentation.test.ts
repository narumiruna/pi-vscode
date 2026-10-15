import assert from "node:assert/strict";
import { installVscodeMock } from "./vscodeMock";

test("tool summaries use original verified arguments and neutral bounded fallbacks", () => {
  const vscode = installVscodeMock();
  try {
    const { toolOperationSummary, boundToolText } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    for (const name of ["read", "edit", "write"]) {
      assert.equal(toolOperationSummary(name, { path: "src/file.ts", content: "ignored" }), "src/file.ts");
    }
    assert.equal(toolOperationSummary("bash", { command: "npm test\n && echo done" }), "npm test && echo done");
    assert.equal(toolOperationSummary("read", { path: "\u202e<img>\tfile" }), "<img> file");
    for (const args of [undefined, {}, { path: 42 }])
      assert.equal(toolOperationSummary("read", args), "Tool operation");
    assert.equal(toolOperationSummary("unknown", { path: "not a verified path" }), "Tool operation");
    assert.equal(toolOperationSummary("codemode", { code: "secret source" }), "Tool operation");
    assert.equal(toolOperationSummary("bash", { command: "x".repeat(1000) }).length, 240);
    assert.match(boundToolText("x".repeat(9000), 8000), /Truncated; only retained text/);
    assert.equal(boundToolText("x".repeat(9000), 8000).length, 8000);
  } finally {
    vscode.restore();
  }
});

test("tool text supports Pi content blocks and one serialized envelope, not recursive parsing", () => {
  const vscode = installVscodeMock();
  try {
    const { extractToolText, safeJson } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const content = (text: string) => ({ content: [{ type: "text", text }] });
    for (const text of [
      "read\nlines",
      "edit complete",
      "partial bash\noutput",
      "<img onerror=alert(1)>",
      String.raw`literal\nbackslash`,
    ]) {
      assert.equal(extractToolText(content(text), 8000), text);
      assert.equal(extractToolText(text, 8000), text);
      assert.equal(extractToolText(content(JSON.stringify(content(text))), 8000), text);
    }
    const nested = content(JSON.stringify(content("deep")));
    assert.equal(extractToolText(content(JSON.stringify(nested)), 8000), nested.content[0].text);
    for (const value of [{ unknown: "value" }, { content: [{ type: "image", data: "opaque" }] }]) {
      assert.equal(extractToolText(value, 8000), JSON.stringify(value, null, 2));
    }
    assert.equal(extractToolText(content('{"content":invalid'), 8000), '{"content":invalid');
    assert.equal(extractToolText(content(""), 8000), "");
    assert.equal(
      extractToolText(
        content(JSON.stringify({ output: "bash\\noutput", exit_code: 0, wall_time_seconds: 1, truncated: false })),
        8000,
      ),
      "bash\\noutput",
    );
    assert.match(
      extractToolText({ ...content("partial"), details: { truncation: { truncated: true } } }, 8000),
      /Tool result truncated/,
    );
    assert.match(
      extractToolText(
        content(JSON.stringify({ output: "partial", exit_code: 0, wall_time_seconds: 1, truncated: true })),
        8000,
      ),
      /Tool result truncated/,
    );
    assert.match(extractToolText(content("x".repeat(9000)), 8000), /Truncated/);
    assert.equal(extractToolText(content("x".repeat(9000)), 8000).length, 8000);
    assert.equal(safeJson(undefined, 8000), "undefined");
  } finally {
    vscode.restore();
  }
});
