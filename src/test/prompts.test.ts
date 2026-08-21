import assert from "node:assert/strict";
import test from "node:test";
import {
  buildAskPrompt,
  buildChatPrompt,
  buildModifyPrompt,
  extractReplacement,
  limitChatHistory,
  limitReferenceContent,
  type SelectionContext,
} from "../prompts";

const selection: SelectionContext = {
  file: "src/example.ts",
  languageId: "typescript",
  startLine: 3,
  endLine: 5,
  code: "const answer = 40 + 2;",
};

test("buildAskPrompt includes the question and selected code context", () => {
  const prompt = buildAskPrompt(selection, "What does this do?");

  assert.match(prompt, /Question: What does this do\?/);
  assert.match(prompt, /File: src\/example\.ts/);
  assert.match(prompt, /const answer = 40 \+ 2;/);
  assert.match(prompt, /Do not modify files\./);
});

test("buildModifyPrompt requests a tagged replacement", () => {
  const prompt = buildModifyPrompt(selection, "Use a named constant");

  assert.match(prompt, /Instruction: Use a named constant/);
  assert.match(prompt, /<<<PI_REPLACEMENT_START>>>/);
  assert.match(prompt, /Do not use Markdown code fences\./);
});

test("buildChatPrompt includes history, references, and command intent", () => {
  const prompt = buildChatPrompt(
    "How should I improve it?",
    "review",
    [
      { role: "user", content: "Please inspect this function." },
      { role: "assistant", content: "It parses the input." },
    ],
    [{ label: "src/parser.ts", content: "export function parse() {}" }],
  );

  assert.match(prompt, /User:\nPlease inspect this function\./);
  assert.match(prompt, /Assistant:\nIt parses the input\./);
  assert.match(prompt, /PI_REFERENCE_START: src\/parser\.ts/);
  assert.match(prompt, /correctness, security, maintainability, and missing tests/);
  assert.match(prompt, /How should I improve it\?/);
  assert.match(prompt, /tools are disabled/);
});

test("buildChatPrompt omits empty optional sections", () => {
  const prompt = buildChatPrompt("What is a closure?", undefined, [], []);

  assert.doesNotMatch(prompt, /Conversation history:/);
  assert.doesNotMatch(prompt, /Referenced context:/);
  assert.match(prompt, /Current request:\n\nWhat is a closure\?/);
});

test("limitChatHistory keeps the newest bounded context in chronological order", () => {
  const history = [
    { role: "user" as const, content: "oldest" },
    { role: "assistant" as const, content: "middle" },
    { role: "user" as const, content: "newest-request" },
  ];

  assert.deepEqual(limitChatHistory(history, 10, 2), [
    { role: "user", content: "st-request" },
  ]);
  assert.deepEqual(limitChatHistory(history, 100, 2), history.slice(-2));
});

test("limitReferenceContent enforces per-reference and remaining-context bounds", () => {
  assert.equal(limitReferenceContent("0123456789", 8, 5), "01234");
  assert.equal(limitReferenceContent("0123456789", 3, 5), "012");
  assert.equal(limitReferenceContent("0123456789", 0, 5), "");
});

test("extractReplacement preserves replacement whitespace", () => {
  const output = [
    "<<<PI_REPLACEMENT_START>>>",
    "  const value = 42;",
    "",
    "<<<PI_REPLACEMENT_END>>>",
  ].join("\n");

  assert.equal(extractReplacement(output), "  const value = 42;\n");
});

test("extractReplacement accepts CRLF framing", () => {
  const output = "<<<PI_REPLACEMENT_START>>>\r\nreturn 42;\r\n<<<PI_REPLACEMENT_END>>>\r\n";

  assert.equal(extractReplacement(output), "return 42;");
});

test("extractReplacement rejects explanations and malformed output", () => {
  assert.equal(
    extractReplacement(
      "Here is the change:\n<<<PI_REPLACEMENT_START>>>\nreturn 42;\n<<<PI_REPLACEMENT_END>>>",
    ),
    undefined,
  );
  assert.equal(extractReplacement("```ts\nreturn 42;\n```"), undefined);
});
