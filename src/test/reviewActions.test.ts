import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { EditProposalInput } from "../conversationController";
import { gitEnvironment } from "../gitSnapshots";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test.each([
  { alias: false, nested: false },
  { alias: true, nested: false },
  { alias: true, nested: true },
])(
  "review finding fixes preserve buffer identity and stale guards (alias: $alias, subfolder: $nested)",
  async ({ alias, nested }) => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-review-actions-"));
    const root = path.join(directory, "repository");
    const selected = nested ? path.join(root, "selected") : root;
    const filePath = nested ? "selected/a.ts" : "a.ts";
    const workspace = alias ? path.join(directory, "alias") : selected;
    await mkdir(selected, { recursive: true });
    if (alias) await symlink(selected, workspace, "junction");
    const context: any = { subscriptions: [] };
    const folder = { uri: MockUri.file(workspace), name: "Fixture" };
    const runtime: any = { currentCwd: workspace, currentState: { connected: true, sessionId: "s", busy: false } };
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnvironment() });
    const providers = new Map<string, any>();
    const diagnostics = new Map<any, any[]>();
    let actionProvider: any;
    let proposal: EditProposalInput | undefined;
    let requests = 0;
    let changeDuringResponse = false;
    const document = {
      uri: MockUri.file(path.join(workspace, "a.ts")),
      version: 1,
      eol: 1,
      isClosed: false,
      text: "bad\n",
      getText() {
        return this.text;
      },
      positionAt: (offset: number) => ({ line: 0, character: offset }),
      offsetAt: (position: { character: number }) => position.character,
    };
    vscode.workspace.workspaceFolders = [folder];
    vscode.workspace.isTrusted = true;
    vscode.workspace.getWorkspaceFolder = () => folder;
    vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
      providers.set(scheme, provider);
      return { dispose() {} };
    };
    vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: 0 }) };
    // VS Code keeps canonical and workspace-alias URIs as separate buffers.
    const canonicalDocument = { ...document, uri: MockUri.file(path.join(root, filePath)) };
    vscode.workspace.openTextDocument = async (uri: MockUri) => {
      if (uri.scheme !== "file")
        return { uri, getText: () => providers.get(uri.scheme).provideTextDocumentContent(uri) };
      if (uri.toString() === document.uri.toString()) return document;
      assert.equal(uri.toString(), canonicalDocument.uri.toString());
      return canonicalDocument;
    };
    vscode.window.showTextDocument = async () => undefined;
    vscode.commands.executeCommand = async () => undefined;
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
                { path: filePath, side: "after", startLine: 1, endLine: 1, severity: "error", message: "Wrong output" },
              ],
            })
          : "<<<PICODE_REPLACEMENT_START>>>\ngood\n\n<<<PICODE_REPLACEMENT_END>>>";
        if (changeDuringResponse) document.version++;
        await options?.onResponse?.(response);
        return response;
      },
      addEditProposal: (input) => {
        proposal = input;
        return "p";
      },
    });
    const fixFinding = vscode.registrations.get("picode.fixReviewFinding");
    assert.equal(typeof fixFinding, "function");
    try {
      git("init", "-q");
      await writeFile(document.uri.fsPath, document.text);
      git("add", filePath);
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
      vscode.workspace.fs.stat = async () => {
        document.text = "changed during writable check\n";
        document.version++;
        return { permissions: 0 };
      };
      await assert.rejects(fixFinding(uri.query, 0), /no longer matches/);
      assert.equal(requests, 1, "Writable-check races must not submit a fix request");
      vscode.workspace.fs.stat = async () => ({ permissions: 0 });
      document.text = "diverged\n";
      assert.equal((await actionProvider.provideCodeActions(virtual, range)).length, 1);
      await assert.rejects(fixFinding(uri.query, 0), /no longer matches/);
      document.text = "bad\n";
      changeDuringResponse = true;
      await assert.rejects(fixFinding(uri.query, 0), /target changed/);
      assert.equal(Boolean(proposal), false);
      changeDuringResponse = false;
      await fixFinding(uri.query, 0);
      assert.ok(proposal);
      document.version++;
      await assert.rejects(proposal.onPreview(), /document changed/);
      await assert.rejects(proposal.onApply(), /document changed/);
      await fixFinding(uri.query, 0);
      await proposal.onPreview();
      document.text = "new unsaved text\n";
      await assert.rejects(proposal.onApply(), /target changed/);
      document.text = "bad\n";
      const backup = path.join(root, "original.ts");
      await rename(document.uri.fsPath, backup);
      await symlink(backup, document.uri.fsPath);
      assert.equal((await actionProvider.provideCodeActions(virtual, range)).length, 1, "Symlink targets are ask-only");
      await assert.rejects(proposal.onApply(), /target changed|read-only/);
      await unlink(document.uri.fsPath);
      await rename(backup, document.uri.fsPath);
      await writeFile(document.uri.fsPath, "different staged\n");
      git("add", filePath);
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
      assert.equal(requests, 5);
      const outsideDocument = await vscode.workspace.openTextDocument(outsideUri);
      assert.equal((await actionProvider.provideCodeActions(outsideDocument, range)).length, 1);
      await assert.rejects(fixFinding(outsideUri.query, 0), /no longer matches/);
      runtime.currentCwd = workspace;
      vscode.workspace.workspaceFolders = [folder];
      vscode.window.showQuickPick = async (items: any[], options: any) =>
        options.title === "Choose Git review scope"
          ? items.find((item) => item.scopeKind === "workingTree")
          : undefined;
      vscode.window.showWarningMessage = async (message: string, options: any) => {
        assert.match(message, /working tree snapshots/);
        assert.equal(options.modal, true);
        return "Send Review";
      };
      await vscode.registrations.get("picode.reviewChanges")!();
      assert.deepEqual(errors, []);
      assert.equal(requests, 6);
      assert.ok([...diagnostics.values()].flat().some((diagnostic) => diagnostic.source.includes("Working tree")));
      const currentUri = [...diagnostics].find(([, items]) =>
        items.some((item) => item.source.includes("Working tree")),
      )?.[0];
      assert.ok(currentUri);
      await fixFinding(currentUri.query, 0);
      let previewTarget: MockUri | undefined;
      vscode.commands.executeCommand = async (command: string, target: MockUri) => {
        assert.equal(command, "vscode.diff");
        previewTarget = target;
      };
      await proposal.onPreview();
      assert.equal(previewTarget?.toString(), document.uri.toString());
      let applied = false;
      vscode.WorkspaceEdit = class {
        replace(target: MockUri, _range: unknown, replacement: string) {
          assert.equal(target.toString(), document.uri.toString());
          assert.equal(replacement, "good\n");
        }
      };
      vscode.workspace.applyEdit = async () => {
        applied = true;
        return true;
      };
      await proposal.onApply();
      assert.equal(applied, true);
      assert.equal(canonicalDocument.text, "bad\n", "The separate canonical buffer is never edited");
      proposal.onDispose?.();
    } finally {
      for (const item of context.subscriptions) item.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);
