import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditProposalInput } from "../conversationController";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test("workspace repair selects two files, confirms read-only context, previews and applies once with observed diagnostics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-diagnostic-controller-"));
  const context: any = { subscriptions: [] };
  const folder = { uri: MockUri.file(root), name: "Fixture" };
  const runtime: any = { currentCwd: root, currentState: { connected: true, sessionId: "s", busy: false } };
  const source = (name: string): any => ({
    uri: MockUri.file(path.join(root, name)),
    isClosed: false,
    isDirty: true,
    eol: 1,
    version: 1,
    text: "bad\n",
    getText() {
      return this.text;
    },
    positionAt: (offset: number) => ({ line: 0, character: offset }),
  });
  const a = source("a.ts");
  const b = source("b.ts");
  const diagnostic = {
    message: "wrong type",
    severity: 0,
    source: "ts",
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  };
  let diagListener: any;
  let currentDiagnostics = [diagnostic];
  let proposal: EditProposalInput | undefined;
  let requests = 0;
  let applications = 0;
  let diffs = 0;
  let approved = false;
  let selection: "cancel" | "empty" | "all" = "cancel";
  let staleResponse = false;
  const notices: string[] = [];
  const errors: string[] = [];
  const providers = new Map<string, any>();
  vscode.EndOfLine = { LF: 1, CRLF: 2 };
  vscode.FilePermission = { Readonly: 1 };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.isTrusted = true;
  vscode.workspace.getWorkspaceFolder = (uri: any) => (uri.fsPath.startsWith(root) ? folder : undefined);
  vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: 0 }) };
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.workspace.openTextDocument = async (uri: any) =>
    [a, b].find((document) => document.uri.toString() === uri.toString()) ?? { uri };
  vscode.window.showTextDocument = async () => undefined;
  vscode.window.showQuickPick = async (items: any[]) =>
    selection === "cancel" ? undefined : selection === "empty" ? [] : items;
  vscode.window.showWarningMessage = async () => (approved ? "Send Diagnostic Repair" : undefined);
  vscode.window.showInformationMessage = async (message: string) => {
    notices.push(message);
    // Native non-modal notifications can remain open indefinitely. Apply and
    // listener disposal must finish without waiting for acknowledgement.
    return new Promise<undefined>(() => {});
  };
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
  };
  vscode.languages.getDiagnostics = (uri?: any) =>
    uri
      ? currentDiagnostics
      : [
          [a.uri, [...currentDiagnostics, ...currentDiagnostics]],
          [new MockUri("virtual", "/virtual.ts"), currentDiagnostics],
          [b.uri, currentDiagnostics],
          [MockUri.file("/foreign.ts"), currentDiagnostics],
        ];
  vscode.languages.onDidChangeDiagnostics = (listener: any) => {
    diagListener = listener;
    return {
      dispose() {
        diagListener = undefined;
      },
    };
  };
  vscode.WorkspaceEdit = class {
    edits: any[] = [];
    replace(uri: any, range: any, text: string) {
      this.edits.push({ uri, range, text });
    }
  };
  vscode.workspace.applyEdit = async (edit: any) => {
    applications++;
    assert.equal(edit.edits.length, 2);
    for (const entry of edit.edits) {
      const document = [a, b].find((document) => document.uri.toString() === entry.uri.toString());
      document.text = entry.text;
      document.version++;
    }
    currentDiagnostics = [];
    diagListener?.({ uris: [a.uri, b.uri] });
    return true;
  };
  vscode.commands.executeCommand = async (command: string) => {
    assert.equal(command, "vscode.diff");
    diffs++;
  };
  const { registerWorkspaceDiagnostics } =
    require("../workspaceDiagnosticsController") as typeof import("../workspaceDiagnosticsController");
  registerWorkspaceDiagnostics(context, runtime, {
    sendRequest: async (_request, contexts, options) => {
      requests++;
      assert.equal(options?.policy, "read-only");
      options?.validate?.();
      const snapshot = JSON.parse(contexts[0]!.content);
      assert.equal(snapshot.files.length, 2);
      assert.equal(snapshot.diagnostics.length, 2);
      const response = JSON.stringify({
        files: snapshot.files.map((file: any) => ({ path: file.path, content: "good\n" })),
      });
      if (staleResponse) a.version++;
      await options?.onResponse?.(response);
      return response;
    },
    addEditProposal: (input) => {
      proposal = input;
      return "id";
    },
  });
  try {
    await writeFile(a.uri.fsPath, a.text);
    await writeFile(b.uri.fsPath, b.text);
    const command = vscode.registrations.get("picode.fixWorkspaceDiagnostics")!;
    await command();
    selection = "empty";
    await command();
    selection = "all";
    await command();
    assert.equal(requests, 0);
    approved = true;
    await command();
    assert.deepEqual(errors, []);
    assert.equal(requests, 1);
    assert.ok(proposal);
    assert.equal(applications, 0);
    await proposal.onPreview();
    assert.equal(diffs, 2);
    const apply = vscode.workspace.applyEdit;
    vscode.workspace.applyEdit = async () => false;
    await assert.rejects(proposal.onApply(), /could not apply/);
    assert.equal(diagListener, undefined, "False Apply must release the diagnostic observer immediately");
    vscode.workspace.applyEdit = async () => {
      throw new Error("Native Apply failed");
    };
    await assert.rejects(proposal.onApply(), /Native Apply failed/);
    assert.equal(diagListener, undefined, "Thrown Apply must release the diagnostic observer immediately");
    vscode.workspace.applyEdit = apply;
    await proposal.onPreview();
    await proposal.onApply();
    assert.equal(applications, 1);
    assert.ok(notices.some((message) => /2 disappeared, 0 still present, 0 not revalidated/.test(message)));
    await proposal.onDispose?.();
    assert.equal(diagListener, undefined, "Post-Apply observation must be disposed");
    currentDiagnostics = [diagnostic];
    staleResponse = true;
    await command();
    assert.match(errors.pop()!, /Document changed/);
    assert.equal(requests, 2);
    assert.equal(applications, 1);
    vscode.workspace.isTrusted = false;
    await command();
    assert.match(errors.pop()!, /trusted/);
    assert.equal(requests, 2);
  } finally {
    for (const item of context.subscriptions) item.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
