import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

function setup() {
  const mock = installVscodeMock();
  mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  let stateChanged = () => {};
  const source = Array.from({ length: 205 }, (_, index) => ({
    role: "user",
    timestamp: index,
    content: `History ${index}`,
  }));
  let calls = 0;
  const runtime: any = {
    currentState: { connected: true, busy: false, sessionId: "one" },
    currentCwd: process.cwd(),
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: (listener: () => void) => {
      stateChanged = listener;
      return { dispose() {} };
    },
    getMessages: async () => {
      calls += 1;
      return source;
    },
  };
  const persisted: unknown[] = [];
  const context: any = {
    workspaceState: {
      get: () => undefined,
      update: async (_key: string, value: unknown) => {
        persisted.push(value);
      },
    },
    extensionUri: MockUri.file("/extension"),
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  return {
    provider,
    runtime,
    persisted,
    calls: () => calls,
    stateChanged: () => stateChanged(),
    dispose() {
      for (const disposable of context.subscriptions) disposable.dispose();
      mock.restore();
    },
  };
}

test("host reacquires authoritative history for each bounded replacement; earlier windows are not persisted", async () => {
  const fixture = setup();
  const { provider, persisted } = fixture;
  try {
    await provider.syncMessagesFromPi();
    const saved = persisted.length;
    assert.equal(provider.messages.length, 100);
    assert.equal(provider.historyWindow.start, 105);
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 2);
    assert.equal(provider.messages.length, 100);
    assert.equal(provider.messages[0].content, "History 5");
    assert.equal(persisted.length, saved, "older browsing does not replace the latest cache");
    const generation = provider.historySyncRevision;
    await provider.handleMessage({ type: "historyWindow", direction: "earlier", generation: generation - 1 });
    assert.equal(fixture.calls(), 2, "stale controls cannot navigate");
    await provider.handleMessage({ type: "historyWindow", direction: "latest", generation });
    assert.equal(fixture.calls(), 3);
    assert.equal(provider.messages[0].content, "History 105");
    fixture.runtime.currentState.busy = true;
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 3, "active work never fetches history");
  } finally {
    fixture.dispose();
  }
});

test("late success and failure from older history generations cannot replace current state", async () => {
  const fixture = setup();
  const { provider, runtime } = fixture;
  try {
    await provider.syncMessagesFromPi();
    let complete: (value: unknown[]) => void = () => {};
    runtime.getMessages = () =>
      new Promise((resolve) => {
        complete = resolve;
      });
    const pending = provider.syncMessagesFromPi(false, provider.historyWindow.start);
    assert.equal(provider.historyLoading, true);
    runtime.currentState.sessionId = "replacement";
    fixture.stateChanged();
    provider.messages = [{ id: "current", role: "user", content: "newer session text" }];
    complete([{ role: "user", content: "stale earlier text" }]);
    await pending;
    assert.equal(provider.messages[0].content, "newer session text");
    assert.equal(provider.historyAvailable, false);
    assert.equal(provider.historyLoading, false);
    let reject: (reason: Error) => void = () => {};
    runtime.getMessages = () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      });
    const failing = provider.syncMessagesFromPi();
    provider.handleRuntimeEvent({ type: "agent_start" });
    provider.messages = [{ id: "live", role: "assistant", content: "newer live request" }];
    const status = provider.status;
    reject(new Error("older history failed"));
    await failing;
    assert.equal(provider.status, status);
    assert.equal(provider.messages[0].content, "newer live request");
    assert.equal(provider.historyLoading, false);
  } finally {
    fixture.dispose();
  }
});

test("history navigation refuses active extension dialogs and pending queues without dispatch", async () => {
  const fixture = setup();
  try {
    const { provider, runtime } = fixture;
    await provider.syncMessagesFromPi();
    runtime.hasPendingExtensionDialogs = true;
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    runtime.hasPendingExtensionDialogs = false;
    runtime.currentState.pendingQueue = { steering: [{ id: "pending", text: "next" }], followUp: [] };
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 1);
  } finally {
    fixture.dispose();
  }
});
