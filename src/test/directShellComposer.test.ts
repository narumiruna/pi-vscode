import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");

test("only explicit idle composer submissions use shell; literal escapes use prompts and attachments/queue/other origins reject", async () => {
  const subscription = () => ({ dispose() {} });
  const shells: any[] = [];
  const prompts: string[] = [];
  const checkpoints: any[] = [];
  let runtimeEvent: (event: unknown) => void = () => {};
  const result = { output: "<img src=x>\nfixture", exitCode: 0, cancelled: false, truncated: false };
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: { connected: true, busy: false, sessionId: "shell-fixture" },
    onEvent: (callback: (event: unknown) => void) => {
      runtimeEvent = callback;
      return subscription();
    },
    onDidChangeState: subscription,
    ensureStarted: async () => {},
    executeShell: async (
      command: string,
      excludeFromContext: boolean,
      accepted: () => void,
      history: (values: unknown[]) => Promise<void>,
    ) => {
      shells.push({ command, excludeFromContext });
      accepted();
      runtimeEvent({ type: "shell_execution", id: "fixture", command, excludeFromContext, result, state: "running" });
      runtimeEvent({ type: "shell_execution", id: "fixture", command, excludeFromContext, result, state: "finished" });
      await history([{ role: "bashExecution", command, excludeFromContext, ...result }]);
      return result;
    },
    prompt: async (text: string, _resource: unknown, _images: unknown, accepted: () => void) => {
      prompts.push(text);
      accepted?.();
      return "fixture response";
    },
    getMessages: async () => [],
  };
  const context: any = {
    extensionUri: MockUri.file("/fixture-extension"),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime);
  const internal = provider as any;
  const posted: any[] = [];
  internal.view = {
    webview: {
      postMessage: async (message: unknown) => {
        posted.push(message);
        return true;
      },
    },
  };
  internal.changeTracker.recordShellRequest = (...args: any[]) => checkpoints.push(args);
  try {
    await internal.send("!printf harmless", 1);
    await internal.send("!!printf harmless", 2);
    assert.deepEqual(shells, [
      { command: "printf harmless", excludeFromContext: false },
      { command: "printf harmless", excludeFromContext: true },
    ]);
    assert.equal(prompts.length, 0);
    assert.equal(checkpoints.length, 2);
    assert.equal(internal.messages.length, 1, "authoritative history replaces the streaming card");
    const state = posted.filter((value) => value.type === "state").at(-1);
    assert.equal(state.messages[0].role, "shell");
    assert.match(state.messages[0].html, /&lt;img src=x&gt;/);
    assert.doesNotMatch(state.messages[0].html, /<img/);
    assert.equal(internal.retryRequest, undefined);
    assert.ok(posted.some((value) => value.type === "clearInput" && value.expectedRevision === 2));
    await internal.send("\\!literal prompt", 3);
    assert.match(prompts.at(-1)!, /!literal prompt/);
    assert.doesNotMatch(prompts.at(-1)!, /\\!literal/);
    await provider.sendRequest("!editor-owned prompt", []);
    assert.match(prompts.at(-1)!, /!editor-owned prompt/);
    assert.equal(shells.length, 2, "editor-owned or model-generated text never becomes direct shell");
    await assert.rejects(internal.queue("steer", "!printf harmless", 4), /cannot be queued/);
    await assert.rejects(internal.queue("followUp", "!!printf harmless", 4), /cannot be queued/);
    await assert.rejects(internal.sendInNewSession("!printf harmless", 4), /Open a session/);
    await assert.rejects(internal.runBackground("!printf harmless", false, 4), /idle session composer/);
    internal.attachments.attachments.push({ id: "fixture", label: "fixture", content: "do not discard" });
    await assert.rejects(internal.send("!printf harmless", 4), /Remove all attachments/);
    assert.equal(internal.attachments.summaries.length, 1);
    assert.equal(shells.length, 2);
  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
  }
});
