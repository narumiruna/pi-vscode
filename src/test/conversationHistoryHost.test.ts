import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

function setup(count = 205) {
  const mock = installVscodeMock();
  mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  let stateChanged = () => {};
  const source = Array.from({ length: count }, (_, index) => ({
    role: "user",
    timestamp: index,
    content: `History ${index}`,
  }));
  const frameBytes = () =>
    Buffer.byteLength(
      `${JSON.stringify({ type: "response", command: "get_messages", success: true, data: { messages: source } })}\n`,
    );
  let calls = 0;
  let wireBytes = 0;
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
      wireBytes += frameBytes();
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
    wireBytes: () => wireBytes,
    frameBytes,
    stateChanged: () => stateChanged(),
    source,
    dispose() {
      for (const disposable of context.subscriptions) disposable.dispose();
      mock.restore();
    },
  };
}

test("bounded text history primes two earlier windows; navigation keeps the latest persisted cache", async () => {
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
    assert.equal(fixture.calls(), 1);
    assert.equal(provider.messages.length, 100);
    assert.equal(provider.messages[0].content, "History 5");
    assert.equal(persisted.length, saved, "older browsing does not replace the latest cache");
    const generation = provider.historySyncRevision;
    await provider.handleMessage({ type: "historyWindow", direction: "earlier", generation: generation - 1 });
    assert.equal(fixture.calls(), 1, "stale controls cannot navigate");
    await provider.handleMessage({ type: "historyWindow", direction: "earlier", generation });
    assert.equal(fixture.calls(), 1, "second earlier page is part of the same snapshot");
    assert.equal(provider.messages[0].content, "History 0");
    await provider.handleMessage({
      type: "historyWindow",
      direction: "latest",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 1);
    assert.equal(persisted.length, saved);
    assert.equal(provider.messages[0].content, "History 105");
    assert.equal(
      fixture.wireBytes(),
      fixture.frameBytes(),
      "only the initial full history frame crosses the fixture RPC boundary",
    );
    fixture.runtime.currentState.busy = true;
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 1, "active work never fetches history");
  } finally {
    fixture.dispose();
  }
});

test("settlement visits an older entry outside the three primed windows only once", async () => {
  const fixture = setup(305);
  const { provider, runtime } = fixture;
  const getMessages: () => Promise<readonly unknown[]> = runtime.getMessages;
  let oldestReads = 0;
  runtime.getMessages = async () => {
    const values = (await getMessages()).slice();
    const oldest = values[0];
    return Object.defineProperty(values, 0, {
      get() {
        oldestReads += 1;
        return oldest;
      },
    });
  };
  try {
    await provider.syncMessagesFromPi(false, undefined, "history-refresh", true);
    for (const start of [205, 105, 5]) {
      assert.equal(provider.historyWindow.start, start);
      assert.equal(provider.historyWindow.total, 305);
      assert.equal(provider.historyWindow.omittedBefore, start);
      assert.equal(provider.historyWindow.omittedAfter, 205 - start);
      assert.equal(provider.messages[0].content, `History ${start}`);
      if (start > 5) {
        await provider.handleMessage({
          type: "historyWindow",
          direction: "earlier",
          generation: provider.historySyncRevision,
        });
      }
    }
    assert.equal(fixture.calls(), 1);
    assert.equal(oldestReads, 1, "only snapshot indexing visits entries outside the primed windows");
  } finally {
    fixture.dispose();
  }
});

test("history mutations and explicit refresh do not reuse stale pages", async () => {
  const fixture = setup();
  const { provider, source } = fixture;
  try {
    await provider.syncMessagesFromPi();
    source[5].content = "Changed by Pi";
    provider.handleRuntimeEvent({ type: "message_end", message: { role: "custom", content: "Pi changed history" } });
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 2);
    assert.equal(provider.messages[0].content, "Changed by Pi");
    await provider.handleMessage({
      type: "historyWindow",
      direction: "latest",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 2);
    source[5].content = "Changed before explicit refresh";
    await provider.syncMessagesFromPi();
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 3);
    assert.equal(provider.messages[0].content, "Changed before explicit refresh");
  } finally {
    fixture.dispose();
  }
});

test("history with custom messages keeps the authoritative fetch on navigation", async () => {
  const fixture = setup();
  const { provider, source } = fixture;
  try {
    source[1].role = "custom";
    await provider.syncMessagesFromPi();
    await provider.handleMessage({
      type: "historyWindow",
      direction: "earlier",
      generation: provider.historySyncRevision,
    });
    await provider.handleMessage({
      type: "historyWindow",
      direction: "latest",
      generation: provider.historySyncRevision,
    });
    assert.equal(fixture.calls(), 3);
    assert.equal(provider.messages[0].content, "History 105");
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
