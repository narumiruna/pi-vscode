import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { EditProposalStore } from "../editProposals";
import { hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const original = "module.exports = 0;\n";
const replacement = "module.exports = 42;\n";
const foreign = "FOREIGN_WORKSPACE_MUST_NOT_CHANGE\n";

test.each([
  "stable",
  "before-preview",
  "before-apply",
  "save-confirmation",
  "pre-save-check",
  "save-denied",
  "save-failed",
] as const)("test repair retains its captured workspace through %s", async (timing) => {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-repair-alias-boundaries-")));
  const root = path.join(directory, "workspace");
  const outside = path.join(directory, "outside");
  const workspace = path.join(directory, "alias");
  await mkdir(root);
  await mkdir(outside);
  await symlink(root, workspace, "junction");
  const source = path.join(root, "source.cjs");
  const foreignSource = path.join(outside, "source.cjs");
  const log = path.join(root, "failure.log");
  const context: any = { subscriptions: [] };
  const folder = { uri: MockUri.file(workspace), name: "Fixture" };
  const runtime: any = { currentCwd: workspace, currentState: { connected: true, sessionId: "s", busy: false } };
  const errors: string[] = [];
  const notices: string[] = [];
  const providers = new Map<string, any>();
  const store = new EditProposalStore(
    () => {},
    (message) => notices.push(message),
  );
  let applications = 0;
  let saves = 0;
  let previews = 0;
  let requests = 0;
  let saveApproved = false;
  let saveRootReads = 0;
  let swapped = false;
  const retarget = async () => {
    await unlink(workspace);
    await symlink(outside, workspace, "junction");
    swapped = true;
  };
  const document = {
    uri: MockUri.file(path.join(workspace, "source.cjs")),
    version: 1,
    eol: 1,
    isClosed: false,
    isDirty: false,
    text: original,
    getText() {
      return this.text;
    },
    positionAt: (offset: number) => ({ line: 0, character: offset }),
    save: async () => {
      saves++;
      if (timing === "save-failed") return false;
      // A real pathname write at the mocked VS Code save boundary demonstrates
      // whether a changed alias can reach a different workspace.
      await writeFile(document.uri.fsPath, document.text);
      document.isDirty = false;
      return true;
    },
  };
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.workspace.openTextDocument = async (uri: MockUri) => {
    if (uri.scheme !== "file") return { uri, getText: () => providers.get(uri.scheme).provideTextDocumentContent(uri) };
    assert.equal(uri.toString(), document.uri.toString(), "Reuse the alias-spelled editor buffer");
    return document;
  };
  vscode.window.showTextDocument = async () => undefined;
  vscode.window.showInputBox = async () =>
    JSON.stringify({
      executable: process.execPath,
      args: ["-e", "require('node:fs').writeFileSync('runs','ran');console.log('tests 1\\npass 1')"],
    });
  vscode.window.showOpenDialog = async (options: any) => [options.filters ? document.uri : MockUri.file(log)];
  vscode.window.showQuickPick = async () => "Supply Existing Failure Log";
  vscode.window.showWarningMessage = async (_message: string, ...actions: any[]) => {
    const action = actions.find((value) => typeof value === "string");
    if (action === "Save and Rerun") {
      if (timing === "save-confirmation") await retarget();
      if (timing === "save-denied") return undefined;
      saveApproved = true;
    }
    return action;
  };
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
  };
  vscode.commands.executeCommand = async (command: string, uri: MockUri) => {
    assert.equal(command, "vscode.diff");
    assert.equal(uri.toString(), document.uri.toString());
    previews++;
  };
  vscode.ProgressLocation = { Notification: 1 };
  vscode.window.withProgress = async (_options: unknown, run: any) =>
    run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  vscode.WorkspaceEdit = class {
    value = "";
    replace(uri: MockUri, _range: unknown, value: string) {
      assert.equal(uri.toString(), document.uri.toString());
      this.value = value;
    }
  };
  vscode.workspace.applyEdit = async (edit: { value: string }) => {
    applications++;
    document.text = edit.value;
    document.version++;
    document.isDirty = true;
    return true;
  };
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalRealpath = fs.realpath;
  const realpathSpy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    const resolved = await originalRealpath(...args);
    if (timing === "pre-save-check" && saveApproved && String(args[0]) === workspace && ++saveRootReads === 2)
      await retarget(); // Both runtime-target reads still return the old root.
    return resolved;
  });
  let resolveProposal!: (id: string) => void;
  const proposalReady = new Promise<string>((resolve) => {
    resolveProposal = resolve;
  });
  const { registerTestRepair } = require("../testRepairController") as typeof import("../testRepairController");
  registerTestRepair(context, runtime, {
    sendRequest: async (_request, _contexts, options) => {
      requests++;
      assert.equal(options?.policy, "read-only");
      return `<<<PICODE_REPLACEMENT_START>>>\n${replacement}\n<<<PICODE_REPLACEMENT_END>>>`;
    },
    addEditProposal: (input) => {
      const id = store.add(input);
      resolveProposal(id);
      return id;
    },
  });
  let invocation: Promise<void> | undefined;
  try {
    await writeFile(source, original);
    await writeFile(foreignSource, foreign);
    await writeFile(log, "AssertionError: expected 42\n");
    const command: () => Promise<void> = vscode.registrations.get("picode.repairFailedTest");
    assert.equal(typeof command, "function");
    invocation = command();
    const id = await Promise.race([
      proposalReady,
      invocation.then(() => assert.fail(`Repair ended without a proposal: ${errors.join("; ")}`)),
    ]);
    if (timing === "before-preview") await retarget();
    await store.handleLockedAction(id, "preview", root);
    if (timing === "before-preview") {
      assert.equal(store.states[0]?.status, "stale");
      assert.equal(previews, 0);
    } else {
      assert.equal(store.states[0]?.status, "previewed");
      if (timing === "before-apply") await retarget();
      await store.handleLockedAction(id, "apply", root);
      if (timing === "before-apply") assert.equal(store.states[0]?.status, "stale");
    }
    await invocation;
    assert.equal(hasOperation(root), false, "Proposal actions release the canonical workspace lock");
    assert.equal(requests, 1);
    assert.equal(await readFile(foreignSource, "utf8"), foreign);
    assert.equal(applications, ["before-preview", "before-apply"].includes(timing) ? 0 : 1);
    assert.equal(saves, ["stable", "save-failed"].includes(timing) ? 1 : 0);
    assert.equal(await readFile(source, "utf8"), timing === "stable" ? replacement : original);
    if (timing === "stable") {
      assert.equal(await readFile(path.join(root, "runs"), "utf8"), "ran");
      assert.deepEqual(errors, []);
    } else {
      await assert.rejects(readFile(path.join(root, "runs")), { code: "ENOENT" });
      if (timing === "save-failed") assert.match(errors[0] ?? "", /could not be saved/);
      else if (timing === "save-denied") assert.deepEqual(errors, []);
      else {
        assert.equal(swapped, true, "The alias substitution must execute");
        assert.match([...notices, ...errors].join("\n"), /workspace root changed/);
      }
    }
    await assert.rejects(readFile(path.join(outside, "runs")), { code: "ENOENT" });
  } finally {
    store.clear();
    await invocation;
    realpathSpy.mockRestore();
    for (const item of context.subscriptions) item.dispose();
    await rm(directory, { recursive: true, force: true });
  }
});
