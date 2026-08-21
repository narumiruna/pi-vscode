import assert from "node:assert/strict";
import test from "node:test";
import {
  boundCompletionContext,
  buildCompletionPrompt,
  extractCompletion,
} from "../completion";

test("buildCompletionPrompt places the cursor between bounded code context", () => {
  const prompt = buildCompletionPrompt({
    file: "src/math.ts",
    languageId: "typescript",
    prefix: "function add(a: number, b: number) {\n  ",
    suffix: "\n}",
  });

  assert.match(prompt, /File: src\/math\.ts/);
  assert.match(prompt, /PI_PREFIX_END>>>\n<<<PI_CURSOR>>>\n<<<PI_SUFFIX_START/);
});

test("extractCompletion preserves insertion whitespace and rejects prose", () => {
  assert.equal(
    extractCompletion("<<<PI_COMPLETION_START>>>\nreturn a + b;\n<<<PI_COMPLETION_END>>>\n"),
    "return a + b;",
  );
  assert.equal(extractCompletion("Here is the completion: return a + b;"), undefined);
});

test("boundCompletionContext keeps the closest prefix and suffix", () => {
  assert.deepEqual(boundCompletionContext("012345", "abcdef", 3, 2), {
    prefix: "345",
    suffix: "ab",
  });
  assert.deepEqual(boundCompletionContext("prefix", "suffix", 0, 0), {
    prefix: "",
    suffix: "",
  });
});
