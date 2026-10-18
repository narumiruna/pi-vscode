import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
afterAll(() => mock.restore());

function fixture() {
  let resolve: (messages: unknown[]) => void = () => {};
  let entered: () => void = () => {};
  const reading = new Promise<void>((done) => {
    entered = done;
  });
  const response = new Promise<unknown[]>((done) => {
    resolve = done;
  });
  let dispatches = 0;
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: { connected: true, busy: false, sessionId: "a", sessionFile: "/fixture/a.jsonl" },
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: () => ({ dispose() {} }),
    ensureStarted: async () => {},
    getMessages: () => {
      entered();
      return response;
    },
    prompt: async () => {
      dispatches += 1;
    },
    executeBash: async () => {
      dispatches += 1;
    },
  };
  const provider: any = registerPiSidebar(
    {
      extensionUri: MockUri.file("/fixture"),
      workspaceState: { get: () => undefined, update: async () => {} },
      subscriptions: [],
    } as any,
    runtime,
  );
  provider.postState = () => {};
  provider.postNotice = () => {};
  provider.historyWindow = {
    mode: "earlier",
    start: 0,
    end: 10,
    total: 205,
    omittedBefore: 0,
    omittedAfter: 195,
    truncated: false,
  };
  return { provider, runtime, reading, resolve, dispatches: () => dispatches };
}

for (const action of ["prompt", "shell"] as const) {
  test(`${action} holds the request gate before restoring latest history and rejects a changed session`, async () => {
    const context = fixture();
    const pending =
      action === "shell"
        ? context.provider.sendShell("pwd", false, "!pwd", 1)
        : context.provider.runRequest("Do not move this request", [], [], undefined, undefined, undefined, "composer");
    const rejected = assert.rejects(pending, /conversation changed/);
    await context.reading;
    assert.equal(
      context.provider.requestGate.isPending,
      true,
      "session controls must be blocked during history restoration",
    );
    context.runtime.currentState = { ...context.runtime.currentState, sessionId: "b", sessionFile: "/fixture/b.jsonl" };
    context.resolve([]);
    await rejected;
    assert.equal(context.dispatches(), 0, "a stale history result must never authorize execution in another session");
    assert.equal(context.provider.requestGate.isPending, false, "failed restoration releases ownership");
    context.provider.dispose();
  });
}

test("same-session history invalidation cannot authorize a later submission", async () => {
  const context = fixture();
  const origin = context.provider.submissionSessionIdentity();
  const pending = context.provider.restoreLatestHistoryForSubmission(origin);
  const rejected = assert.rejects(pending, /conversation changed/);
  await context.reading;
  context.provider.historySyncRevision += 1;
  context.resolve([]);
  await rejected;
  assert.equal(context.dispatches(), 0);
  context.provider.dispose();
});
