import assert from "node:assert/strict";
import { consumedUnpinnedIds, contextMetadata, contextWarnings, inspectContext } from "../contextInspector";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("context estimates disclose multilingual bytes, image unknowns, malformed metadata and truncation", () => {
  const content = "漢字🙂";
  const item = { id: "snapshot", label: ".env", uri: MockUri.file("/tmp/.env"), content, metadata: contextMetadata(content, 100, 2, { sourceVersion: 7, range: { startLine: 0, startCharacter: 2, endLine: 1, endCharacter: 0 } }) };
  const result = inspectContext([item, { id: "image", label: "image", image: { data: Buffer.alloc(1024).toString("base64"), mimeType: "image/png" } }]);
  assert.equal(result.characters, content.length);
  assert.equal(result.bytes, Buffer.byteLength(content) + 1024);
  assert.equal(result.imageUsage, "unknown");
  assert.match(result.text, /not Pi history/);
  assert.match(result.text, /excluded characters/);
  assert.match(result.text, /Source: file:.*\.env/);
  assert.match(result.text, /version 7; range 1:3–2:1/);
  assert.match(inspectContext([{ ...item, metadata: { ...item.metadata, capturedAt: NaN } }]).text, /capture unknown/);
  assert.equal(contextMetadata("abc", -1, NaN).originalLength, 3);
  assert.equal(contextWarnings("config", "api_key=supersecretvalue").length, 1);
  assert.deepEqual(consumedUnpinnedIds([{ ...item, metadata: { ...item.metadata, pinned: true } }, { id: "newer", label: "new" }], ["snapshot", "old"]), []);
});

test("attachment snapshots retain pins, survive failed sends, consume only old revisions and send redacted text", async () => {
  const vscode = installVscodeMock();
  const { SidebarAttachmentManager } = require("../sidebarAttachments") as typeof import("../sidebarAttachments");
  let text = "token=originalsecret";
  vscode.window.activeTextEditor = { document: { uri: MockUri.file("/tmp/context.ts"), version: 1, getText: () => text } };
  vscode.workspace.openTextDocument = async (input: unknown) => ({ getText: () => "redacted", input });
  vscode.window.showTextDocument = async () => undefined;
  const manager = new SidebarAttachmentManager({ maxAttachments: 8, maxImageAttachments: 5, maxImageBytes: 5 * 1024 * 1024, maxAttachedCharacters: 20, maxTotalContextCharacters: 40, onChange: () => {}, onNotice: () => {} });
  try {
    await manager.attachCurrentFile();
    const original = manager.values[0]!;
    assert.equal(manager.values.length, 1); // Failed/denied send never calls consume.
    const answers: unknown[] = [{ id: original.id }, "Edit / Redact"];
    vscode.window.showQuickPick = async () => answers.shift();
    vscode.window.showInformationMessage = async () => "Use Edited Snapshot";
    await manager.inspect();
    assert.equal(manager.textContexts[0]?.content, "redacted");
    assert.notEqual(manager.values[0]?.id, original.id);
    manager.consume([original.id]); assert.equal(manager.values.length, 1);
    const redacted = manager.values[0]!;
    answers.push({ id: redacted.id }, "Pin"); await manager.inspect();
    manager.consume(manager.values.map(item => item.id)); assert.equal(manager.values.length, 1);
    text = "new capture"; await manager.attachCurrentFile();
    assert.equal(manager.textContexts[0]?.content, "new capture");
    manager.clear(); assert.equal(manager.values.length, 0);
  } finally { manager.dispose(); vscode.restore(); }
});
