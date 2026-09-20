import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditProposalInput } from "../conversationController";
import { EditProposalStore } from "../editProposals";
import { acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test("multi-file proposal previews chosen hunks, rejects stale/readonly/foreign files and applies once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-multi-edit-"));
  const context: any = { subscriptions: [] };
  const providers = new Map<string, any>();
  const previewTexts: string[] = [];
  let applications = 0;
  let readOnly = false;
  let applySuccess = true;
  let proposal: EditProposalInput | undefined;
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.EndOfLine = { LF: 1, CRLF: 2 };
  vscode.FilePermission = { Readonly: 1 };
  vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: readOnly ? 1 : 0 }) };
  vscode.WorkspaceEdit = class {
    edits: any[] = [];
    replace(uri: any, range: any, text: string) {
      this.edits.push({ uri, range, text });
    }
  };
  const makeDocument = (name: string, text: string, eol = 1): any => ({
    uri: MockUri.file(path.join(root, name)),
    version: 1,
    isClosed: false,
    eol,
    text,
    getText() {
      return this.text;
    },
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  });
  const a = makeDocument("a.ts", "a\nb\nc\n");
  const b = makeDocument("b.ts", "x\r\ny\r\n", 2);
  const files = () => [
    { path: "a.ts", document: a, version: a.version, original: a.text, replacement: "A\nb\nC\n" },
    { path: "b.ts", document: b, version: b.version, original: b.text, replacement: "X\ny\n" },
  ];
  const controller: any = {
    addEditProposal: (input: EditProposalInput) => {
      proposal = input;
      return "p";
    },
  };
  vscode.workspace.applyEdit = async (edit: any) => {
    applications++;
    assert.equal(hasOperation(root), true, "Every multi-file Apply must own its workspace gate");
    if (!applySuccess) return false;
    for (const change of edit.edits) {
      const document = [a, b].find((document) => document.uri.toString() === change.uri.toString());
      document.text = change.text;
      document.version++;
    }
    return true;
  };
  vscode.commands.executeCommand = async (_command: string, _before: any, after: any) => {
    previewTexts.push(providers.get(after.scheme).provideTextDocumentContent(after));
  };
  const { addMultiFileEditProposal, registerEditPreviewProvider } =
    require("../editProposalController") as typeof import("../editProposalController");
  const previews = registerEditPreviewProvider(context);
  await writeFile(a.uri.fsPath, a.text);
  await writeFile(b.uri.fsPath, b.text);
  try {
    addMultiFileEditProposal(previews, controller, { root, files: files() });
    assert.ok(proposal);
    assert.equal(proposal.hunks?.length, 3);
    await assert.rejects(proposal.onApply(["0:h0", "1:h0"]), /Preview/);
    await assert.rejects(proposal.onPreview(["unknown"]), /Invalid/);
    await proposal.onPreview(["0:h0", "1:h0"]);
    assert.deepEqual(previewTexts.slice(-2), ["A\nb\nc\n", "X\r\ny\r\n"]);
    a.version++;
    await assert.rejects(proposal.onApply(["0:h0", "1:h0"]), /stale/);
    assert.equal(applications, 0);
    a.version--;
    readOnly = true;
    await assert.rejects(proposal.onApply(["0:h0", "1:h0"]), /Read-only/);
    readOnly = false;
    const release = acquireOperation(root, "test");
    await assert.rejects(proposal.onApply(["0:h0", "1:h0"]), /test|active|operation/i);
    release();
    await assert.rejects(proposal.onApply(["0:h1"]), /Preview/);
    await proposal.onApply(["0:h0", "1:h0"]);
    assert.equal(applications, 1);
    assert.equal(a.text, "A\nb\nc\n");
    assert.equal(b.text, "X\r\ny\r\n");
    await proposal.onDispose?.();
    assert.throws(
      () => addMultiFileEditProposal(previews, controller, { root: path.join(root, "other"), files: files() }),
      /outside/,
    );
    a.text = "a\nb\nc\n";
    b.text = "x\r\ny\r\n";
    addMultiFileEditProposal(previews, controller, { root, files: files() });
    await proposal.onPreview();
    applySuccess = false;
    await assert.rejects(proposal.onApply(), /could not apply/);
    assert.equal(applications, 2);
    // Exercise the exact Sidebar/store route, not only callbacks: this used to double-lock Apply.
    applySuccess = true;
    const store = new EditProposalStore(
      () => {},
      (message) => {
        if (!message.includes("Use Undo")) assert.fail(message);
      },
    );
    const id = addMultiFileEditProposal(
      previews,
      { sendRequest: async () => "", addEditProposal: (input) => store.add(input) },
      { root, files: files() },
    );
    await store.handleLockedAction(id, "preview", root);
    await store.handleLockedAction(id, "apply", root);
    assert.equal(store.states[0]?.status, "applied");
    assert.equal(applications, 3);
    assert.equal(hasOperation(root), false);
    store.clear();
  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
