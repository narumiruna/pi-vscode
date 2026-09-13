import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitEnvironment } from "../gitSnapshots";
import { installVscodeMock, MockUri } from "./vscodeMock";

// Shared mock stays installed for this isolated Node test process so cached host modules use one API instance.
const vscode = installVscodeMock();
function ui(root: string) {
  const folder = { uri: MockUri.file(root), name: "Fixture" };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.isTrusted = true;
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.ProgressLocation = { Notification: 1 };
  vscode.EndOfLine = { LF: 1, CRLF: 2 };
  vscode.window.withProgress = async (_options: unknown, run: any) => run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  const providers = new Map<string, any>(), inspected: string[] = [];
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => { providers.set(scheme, provider); return { dispose() {} }; };
  vscode.workspace.openTextDocument = async (uri: unknown) => ({ uri });
  vscode.window.showTextDocument = async (document: any) => { if (document.uri && providers.has(document.uri.scheme)) inspected.push(providers.get(document.uri.scheme).provideTextDocumentContent(document.uri)); };
  vscode.window.showInformationMessage = async () => undefined;
  const errors: string[] = [];
  vscode.window.showErrorMessage = async (message: string) => { errors.push(message); };
  const context: any = { subscriptions: [] };
  const runtime: any = { currentCwd: root, currentState: { connected: true, sessionId: "s", busy: false } };
  return { context, runtime, folder, errors, inspected, dispose: () => { for (const item of context.subscriptions) item.dispose(); } };
}

test("snapshot inspection formats zero, one and multiple warnings without exposing content in the prompt", async () => {
  const fixture = ui(tmpdir());
  const { inspectForTransmission, WorkflowDocuments } = require("../workflowUi") as typeof import("../workflowUi");
  const documents = new WorkflowDocuments();
  const disclosure = "Inspect this local snapshot. Pi history/instructions and later tool reads are separate. Secret warnings are best-effort. Nothing has been sent yet.";
  try {
    for (const [label, text, prefix] of [
      ["config", "ordinary snapshot", ""],
      [".env", "ordinary snapshot", "Sensitive filename. "],
      ["config", "api_key=supersecretvalue", "Possible secret pattern. "],
      [".env", "api_key=supersecretvalue", "Sensitive filename; Possible secret pattern. "],
    ]) {
      let confirmations = 0;
      vscode.window.showWarningMessage = async (message: string, ...actions: string[]) => {
        confirmations++;
        assert.equal(fixture.inspected.at(-1), text, "inspect locally before asking to send");
        assert.equal(message, prefix + disclosure);
        assert.deepEqual(actions, ["Send Snapshot", "Edit / Redact"]);
        return "Send Snapshot";
      };
      assert.equal(await inspectForTransmission(documents, label!, text!, 100), text);
      assert.equal(confirmations, 1);
    }
  } finally { documents.dispose(); fixture.dispose(); }
});

test("snapshot confirmation preserves cancellation, redaction reinspection and failure limits", async () => {
  const fixture = ui(tmpdir());
  const { inspectForTransmission, WorkflowDocuments } = require("../workflowUi") as typeof import("../workflowUi");
  const documents = new WorkflowDocuments();
  const text = "private-value and private-value";
  let confirmations = 0;
  const decisions: (string | undefined)[] = [];
  vscode.window.showWarningMessage = async () => { confirmations++; return decisions.shift(); };
  vscode.window.showInputBox = async (options: any) => { assert.equal(options.password, true); return "private-value"; };
  try {
    assert.equal(await inspectForTransmission(documents, "config", text, 100), undefined);
    decisions.push("Edit / Redact", "Send Snapshot");
    assert.equal(await inspectForTransmission(documents, "config", text, 100), "[REDACTED] and [REDACTED]");
    assert.equal(confirmations, 3, "redaction needs another explicit confirmation");
    assert.deepEqual(fixture.inspected, [text, text, "[REDACTED] and [REDACTED]"]);
    decisions.push("Edit / Redact", undefined);
    assert.equal(await inspectForTransmission(documents, "config", text, 100), undefined);
    decisions.push("Edit / Redact");
    vscode.window.showInputBox = async () => undefined;
    assert.equal(await inspectForTransmission(documents, "config", text, 100), undefined);
    decisions.push("Edit / Redact");
    vscode.window.showInputBox = async () => "absent";
    await assert.rejects(inspectForTransmission(documents, "config", text, 100), /not found/);
    const inspected = fixture.inspected.length, prompted = confirmations;
    await assert.rejects(inspectForTransmission(documents, "config", text, 1), /transmission limit/);
    assert.equal(fixture.inspected.length, inspected);
    assert.equal(confirmations, prompted);
  } finally { documents.dispose(); fixture.dispose(); }
});

test("staged command confirmation, immutable finding navigation, stale rejection and trust/virtual guards", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-controller-"));
  const fixture = ui(root);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnvironment() });
  try {
    git("init", "-q"); await writeFile(path.join(root, "a.ts"), "staged\n"); git("add", "a.ts");
    await writeFile(path.join(root, "a.ts"), "unstaged\nextra\n");
    const requests: any[] = [], diffs: any[] = [];
    const { registerGitReview } = require("../gitReviewController") as typeof import("../gitReviewController");
    registerGitReview(fixture.context, fixture.runtime, {
      sendRequest: async (_request, contexts, options) => { requests.push({ contexts, options }); const response = JSON.stringify({ incomplete: false, findings: [{ path: "a.ts", side: "after", startLine: 1, endLine: 1, severity: "warning", message: "Finding" }] }); await options?.onResponse?.(response); return response; }, addEditProposal: () => "unused",
    });
    const command = vscode.registrations.get("piCodingAgent.reviewStagedChanges")!;
    vscode.window.showWarningMessage = async () => undefined;
    await command(); assert.equal(requests.length, 0);
    vscode.window.showWarningMessage = async () => "Send Staged Review";
    await command(); assert.equal(requests.length, 1); assert.equal(requests[0].options.policy, "read-only");
    assert.match(requests[0].contexts[0].content, /staged/); assert.doesNotMatch(requests[0].contexts[0].content, /unstaged/);
    vscode.commands.executeCommand = async (...args: unknown[]) => { diffs.push(args); };
    vscode.window.showQuickPick = async (items: any[]) => items[0];
    await vscode.registrations.get("piCodingAgent.showStagedFindings")!();
    assert.equal(diffs[0][0], "vscode.diff"); assert.notEqual(diffs[0][1].scheme, "file"); assert.notEqual(diffs[0][2].scheme, "file");
    vscode.window.showWarningMessage = async () => { git("add", "a.ts"); return "Send Staged Review"; };
    await command(); assert.equal(requests.length, 1); assert.match(fixture.errors.pop() ?? "", /stale/);
    vscode.workspace.isTrusted = false; await command(); assert.match(fixture.errors.pop() ?? "", /trusted/);
    vscode.workspace.isTrusted = true; vscode.workspace.workspaceFolders = [{ uri: new MockUri("virtual", "/repo"), name: "Virtual" }];
    await command(); assert.match(fixture.errors.pop() ?? "", /virtual/);
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});

for (const workspaceKind of ["root", "subfolder"]) test(`staged ${workspaceKind} review preserves runtime scope and highlights complete finding lines`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-staged-scope-")), nested = path.join(root, "nested");
  await mkdir(nested);
  const fixture = ui(workspaceKind === "root" ? root : nested);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, env: gitEnvironment() });
  let finding = { path: "a.ts", side: "after", startLine: 1, endLine: 1 };
  let selection: any;
  const show = vscode.window.showTextDocument;
  vscode.window.showTextDocument = async (document: any, options: any) => { if (options?.selection) selection = options.selection; return show(document); };
  vscode.window.showWarningMessage = async () => "Send Staged Review";
  vscode.window.showQuickPick = async (items: any[]) => items[0];
  const { registerGitReview } = require("../gitReviewController") as typeof import("../gitReviewController");
  registerGitReview(fixture.context, fixture.runtime, {
    sendRequest: async (_request, _contexts, options) => {
      assert.equal(options?.resource, fixture.folder.uri);
      const response = JSON.stringify({ incomplete: false, findings: [{ ...finding, severity: "warning", message: "Finding" }] });
      await options?.onResponse?.(response); return response;
    }, addEditProposal: () => "unused",
  });
  try {
    git("init", "-q"); await writeFile(path.join(root, "a.ts"), "old\r\nlast"); git("add", "a.ts");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    await writeFile(path.join(root, "a.ts"), "new\r\nfinal🙂"); git("add", "a.ts");
    for (const side of ["before", "after"]) for (const startLine of [1, 2]) {
      finding = { path: "a.ts", side, startLine, endLine: 2 };
      await vscode.registrations.get("piCodingAgent.reviewStagedChanges")!();
      await vscode.registrations.get("piCodingAgent.showStagedFindings")!();
      assert.deepEqual(fixture.errors, []);
      assert.equal(selection.startLine, startLine - 1); assert.equal(selection.startCharacter, 0);
      assert.equal(selection.endLine, 1); assert.equal(selection.endCharacter, side === "before" ? 4 : 7);
    }
    fixture.runtime.currentCwd = workspaceKind === "root" ? nested : root;
    await vscode.registrations.get("piCodingAgent.showStagedFindings")!();
    assert.match(fixture.errors.pop() ?? "", /target does not match/);
    fixture.runtime.currentCwd = fixture.folder.uri.fsPath; fixture.runtime.currentState.sessionId = "changed";
    await vscode.registrations.get("piCodingAgent.showStagedFindings")!();
    assert.match(fixture.errors.pop() ?? "", /session changed/);
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("failed-test repair runs a real failing Node test, applies a previewed fixture response, and reruns the unchanged command", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-repair-controller-"));
  const fixture = ui(root);
  const source = path.join(root, "source.cjs");
  // The process under test is an independent test runner, not a nested Node test worker.
  const parentTestContext = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try {
    await writeFile(source, "module.exports = 0;\n");
    await writeFile(path.join(root, "failure.test.cjs"), "const fs=require('node:fs');const n=fs.existsSync('runs')?Number(fs.readFileSync('runs')):0;fs.writeFileSync('runs',String(n+1));require('node:assert/strict').equal(require('./source.cjs'),42);\n");
    let text = await readFile(source, "utf8"), version = 1;
    const document = { uri: MockUri.file(source), isClosed: false, eol: 1, get version() { return version; }, getText: () => text, positionAt: (offset: number) => ({ line: 0, character: offset }), save: async () => { await writeFile(source, text); return true; } };
    vscode.workspace.openTextDocument = async (uri: any) => uri.scheme === "file" ? document : { uri };
    vscode.window.showOpenDialog = async () => [MockUri.file(source)];
    const command = { executable: process.execPath, args: ["--test", "failure.test.cjs"] };
    vscode.window.showInputBox = async () => JSON.stringify(command);
    vscode.window.showQuickPick = async () => "Run Approved Command";
    const approvals: string[] = [];
    vscode.window.showWarningMessage = async (_message: string, ...args: any[]) => { const action = args.find(arg => typeof arg === "string"); if (action) approvals.push(action); return action; };
    vscode.WorkspaceEdit = class { value = ""; replace(_uri: unknown, _range: unknown, value: string) { this.value = value; } };
    vscode.workspace.applyEdit = async (edit: any) => { text = edit.value; version++; return true; };
    vscode.commands.executeCommand = async () => undefined;
    let requests = 0, previews = 0, applications = 0;
    const { registerTestRepair } = require("../testRepairController") as typeof import("../testRepairController");
    registerTestRepair(fixture.context, fixture.runtime, {
      sendRequest: async (_request, contexts, options) => {
        requests++; assert.equal(options?.policy, "read-only"); assert.match(contexts[0]!.content, /exitCode/);
        return "<<<PI_REPLACEMENT_START>>>\nmodule.exports = 42;\n\n<<<PI_REPLACEMENT_END>>>";
      },
      addEditProposal: input => {
        void (async () => { const ids = input.hunks?.map(hunk => hunk.id); await input.onPreview(ids); previews++; await input.onApply(ids); applications++; await input.onDispose?.(); })();
        return "fixture-proposal";
      },
    });
    await vscode.registrations.get("piCodingAgent.repairFailedTest")!();
    assert.deepEqual(fixture.errors, []);
    assert.ok(requests > 0, fixture.inspected.join("\n"));
    assert.equal(await readFile(path.join(root, "runs"), "utf8"), "2");
    assert.equal(requests, 1); assert.equal(previews, 1); assert.equal(applications, 1);
    assert.deepEqual(approvals, ["Run Test Command", "Send Snapshot", "Save and Rerun", "Run Test Command"]);
    // Denial at process approval must not start any new process or model request.
    vscode.window.showWarningMessage = async () => undefined;
    await vscode.registrations.get("piCodingAgent.repairFailedTest")!();
    assert.equal(await readFile(path.join(root, "runs"), "utf8"), "2"); assert.equal(requests, 1);
  } finally {
    if (parentTestContext !== undefined) process.env.NODE_TEST_CONTEXT = parentTestContext;
    fixture.dispose(); await rm(root, { recursive: true, force: true });
  }
});

test("test repair rejects dirty sources and buffer/disk changes around observed runs", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-repair-source-"));
  const fixture = ui(root), source = path.join(root, "source.cjs"), runs = path.join(root, "runs");
  let text = "module.exports = 0;\n", version = 1, dirty = false, scenario = "";
  const document = { uri: MockUri.file(source), isClosed: false, get isDirty() { return dirty; }, get version() { return version; }, getText: () => text };
  vscode.workspace.openTextDocument = async (uri: any) => uri.scheme === "file" ? document : { uri };
  vscode.window.showOpenDialog = async () => [MockUri.file(source)];
  vscode.window.showInputBox = async () => JSON.stringify({ executable: process.execPath, args: ["-e", "require('fs').writeFileSync('runs','ran');process.exit(1)"] });
  vscode.window.showQuickPick = async () => "Run Approved Command";
  vscode.window.showWarningMessage = async (_message: string, ...args: any[]) => { if (scenario === "approval-edit") { text = "changed"; version++; } return args.find(arg => typeof arg === "string"); };
  const progress = vscode.window.withProgress;
  vscode.window.withProgress = async (options: unknown, run: any) => {
    const result = await progress(options, run);
    if (scenario === "buffer-edit") { text = "changed"; version++; }
    if (scenario === "disk-edit") await writeFile(source, "external edit");
    return result;
  };
  let requests = 0;
  const { registerTestRepair } = require("../testRepairController") as typeof import("../testRepairController");
  registerTestRepair(fixture.context, fixture.runtime, { sendRequest: async () => { requests++; return "unused"; }, addEditProposal: () => "unused" });
  try {
    for (scenario of ["dirty", "approval-edit", "buffer-edit", "disk-edit"]) {
      text = "module.exports = 0;\n"; version++; dirty = scenario === "dirty";
      await writeFile(source, text); await rm(runs, { force: true });
      await vscode.registrations.get("piCodingAgent.repairFailedTest")!();
      assert.match(fixture.errors.pop() ?? "", /Source|source/);
      assert.equal(requests, 0, scenario);
      if (["dirty", "approval-edit"].includes(scenario)) await assert.rejects(readFile(runs), { code: "ENOENT" });
      else assert.equal(await readFile(runs, "utf8"), "ran");
    }
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("supplied failure log files preserve multiline evidence and reject missing, binary or oversized input", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-repair-log-"));
  const fixture = ui(root), source = path.join(root, "source.cjs"), log = path.join(root, "failure.log");
  const text = "module.exports = 0;\n", output = "AssertionError: expected 42\r\n  at test.js:3\r\n\n漢字 context\n";
  let picks = 0, cancelLog = false, requests = 0;
  const document = { uri: MockUri.file(source), isClosed: false, isDirty: false, eol: 1, version: 1, getText: () => text };
  vscode.workspace.openTextDocument = async (uri: any) => uri.scheme === "file" ? document : { uri };
  vscode.window.showOpenDialog = async () => ++picks % 2 === 1 ? [MockUri.file(source)] : cancelLog ? undefined : [MockUri.file(log)];
  vscode.window.showInputBox = async () => JSON.stringify({ executable: "/nonexistent/must-not-run", args: [] });
  vscode.window.showQuickPick = async () => "Supply Existing Failure Log";
  vscode.window.showWarningMessage = async () => "Send Snapshot";
  const { registerTestRepair } = require("../testRepairController") as typeof import("../testRepairController");
  registerTestRepair(fixture.context, fixture.runtime, {
    sendRequest: async (_request, contexts) => {
      requests++; const snapshot = JSON.parse(contexts[0]!.content);
      assert.equal(snapshot.output, output); assert.equal(snapshot.status, "supplied-log"); assert.equal(snapshot.exitCode, null);
      return `<<<PI_REPLACEMENT_START>>>\n${text}\n<<<PI_REPLACEMENT_END>>>`;
    }, addEditProposal: () => assert.fail("unchanged response must not propose edits"),
  });
  try {
    await writeFile(source, text); await writeFile(log, output);
    const command = vscode.registrations.get("piCodingAgent.repairFailedTest")!;
    await command(); assert.equal(requests, 1); assert.deepEqual(fixture.errors, []);
    for (const invalid of [Buffer.from([0, 1]), Buffer.alloc(100_001, 65)]) {
      await writeFile(log, invalid); await command(); assert.equal(requests, 1); assert.match(fixture.errors.pop() ?? "", /Binary|Oversized/);
    }
    await rm(log); await command(); assert.match(fixture.errors.pop() ?? "", /no longer exists/);
    cancelLog = true; await command(); assert.equal(requests, 1); assert.deepEqual(fixture.errors, []);
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});

test("debug capture cancellation, unsupported adapters and resume during inspection never submit to Pi", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-debug-controller-"));
  const fixture = ui(root);
  let factory: any;
  vscode.DebugStackFrame = class { constructor(public session: any, public frameId = 1, public threadId = 1) {} };
  vscode.debug = { registerDebugAdapterTrackerFactory: (_type: string, value: any) => { factory = value; return { dispose() {} }; }, onDidTerminateDebugSession: () => ({ dispose() {} }), onDidChangeActiveStackItem: () => ({ dispose() {} }) };
  let dap = 0, provider = 0;
  const session: any = { id: "debug", type: "pwa-node", workspaceFolder: fixture.folder, configuration: {}, customRequest: async (command: string) => { dap++; return command === "stackTrace" ? { stackFrames: [{ id: 1, name: "paused", line: 1 }] } : command === "scopes" ? { scopes: [] } : { variables: [] }; } };
  vscode.debug.activeStackItem = new vscode.DebugStackFrame(session);
  const { registerDebugContext } = require("../debugContextController") as typeof import("../debugContextController");
  registerDebugContext(fixture.context, fixture.runtime, { sendRequest: async () => { provider++; return "answer"; }, addEditProposal: () => "unused" });
  const events = factory.createDebugAdapterTracker(session);
  const command = vscode.registrations.get("piCodingAgent.askDebugContext")!;
  try {
    events.onDidSendMessage({ type: "event", event: "stopped" });
    vscode.window.showWarningMessage = async () => undefined;
    await command(); assert.equal(dap, 0); assert.equal(provider, 0);
    session.type = "unsupported"; await command(); assert.equal(dap, 0); assert.match(fixture.errors.pop() ?? "", /unsupported/);
    session.type = "pwa-node";
    let expandGetters = true;
    vscode.workspace.getConfiguration = (section: string, scope: any) => ({ get: (_key: string, fallback: unknown) => {
      if (section !== "debug.javascript") return fallback;
      assert.equal(scope, fixture.folder.uri, "resolve settings in the debug session's workspace, not the default root");
      return expandGetters;
    } });
    await command(); assert.equal(dap, 0); assert.match(fixture.errors.pop() ?? "", /getter expansion/);
    expandGetters = false;
    vscode.window.showWarningMessage = async () => { expandGetters = true; return "Capture Locally"; };
    await command(); assert.equal(dap, 0); assert.match(fixture.errors.pop() ?? "", /getter expansion/);
    expandGetters = false;
    vscode.window.showQuickPick = async () => [];
    vscode.window.showWarningMessage = async (_message: string, ...args: any[]) => {
      const action = args.find(arg => typeof arg === "string");
      if (action === "Send Snapshot") events.onWillReceiveMessage({ type: "request", command: "continue" });
      return action;
    };
    await command(); assert.ok(dap > 0); assert.equal(provider, 0); assert.match(fixture.errors.pop() ?? "", /paused|changed/);
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});
