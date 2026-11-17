import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { BashResultView } from "../directShell";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { PiChatViewProvider, registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { SidebarSessions } = require("../sidebarSessions") as typeof import("../sidebarSessions");
const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
const { nullLogger } = require("../logging") as typeof import("../logging");
afterAll(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const shellResult = (changes: Partial<BashResultView> = {}): BashResultView => ({
  output: "shell fixture output",
  exitCode: 0,
  cancelled: false,
  truncated: false,
  ...changes,
});

function runtimeFixture(sessionId: string) {
  const events = new EventEmitter();
  const listen = (name: string, listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return { dispose: () => events.off(name, listener) };
  };
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: { connected: true, busy: false, sessionId },
    clientGeneration: 1,
    hasPendingExtensionDialogs: false,
    onEvent: (listener: (...args: any[]) => void) => listen("event", listener),
    onDidChangeState: (listener: (...args: any[]) => void) => listen("state", listener),
    ensureStarted: async () => {},
    executeBash: vi.fn(),
    prompt: vi.fn(),
    getMessages: async () => [],
    abort: vi.fn(async () => {}),
    shutdown: async () => {},
  };
  return {
    runtime,
    emit: (event: unknown) => events.emit("event", event),
    updateState: (changes: Record<string, unknown>) => {
      runtime.currentState = { ...runtime.currentState, ...changes };
      events.emit("state", runtime.currentState);
    },
  };
}

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const folder = { uri: MockUri.file(process.cwd()) };
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.isTrusted = true;
  mock.window.activeTextEditor = undefined;
  const context: any = {
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const a = { ...runtimeFixture("shell-A"), provider: undefined as any, entry: undefined as any };
  const b = { ...runtimeFixture("shell-B"), provider: undefined as any, entry: undefined as any };
  a.provider = registerPiSidebar(context, a.runtime);
  b.provider = new PiChatViewProvider(
    context,
    b.runtime,
    new WorkspaceChangeTracker(),
    a.provider.backgroundAgents,
    nullLogger,
    { resource: folder.uri as any, label: "Shell B", reveal: () => {} },
    a.provider.draftStore,
  );
  // Register retained controllers directly; runtime admission and process execution are not under test.
  const manager = new SidebarSessions({
    context,
    primaryRuntime: a.runtime,
    primary: a.provider,
    dialogs: {} as any,
    writers: {} as any,
    slots: {} as any,
    logger: nullLogger,
    createConversation: () => assert.fail("This fixture must not create a runtime"),
  });
  a.entry = (manager as any).primary;
  b.entry = (manager as any).entry(b.runtime, b.provider);
  const requestStarted = manager.requestStarted.bind(manager);
  const started = vi.spyOn(manager, "requestStarted").mockImplementation((controller, id) => {
    assert.equal((controller as any).requestGate.isPending, true, "activity starts only after gate acquisition");
    requestStarted(controller, id);
  });
  const requestFinished = manager.requestFinished.bind(manager);
  const finished = vi.spyOn(manager, "requestFinished").mockImplementation((controller, id, outcome, hasResult) => {
    assert.equal((controller as any).requestGate.isPending, false, "settlement follows gate release");
    assert.equal((controller as any).foregroundCancellable, false);
    requestFinished(controller, id, outcome, hasResult);
  });
  const events = new EventEmitter();
  const listen = (name: string, listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return { dispose: () => events.off(name, listener) };
  };
  const posted: any[] = [];
  const view = {
    visible: true,
    webview: {
      html: "",
      options: {},
      cspSource: "https://mock.invalid",
      asWebviewUri: (uri: MockUri) => uri,
      postMessage: async (message: unknown) => {
        posted.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: (...args: any[]) => void) => listen("message", listener),
    },
    onDidDispose: (listener: () => void) => listen("dispose", listener),
    onDidChangeVisibility: (listener: () => void) => listen("visibility", listener),
  };
  const latest = () => [...posted].reverse().find((message) => message.type === "state");
  const row = (session: any) => (manager as any).rows().find((value: any) => value.id === session.entry.id);
  const compose = (text: string, revision: number) =>
    (manager as any).receive({
      type: "sidebarViewState",
      entryId: latest().sidebar.entryId,
      bindingGeneration: latest().sidebar.bindingGeneration,
      text,
      revision,
      followingLatest: true,
      detailVisible: true,
    });
  const checkpoints = vi.spyOn(a.provider.changeTracker, "recordShellRequest").mockImplementation(() => {});
  try {
    manager.resolveWebviewView(view as any);
    await (manager as any).receive({ type: "ready" });
    await action({ a, b, manager, started, finished, checkpoints, posted, latest, row, compose });
  } finally {
    await manager.shutdown();
    for (const disposable of context.subscriptions) disposable.dispose();
    started.mockRestore();
    finished.mockRestore();
    checkpoints.mockRestore();
  }
}

for (const exitCode of [0, 7]) {
  test(`shell exit ${exitCode} settles once only after execution and history reconciliation`, async () => {
    await fixture(async (f) => {
      const execution = deferred<BashResultView>();
      const entered = deferred<void>();
      const historyEntered = deferred<void>();
      const historyReady = deferred<void>();
      const result = shellResult({ exitCode });
      f.a.runtime.executeBash.mockImplementation(
        async (
          command: string,
          exclude: boolean,
          accepted: () => void,
          history: (values: unknown[]) => Promise<void>,
        ) => {
          accepted();
          entered.resolve();
          const value = await execution.promise;
          historyEntered.resolve();
          await historyReady.promise;
          await history([{ role: "bashExecution", command, excludeFromContext: exclude, ...value }]);
          return value;
        },
      );
      const state = vi.spyOn(f.a.provider, "postState");
      const pending = f.a.provider.send("!fixture shell", 3);
      try {
        assert.equal(f.a.runtime.executeBash.mock.calls.length, 0, "owned preparation starts before runtime dispatch");
        assert.equal(f.row(f.a).activity, "running");
        assert.equal(f.row(f.a).unread, false);
        assert.equal(f.started.mock.calls.length, 1);
        const [controller, id] = f.started.mock.calls[0];
        assert.equal(controller, f.a.provider);
        assert.match(id, /^[0-9a-f-]{36}$/);
        assert.ok(f.started.mock.invocationCallOrder[0] < state.mock.invocationCallOrder[0]);
        await entered.promise;
        assert.equal(f.a.runtime.currentState.busy, false, "the owned request does not depend on runtime busy");
        f.a.updateState({ busy: true });
        f.a.emit({
          type: "shell_execution",
          id: "shell-event",
          command: "fixture shell",
          excludeFromContext: false,
          result,
          state: "finished",
        });
        f.a.updateState({ busy: false });
        assert.equal(f.row(f.a).activity, "running", "neither final shell events nor idle snapshots settle activity");
        assert.equal(f.a.entry.activity.resultRevision, 0);
        assert.equal(f.finished.mock.calls.length, 0);
        execution.resolve(result);
        await historyEntered.promise;
        assert.equal(f.row(f.a).activity, "running");
        assert.equal(f.finished.mock.calls.length, 0, "history reconciliation remains owned");
        historyReady.resolve();
        await pending;
        assert.deepEqual(f.finished.mock.calls, [[f.a.provider, id, "completed", true]]);
        assert.equal(f.row(f.a).activity, "completed");
        assert.equal(f.row(f.a).unread, true);
        assert.equal(f.a.entry.activity.resultRevision, 1);
        assert.equal(f.a.entry.activity.activeRequestId, undefined);
        assert.equal(f.a.provider.messages[0].role, "shell");
        assert.match(f.a.provider.messages[0].content, /shell fixture output/);
        assert.equal(f.checkpoints.mock.calls[0][2], "completed");
        assert.equal(f.a.provider.retryRequest, undefined);
        assert.equal(f.a.runtime.prompt.mock.calls.length, 0);
        assert.ok(f.posted.some((message: any) => message.type === "clearInput" && message.expectedRevision === 3));
      } finally {
        execution.resolve(result);
        historyReady.resolve();
        await pending;
        state.mockRestore();
      }
    });
  });
}

test("shell acceptance and settlement stay with A after selection changes to B, with fresh request IDs", async () => {
  await fixture(async (f) => {
    const execution = deferred<BashResultView>();
    const entered = deferred<void>();
    let accept!: () => void;
    f.a.runtime.executeBash.mockImplementation(async (_command: string, _exclude: boolean, accepted: () => void) => {
      accept = accepted;
      entered.resolve();
      return execution.promise;
    });
    await f.compose("!!source A", 4);
    const pending = f.a.provider.send("!!source A", 4);
    try {
      await entered.promise;
      const id = f.a.entry.activity.activeRequestId;
      await f.manager.select(f.b.entry.id);
      await f.compose("keep B draft", 8);
      const mark = f.posted.length;
      accept();
      assert.deepEqual(f.a.entry.composer, { text: "", revision: 5 });
      assert.deepEqual(f.b.entry.composer, { text: "keep B draft", revision: 8 });
      execution.resolve(shellResult());
      await pending;
      assert.deepEqual(f.finished.mock.calls, [[f.a.provider, id, "completed", true]]);
      assert.equal(f.row(f.a).activity, "completed");
      assert.equal(f.row(f.a).unread, true);
      assert.equal(f.row(f.b).activity, "idle");
      assert.equal(f.b.entry.activity.resultRevision, 0);
      assert.equal(f.latest().sidebar.entryId, f.b.entry.id);
      assert.ok(!f.posted.slice(mark).some((message: any) => message.type === "clearInput"));
      assert.deepEqual(f.a.runtime.executeBash.mock.calls[0].slice(0, 2), ["source A", true]);
      f.b.runtime.executeBash.mockImplementation(async (_command: string, _exclude: boolean, accepted: () => void) => {
        accepted();
        return shellResult();
      });
      await f.b.provider.send("!source B", 9);
      const nextId = f.started.mock.calls[1][1];
      assert.notEqual(nextId, id);
      assert.deepEqual(f.started.mock.calls, [
        [f.a.provider, id],
        [f.b.provider, nextId],
      ]);
      assert.deepEqual(f.finished.mock.calls[1], [f.b.provider, nextId, "completed", true]);
      assert.equal(f.a.entry.activity.resultRevision, 1);
      assert.equal(f.b.entry.activity.resultRevision, 1);
    } finally {
      execution.resolve(shellResult());
      await pending;
    }
  });
});

for (const conflict of ["attachments", "request", "runtime", "background"] as const) {
  test(`shell ${conflict} rejection creates no owned success or unread result`, async () => {
    await fixture(async (f) => {
      let release = () => {};
      if (conflict === "attachments")
        f.a.provider.attachments.attachments.push({ id: "keep", label: "Keep attachment", content: "fixture" });
      if (conflict === "request") release = f.a.provider.requestGate.acquire();
      if (conflict === "runtime") f.a.updateState({ busy: true });
      if (conflict === "background") release = f.a.provider.backgroundSubmissionGate.acquire();
      try {
        await assert.rejects(f.a.provider.send("!not admitted", 1), /Remove all attachments|idle composer/);
        assert.equal(f.started.mock.calls.length, 0);
        assert.equal(f.finished.mock.calls.length, 0);
        assert.equal(f.a.runtime.executeBash.mock.calls.length, 0);
        assert.equal(f.a.entry.activity.resultRevision, 0);
        assert.equal(f.row(f.a).unread, false);
        assert.notEqual(f.row(f.a).activity, "completed");
        assert.equal(f.checkpoints.mock.calls.length, 0);
        assert.ok(!f.posted.some((message: any) => message.type === "clearInput"));
      } finally {
        release();
      }
    });
  });
}

test("undefined shell admission settles as stopped without clearing the draft or publishing a result", async () => {
  await fixture(async (f) => {
    const execution = deferred<BashResultView | undefined>();
    f.a.runtime.executeBash.mockImplementation(() => execution.promise);
    await f.compose("!not started", 2);
    const pending = f.a.provider.send("!not started", 2);
    execution.resolve(undefined);
    await pending;
    const id = f.started.mock.calls[0][1];
    assert.deepEqual(f.finished.mock.calls, [[f.a.provider, id, "stopped", false]]);
    assert.equal(f.row(f.a).activity, "stopped");
    assert.equal(f.row(f.a).unread, false);
    assert.equal(f.a.entry.activity.resultRevision, 0);
    assert.deepEqual(f.a.entry.composer, { text: "!not started", revision: 2 });
    assert.equal(f.checkpoints.mock.calls.length, 0);
    assert.equal(f.a.provider.status, "Shell not started");
    assert.ok(f.posted.some((message: any) => message.type === "sendRejected"));
    assert.ok(!f.posted.some((message: any) => message.type === "clearInput"));
  });
});

test("a submitted shell cancellation settles as stopped and retains the inspection warning", async () => {
  await fixture(async (f) => {
    const execution = deferred<BashResultView>();
    const entered = deferred<void>();
    f.a.runtime.executeBash.mockImplementation(async (_command: string, _exclude: boolean, accepted: () => void) => {
      accepted();
      entered.resolve();
      return execution.promise;
    });
    const pending = f.a.provider.send("!cancel fixture", 1);
    await entered.promise;
    f.a.runtime.abort.mockImplementation(async () => execution.resolve(shellResult({ cancelled: true })));
    await f.a.provider.receiveSidebarMessage({ type: "cancel" });
    await pending;
    const id = f.started.mock.calls[0][1];
    assert.equal(f.a.runtime.abort.mock.calls.length, 1);
    assert.deepEqual(f.finished.mock.calls, [[f.a.provider, id, "stopped", true]]);
    assert.equal(f.row(f.a).activity, "stopped");
    assert.equal(f.row(f.a).unread, true);
    assert.equal(f.a.entry.activity.resultRevision, 1);
    assert.equal(f.checkpoints.mock.calls[0][2], "cancelled");
    assert.match(f.a.provider.status, /[Ii]nspect effects|Check history and effects/);
    assert.equal(f.a.provider.retryRequest, undefined);
  });
});

for (const submitted of [false, true]) {
  const phase = submitted ? "after" : "before";
  test(`shell failure ${phase} submission publishes one actionable failed result`, async () => {
    await fixture(async (f) => {
      const execution = deferred<BashResultView>();
      const entered = deferred<void>();
      f.a.runtime.executeBash.mockImplementation(async (_command: string, _exclude: boolean, accepted: () => void) => {
        if (submitted) accepted();
        entered.resolve();
        return execution.promise;
      });
      const pending = f.a.provider.send("!uncertain fixture", 1);
      const rejected = assert.rejects(pending, /fixture shell failure/);
      await entered.promise;
      if (submitted) {
        f.a.emit({ type: "runtime_warning", warningCode: "cleanup-unverified" });
        f.a.updateState({ connected: false, busy: false });
      }
      assert.equal(f.row(f.a).activity, "running");
      assert.equal(f.finished.mock.calls.length, 0);
      execution.reject(new Error("fixture shell failure"));
      await rejected;
      const id = f.started.mock.calls[0][1];
      assert.deepEqual(f.finished.mock.calls, [[f.a.provider, id, "failed", true]]);
      assert.equal(f.row(f.a).activity, "failed");
      assert.equal(f.row(f.a).unread, true);
      assert.equal(f.a.entry.activity.resultRevision, 1);
      assert.equal(f.checkpoints.mock.calls.length, submitted ? 1 : 0);
      if (submitted) {
        assert.equal(f.checkpoints.mock.calls[0][2], "process-exit");
        assert.equal(f.a.entry.cleanupUnverified, true);
      }
      assert.match(f.a.provider.status, /uncertain.*no automatic retry/);
      assert.equal(f.a.provider.retryRequest, undefined);
      assert.ok(
        f.posted.some(
          (message: any) => message.type === "notice" && /do not repeat it automatically/.test(message.message),
        ),
      );
      assert.equal(
        f.posted.some((message: any) => message.type === "clearInput"),
        submitted,
      );
    });
  });
}
