import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditProposalInput } from "../conversationController";
import { gitEnvironment } from "../gitSnapshots";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test("review findings expose ask/fix only for matching after text and revalidate before proposal Apply", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-actions-"));
  const context: any = { subscriptions: [] };
  const folder = { uri: MockUri.file(root), name: "Fixture" };
  const runtime: any = { currentCwd: root, currentState: { connected: true, sessionId: "s", busy: false } };
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnvironment() });
  const providers = new Map<string, any>();
  const diagnostics = new Map<any, any[]>();
  let actionProvider: any;
  let proposal: EditProposalInput | undefined;
  let requests = 0;
  const document: any = {
    uri: MockUri.file(path.join(root, "a.ts")),
    version: 1,
    eol: 1,
    isClosed: false,
    text: "bad\n",
    getText() {
      return this.text;
    },
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    offsetAt: (position: any) => position.character,
  };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.isTrusted = true;
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: 0 }) };
  vscode.workspace.openTextDocument = async (uri: any) =>
    uri.scheme === "file"
      ? document
      : { uri, getText: () => providers.get(uri.scheme).provideTextDocumentContent(uri) };
  vscode.window.showTextDocument = async () => undefined;
  vscode.ProgressLocation = { Notification: 1 };
  vscode.window.withProgress = async (_options: unknown, fn: any) =>
    fn({}, { onCancellationRequested: () => ({ dispose() {} }) });
  vscode.window.showWarningMessage = async () => "Send Staged Review";
  // An ignored native notification must not retain the review operation lock.
  vscode.window.showInformationMessage = () => new Promise<undefined>(() => {});
  const errors: string[] = [];
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
  };
  vscode.languages.createDiagnosticCollection = () => ({
    set: (uri: any, values: any[]) => diagnostics.set(uri, values),
    delete: (uri: any) => {
      for (const key of diagnostics.keys()) if (key.toString() === uri.toString()) diagnostics.delete(key);
    },
    dispose() {},
  });
  vscode.languages.registerCodeActionsProvider = (_selector: unknown, provider: any) => {
    actionProvider = provider;
    return { dispose() {} };
  };
  vscode.WorkspaceEdit = class {
    replace() {}
  };
  vscode.workspace.applyEdit = async () => assert.fail("A stale finding must never apply");
  const { registerGitReview } = require("../gitReviewController") as typeof import("../gitReviewController");
  registerGitReview(context, runtime, {
    sendRequest: async (request, _contexts, options) => {
      requests++;
      assert.equal(options?.policy, "read-only");
      const response = request.startsWith("Review")
        ? JSON.stringify({
            incomplete: false,
            findings: [
              { path: "a.ts", side: "after", startLine: 1, endLine: 1, severity: "error", message: "Wrong output" },
            ],
          })
        : "<<<PICODE_REPLACEMENT_START>>>\ngood\n\n<<<PICODE_REPLACEMENT_END>>>";
      await options?.onResponse?.(response);
      return response;
    },
    addEditProposal: (input) => {
      proposal = input;
      return "p";
    },
  });
  try {
    git("init", "-q");
    await writeFile(document.uri.fsPath, document.text);
    git("add", "a.ts");
    await vscode.registrations.get("picode.reviewStagedChanges")!();
    assert.deepEqual(errors, []);
    const uri = [...diagnostics.keys()].find((uri) => diagnostics.get(uri)!.length);
    assert.ok(uri);
    const virtual = await vscode.workspace.openTextDocument(uri);
    const range = new vscode.Range(0, 0, 0, 3);
    const actions = await actionProvider.provideCodeActions(virtual, range);
    assert.deepEqual(
      actions.map((action: any) => action.command.command),
      ["picode.askReviewFinding", "picode.fixReviewFinding"],
    );
    document.text = "diverged\n";
    assert.equal((await actionProvider.provideCodeActions(virtual, range)).length, 1);
    await assert.rejects(vscode.registrations.get("picode.fixReviewFinding")!(uri.query, 0), /no longer matches/);
    document.text = "bad\n";
    await vscode.registrations.get("picode.fixReviewFinding")!(uri.query, 0);
    assert.ok(proposal);
    await proposal.onPreview();
    const backup = path.join(root, "original.ts");
    await rename(document.uri.fsPath, backup);
    await symlink(backup, document.uri.fsPath);
    assert.equal((await actionProvider.provideCodeActions(virtual, range)).length, 1, "Symlink targets are ask-only");
    await assert.rejects(proposal.onApply(), /target changed|read-only/);
    await unlink(document.uri.fsPath);
    await rename(backup, document.uri.fsPath);
    await writeFile(document.uri.fsPath, "different staged\n");
    git("add", "a.ts");
    await assert.rejects(proposal.onApply(), /stale/);
    assert.equal(diagnostics.size, 0);
    // Repository-wide reviews from subfolders must not offer edits outside the selected workspace.
    const subfolder = path.join(root, "subfolder");
    await mkdir(subfolder);
    runtime.currentCwd = subfolder;
    vscode.workspace.workspaceFolders = [{ uri: MockUri.file(subfolder), name: "Subfolder" }];
    document.text = "different staged\n";
    await vscode.registrations.get("picode.reviewStagedChanges")!();
    assert.deepEqual(errors, []);
    const outsideUri = [...diagnostics.keys()].find((uri) => diagnostics.get(uri)!.length);
    assert.equal(requests, 3);
    const outsideDocument = await vscode.workspace.openTextDocument(outsideUri);
    assert.equal((await actionProvider.provideCodeActions(outsideDocument, range)).length, 1);
    await assert.rejects(
      vscode.registrations.get("picode.fixReviewFinding")!(outsideUri.query, 0),
      /no longer matches/,
    );
    runtime.currentCwd = root;
    vscode.workspace.workspaceFolders = [folder];
    vscode.window.showQuickPick = async (items: any[], options: any) =>
      options.title === "Choose Git review scope" ? items.find((item) => item.scopeKind === "workingTree") : undefined;
    vscode.window.showWarningMessage = async (message: string, options: any) => {
      assert.match(message, /working tree snapshots/);
      assert.equal(options.modal, true);
      return "Send Review";
    };
    await vscode.registrations.get("picode.reviewChanges")!();
    assert.deepEqual(errors, []);
    assert.equal(requests, 4);
    assert.ok([...diagnostics.values()].flat().some((diagnostic) => diagnostic.source.includes("Working tree")));
  } finally {
    for (const item of context.subscriptions) item.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
