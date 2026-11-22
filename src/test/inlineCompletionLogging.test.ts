import assert from "node:assert/strict";
import type { TextDocument } from "vscode";
import { PiLogger } from "../logging";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const invocation = require("../vscodePi") as typeof import("../vscodePi");
const original = invocation.invokePiWithCancellation;
const { PiInlineCompletionProvider } = require("../inlineCompletion") as typeof import("../inlineCompletion");
afterAll(() => {
  invocation.invokePiWithCancellation = original;
  vscode.restore();
});

function fixture() {
  const channel = vscode.window.createOutputChannel("Pi", { log: true });
  const provider = new PiInlineCompletionProvider(new PiLogger(channel));
  vscode.workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "debounceMilliseconds" ? 0 : fallback),
  });
  const document = {
    uri: MockUri.file("/private/INLINE_SECRET.ts"),
    version: 1,
    languageId: "typescript",
    lineCount: 1,
    lineAt: () => ({ text: "INLINE_SECRET" }),
    offsetAt: ({ line, character }: { line: number; character: number }) => (line === 0 ? character : 13),
    positionAt: (offset: number) => new vscode.Position(0, Math.min(offset, 13)),
    getText: ({ start, end }: { start: { character: number }; end: { character: number } }) =>
      "INLINE_SECRET".slice(start.character, end.character),
  };
  const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  return {
    channel,
    token,
    run: () =>
      provider.provideInlineCompletionItems(
        document as unknown as TextDocument,
        new vscode.Position(0, 5),
        { triggerKind: 0, selectedCompletionInfo: undefined },
        token,
      ),
  };
}

test.each(["invalid", "failure", "cancelled", "success"])(
  "inline %s records only safe shared-channel metadata",
  async (mode) => {
    const { channel, token, run } = fixture();
    invocation.invokePiWithCancellation = async () => {
      if (mode === "failure")
        throw Object.assign(new Error("INLINE_SECRET"), { cause: new Error("INLINE_SECRET"), code: "EACCES" });
      if (mode === "cancelled") {
        token.isCancellationRequested = true;
        throw new Error("INLINE_SECRET");
      }
      return mode === "success"
        ? "<<<PI_VSCODE_COMPLETION_START>>>\ninsert\n<<<PI_VSCODE_COMPLETION_END>>>"
        : "INLINE_SECRET";
    };
    const result = await run();
    assert.deepEqual(channel.shown, []);
    assert.ok(!JSON.stringify(channel.records).includes("INLINE_SECRET"));
    if (mode === "success") {
      assert.equal(result?.[0]?.insertText, "insert");
      assert.equal(channel.records.length, 0);
    } else {
      assert.equal(result, undefined);
      assert.equal(channel.records.length, 1);
      assert.equal(channel.records[0].level, mode === "invalid" ? "warn" : mode === "cancelled" ? "debug" : "error");
      if (mode === "failure") assert.match(channel.records[0].message, /EACCES/);
      if (mode === "invalid") assert.match(channel.records[0].message, /invalid-response/);
    }
  },
);
