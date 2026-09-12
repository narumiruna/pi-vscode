import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const runtime: any = { currentCwd: root, currentState: { connected: true, sessionId: "s", busy: false, mode: "agent" } };
  return { context, runtime, folder, errors, inspected, dispose: () => { for (const item of context.subscriptions) item.dispose(); } };
}

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
    vscode.window.showQuickPick = async () => [];
    vscode.window.showWarningMessage = async (_message: string, ...args: any[]) => {
      const action = args.find(arg => typeof arg === "string");
      if (action === "Send Snapshot") events.onWillReceiveMessage({ type: "request", command: "continue" });
      return action;
    };
    await command(); assert.ok(dap > 0); assert.equal(provider, 0); assert.match(fixture.errors.pop() ?? "", /paused|changed/);
  } finally { fixture.dispose(); await rm(root, { recursive: true, force: true }); }
});
