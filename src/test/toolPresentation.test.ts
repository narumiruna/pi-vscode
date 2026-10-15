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

test("ordinary tool output preserves JSON that matches serialized result shapes", () => {
  const vscode = installVscodeMock();
  try {
    const { extractToolText } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    for (const value of [
      { content: [{ type: "text", text: "file contents" }] },
      { output: "command output", exit_code: 0, wall_time_seconds: 1, truncated: false },
    ]) {
      const text = JSON.stringify(value);
      for (const toolName of [undefined, "read", "bash", "edit", "custom"]) {
        assert.equal(extractToolText({ content: [{ type: "text", text }] }, 8000, toolName), text);
      }
    }
  } finally {
    vscode.restore();
  }
});

test("long cumulative tool output retains new text and the final failure within the limit", () => {
  const vscode = installVscodeMock();
  try {
    const { extractToolText, boundToolText } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const prefix = "old output\n".repeat(1000);
    const content = (text: string) => ({ content: [{ type: "text", text }] });
    const partial = extractToolText(content(prefix + "latest partial line"), 8000);
    const final = extractToolText(content(prefix + "latest partial line\nFAIL: final test failure"), 8000);
    assert.ok(partial.endsWith("latest partial line"));
    assert.ok(final.endsWith("FAIL: final test failure"));
    assert.notEqual(partial, final);
    assert.equal(partial.length, 8000);
    assert.equal(final.length, 8000);
    assert.match(final, /Truncated; only retained text/);
    for (const limit of [0, 1, 40, 44, 45, 8000]) {
      assert.equal(extractToolText(content(prefix), limit).length, limit);
    }
    assert.ok(extractToolText(prefix + "plain tail", 8000).endsWith("plain tail"));
    assert.ok(boundToolText(prefix + "input end", 8000).startsWith("old output"), "input keeps its leading fields");
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
      assert.equal(extractToolText(content(JSON.stringify(content(text))), 8000, "codemode"), text);
    }
    const nested = content(JSON.stringify(content("deep")));
    assert.equal(extractToolText(content(JSON.stringify(nested)), 8000, "codemode"), nested.content[0].text);
    for (const value of [{ unknown: "value" }, { content: [{ type: "image", data: "opaque" }] }]) {
      assert.equal(extractToolText(value, 8000), JSON.stringify(value, null, 2));
    }
    assert.equal(extractToolText(content('{"content":invalid'), 8000), '{"content":invalid');
    assert.equal(extractToolText(content(""), 8000), "");
    assert.equal(
      extractToolText(
        content(JSON.stringify({ output: "bash\\noutput", exit_code: 0, wall_time_seconds: 1, truncated: false })),
        8000,
        "codemode",
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
        "codemode",
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
