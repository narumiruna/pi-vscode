import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditProposalInput } from "../conversationController";
import { hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test.each([false, true])("batch diagnostic repair (workspace alias: %s)", async (aliasRoot) => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-diagnostic-controller-"));
  const root = path.join(directory, "workspace");
  await mkdir(root);
  const workspacePath = aliasRoot ? path.join(directory, "alias") : root;
  if (aliasRoot) await symlink(root, workspacePath, "junction");
  const context: any = { subscriptions: [] };
  const folder = { uri: MockUri.file(workspacePath), name: "Fixture" };
  const runtime: any = { currentCwd: workspacePath, currentState: { connected: true, sessionId: "s", busy: false } };
  const source = (name: string): any => ({
    uri: MockUri.file(path.join(workspacePath, name)),
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
  vscode.workspace.getWorkspaceFolder = (uri: any) =>
    uri.fsPath.startsWith(`${workspacePath}${path.sep}`) ? folder : undefined;
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
    return message.startsWith("Diagnostic update:") ? new Promise<undefined>(() => {}) : undefined;
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
    assert.equal(hasOperation(root), true, "Apply owns the canonical root lock even through an alias");
    if (aliasRoot) assert.equal(hasOperation(workspacePath), false);
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
      assert.deepEqual(snapshot.files.map((file: { path: string }) => file.path).sort(), ["a.ts", "b.ts"]);
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
    if (aliasRoot) {
      const foreign = path.join(directory, "foreign");
      await mkdir(foreign);
      await writeFile(path.join(foreign, "a.ts"), a.text);
      await writeFile(path.join(foreign, "b.ts"), b.text);
      await unlink(workspacePath);
      await symlink(foreign, workspacePath, "junction");
      await assert.rejects(proposal.onPreview(), /Workspace root changed/);
      await assert.rejects(proposal.onApply(), /Workspace root changed/);
      assert.equal(applications, 0);
      assert.equal(hasOperation(root), false);
      assert.equal(await readFile(path.join(foreign, "a.ts"), "utf8"), "bad\n");
      await unlink(workspacePath);
      await symlink(root, workspacePath, "junction");
      const stat = vscode.workspace.fs.stat;
      let retargeted = false;
      vscode.workspace.fs.stat = async (uri: unknown) => {
        if (!retargeted) {
          await unlink(workspacePath);
          await symlink(foreign, workspacePath, "junction");
          retargeted = true;
        }
        return stat(uri);
      };
      try {
        await assert.rejects(proposal.onApply(), /Workspace root changed/);
        assert.equal(applications, 0, "Retargeting during async preflight must reject the whole Apply");
        assert.equal(hasOperation(root), false);
      } finally {
        vscode.workspace.fs.stat = stat;
        await unlink(workspacePath);
        await symlink(root, workspacePath, "junction");
      }
      await unlink(a.uri.fsPath);
      await symlink(path.join(foreign, "a.ts"), a.uri.fsPath);
      await assert.rejects(proposal.onApply(), /Symlink/);
      assert.equal(applications, 0);
      await unlink(a.uri.fsPath);
      await writeFile(a.uri.fsPath, a.text);
    }
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
    await rm(directory, { recursive: true, force: true });
  }
});
