import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { PiChatViewProvider, registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { SidebarSessions } = require("../sidebarSessions") as typeof import("../sidebarSessions");
const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
const { nullLogger } = require("../logging") as typeof import("../logging");
afterAll(() => mock.restore());

const sessionFile = (name: string) => path.join(process.cwd(), `${name}.jsonl`);

function runtimeFixture(sessionId: string, file?: string) {
  const events = new EventEmitter();
  const listen = (name: string, listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return { dispose: () => events.off(name, listener) };
  };
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: { connected: true, busy: false, sessionId, sessionFile: file },
    clientGeneration: 1,
    hasPendingExtensionDialogs: false,
    onEvent: (listener: (...args: any[]) => void) => listen("event", listener),
    onDidChangeState: (listener: (...args: any[]) => void) => listen("state", listener),
    ensureStarted: async () => {},
    prompt: vi.fn(),
    getMessages: async () => [],
    shutdown: async () => {},
  };
  return {
    runtime,
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
  const a = {
    ...runtimeFixture("composer-A", sessionFile("composer-a")),
    provider: undefined as any,
    entry: undefined as any,
  };
  const b = { ...runtimeFixture("composer-B"), provider: undefined as any, entry: undefined as any };
  a.provider = registerPiSidebar(context, a.runtime);
  b.provider = new PiChatViewProvider(
    context,
    b.runtime,
    new WorkspaceChangeTracker(),
    a.provider.backgroundAgents,
    nullLogger,
    { resource: folder.uri as any, label: "Composer B", reveal: () => {} },
    a.provider.draftStore,
  );
  // Use the retained-controller fixture pattern; no process or session admission is needed.
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
  const posted: any[] = [];
  const makeView = () => {
    const events = new EventEmitter();
    const listen = (name: string, listener: (...args: any[]) => void) => {
      events.on(name, listener);
      return { dispose: () => events.off(name, listener) };
    };
    return {
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
      dispose: () => events.emit("dispose"),
    };
  };
  let view = makeView();
  const latest = () => [...posted].reverse().find((message) => message.type === "state");
  const binding = () => {
    const { sidebar } = [...posted].reverse().find((message) => Number.isSafeInteger(message.sidebar?.composerContext));
    return {
      entryId: sidebar.entryId,
      bindingGeneration: sidebar.bindingGeneration,
      composerContext: sidebar.composerContext,
    };
  };
  const dispatch = (message: Record<string, unknown>, envelope = binding()) =>
    (manager as any).receive({ ...message, ...envelope });
  const compose = (text: string, revision: number) =>
    dispatch({ type: "sidebarViewState", text, revision, followingLatest: true, detailVisible: true });
  const rebind = async (whileDetached?: () => void) => {
    view.dispose();
    whileDetached?.();
    view = makeView();
    manager.resolveWebviewView(view as any);
    await (manager as any).receive({ type: "ready" });
  };
  try {
    manager.resolveWebviewView(view as any);
    await (manager as any).receive({ type: "ready" });
    await action({ a, b, manager, posted, latest, binding, dispatch, compose, rebind });
  } finally {
    await manager.shutdown();
    for (const disposable of context.subscriptions) disposable.dispose();
  }
}

test("first actual file assignment keeps nonempty text unblocked, including launcher promotion", async () => {
  await fixture(async (f) => {
    (f.manager as any).launcher = f.b.entry;
    f.manager.revealConversation(f.b.provider);
    await f.compose("unsent startup text", 4);
    assert.equal(f.latest().sidebar.view, "sessions");
    (f.manager as any).launcher = undefined;
    const mark = f.posted.length;
    f.b.updateState({ sessionFile: sessionFile("first-assignment") });
    f.b.provider.refreshView();
    const messages = f.posted.slice(mark).filter((message: any) => ["draftState", "state"].includes(message.type));
    assert.equal(messages[0].type, "draftState");
    assert.ok(messages.every((message: any) => message.sidebar.composer.contextBlocked === false));
    assert.ok(messages.every((message: any) => message.sidebar.composerContext === 0));
    assert.deepEqual(f.b.entry.composer, { text: "unsent startup text", revision: 4 });
    assert.equal(f.latest().sidebar.view, "session");
    f.b.updateState({ sessionId: "startup-id-finalized", sessionFile: undefined });
    f.b.updateState({ sessionFile: sessionFile("first-assignment") });
    f.b.provider.refreshView();
    assert.equal(f.latest().sidebar.composer.contextBlocked, false, "same file after disconnect is not replacement");
    assert.equal(f.latest().sidebar.composerContext, 0);
  });
});

test.each([false, true])("real replacement blocks before draftState (disconnected first: %s)", async (disconnect) => {
  await fixture(async (f) => {
    await f.compose("keep the original draft", 3);
    if (disconnect) {
      f.a.updateState({ sessionFile: undefined, connected: false });
      f.a.provider.refreshView();
      assert.equal(f.latest().sidebar.composer.contextBlocked, false);
    }
    const mark = f.posted.length;
    f.a.updateState({ sessionFile: sessionFile("replacement"), connected: true });
    f.a.provider.refreshView();
    const messages = f.posted.slice(mark).filter((message: any) => ["draftState", "state"].includes(message.type));
    assert.equal(messages[0].type, "draftState", "draft recovery refresh precedes the controller runtime snapshot");
    assert.equal(messages[0].reset, true, "the host must not suppress the real recovery ownership transition");
    assert.ok(messages.some((message: any) => message.type === "state"));
    for (const message of messages) {
      assert.deepEqual(message.sidebar.composer, {
        text: "keep the original draft",
        revision: 3,
        contextBlocked: true,
      });
      assert.equal(message.sidebar.entryId, f.a.entry.id);
    }
    assert.deepEqual(f.a.entry.composer, { text: "keep the original draft", revision: 3 });
    assert.equal(f.a.runtime.prompt.mock.calls.length, 0);
  });
});

test("blocked context survives inactive replacement, editing, selection, and view recreation", async () => {
  await fixture(async (f) => {
    await f.compose("A draft", 1);
    const oldA = f.binding();
    f.manager.revealConversation(f.b.provider);
    await f.compose("B draft", 1);
    f.b.updateState({ sessionFile: sessionFile("first-b") });
    f.b.provider.refreshView();
    assert.equal(f.latest().sidebar.composer.contextBlocked, false);
    const mark = f.posted.length;
    f.a.updateState({ sessionFile: sessionFile("inactive-a-replacement") });
    f.a.provider.refreshView();
    assert.equal(f.a.entry.contextBlocked, true);
    assert.ok(!f.posted.slice(mark).some((message: any) => message.sidebar?.composer?.contextBlocked));
    assert.deepEqual(f.b.entry.composer, { text: "B draft", revision: 1 });
    f.manager.revealConversation(f.a.provider);
    assert.equal(f.latest().sidebar.composer.contextBlocked, true);
    await f.dispatch(
      { type: "sidebarViewState", text: "", revision: 99, followingLatest: true, detailVisible: true },
      oldA,
    );
    assert.deepEqual(f.a.entry.composer, { text: "A draft", revision: 1 });
    await f.dispatch({
      type: "sidebarViewState",
      text: "edited A draft",
      revision: 2,
      followingLatest: true,
      detailVisible: true,
      contextBlocked: false,
    });
    await f.rebind();
    assert.deepEqual(f.latest().sidebar.composer, { text: "edited A draft", revision: 2, contextBlocked: true });
    f.manager.revealConversation(f.b.provider);
    assert.deepEqual(f.latest().sidebar.composer, { text: "B draft", revision: 1, contextBlocked: false });
  });
});

test("detached runtime replacements remain blocked even if the original file returns before reveal", async () => {
  await fixture(async (f) => {
    await f.compose("keep through hidden changes", 3);
    const original = f.a.runtime.currentState.sessionFile;
    await f.rebind(() => {
      f.a.updateState({ sessionFile: undefined });
      f.a.updateState({ sessionFile: sessionFile("detached-replacement") });
      assert.equal(f.a.entry.contextBlocked, true);
      f.a.updateState({ sessionFile: original });
    });
    assert.deepEqual(f.latest().sidebar.composer, {
      text: "keep through hidden changes",
      revision: 3,
      contextBlocked: true,
    });
  });
});

test.each(["send", "queueInstruction", "runBackground"])(
  "R11 late old-context text cannot reach %s after replacement with an empty host composer",
  async (type) => {
    await fixture(async (f) => {
      const old = { ...f.binding(), composerContext: f.latest().sidebar.composerContext ?? 0 };
      assert.equal(f.a.entry.composer.text, "");
      f.a.updateState({ sessionFile: sessionFile("unreported-replacement") });
      const delegate = vi.spyOn(f.a.provider, "receiveSidebarMessage").mockResolvedValue(undefined);
      try {
        await f.dispatch(
          {
            type: "sidebarViewState",
            text: "typed for the old session",
            revision: 4,
            followingLatest: true,
            detailVisible: true,
          },
          old,
        );
        await f.dispatch(
          { type, text: "typed for the old session", revision: 4, kind: "steering", isolated: false },
          old,
        );
        assert.equal(delegate.mock.calls.length, 0, "old-context text must not reach the controller");
        assert.deepEqual(f.a.entry.composer, { text: "typed for the old session", revision: 4 });
        assert.equal(f.a.entry.contextBlocked, true, "late text must remain available but blocked");
        assert.ok(f.posted.some((message: any) => message.type === "sendRejected"));
      } finally {
        delegate.mockRestore();
      }
    });
  },
);

test("R11 a late old-context empty report cannot release the replacement guard", async () => {
  await fixture(async (f) => {
    await f.compose("keep old-context text", 4);
    const old = { ...f.binding(), composerContext: f.latest().sidebar.composerContext ?? 0 };
    f.a.updateState({ sessionFile: sessionFile("late-empty-replacement") });
    await f.dispatch(
      { type: "sidebarViewState", text: "", revision: 5, followingLatest: true, detailVisible: true },
      old,
    );
    assert.equal(f.a.entry.contextBlocked, true);
    assert.deepEqual(f.a.entry.composer, { text: "keep old-context text", revision: 4 });
    const current = f.binding();
    for (const composerContext of [undefined, -1, 0.5, NaN, current.composerContext + 1]) {
      await f.dispatch(
        { type: "sidebarViewState", text: "invalid context", revision: 99, followingLatest: true, detailVisible: true },
        { ...current, composerContext },
      );
      assert.deepEqual(f.a.entry.composer, { text: "keep old-context text", revision: 4 });
    }
    await f.compose("", 5);
    assert.equal(f.a.entry.contextBlocked, false, "an empty report from the current context clears the guard");
  });
});

test("all four direct submission routes reject blocked text with source-bound feedback", async () => {
  await fixture(async (f) => {
    await f.compose("do not dispatch", 7);
    f.a.updateState({ sessionFile: sessionFile("replaced-before-send") });
    const origin = f.binding();
    const delegate = vi.spyOn(f.a.provider, "receiveSidebarMessage").mockResolvedValue(undefined);
    try {
      for (const type of ["send", "sendNewSession", "queueInstruction", "runBackground"]) {
        const mark = f.posted.length;
        await f.dispatch({ type, text: "do not dispatch", revision: 7, kind: "steering", isolated: false });
        const replies = f.posted
          .slice(mark)
          .filter((message: any) => ["sendRejected", "notice"].includes(message.type));
        assert.deepEqual(
          replies.map((message: any) => message.type),
          ["sendRejected", "notice"],
        );
        assert.match(replies[1].message, /session changed.*clear the composer/i);
        for (const reply of replies) {
          assert.equal(reply.sidebar.entryId, origin.entryId);
          assert.equal(reply.sidebar.bindingGeneration, origin.bindingGeneration);
          assert.deepEqual(reply.sidebar.composer, { text: "do not dispatch", revision: 7, contextBlocked: true });
        }
      }
      assert.equal(delegate.mock.calls.length, 0);
      assert.equal(f.a.runtime.prompt.mock.calls.length, 0);
      assert.deepEqual(f.a.entry.composer, { text: "do not dispatch", revision: 7 });
      await f.compose("", 8);
      assert.deepEqual(f.latest().sidebar.composer, { text: "", revision: 8, contextBlocked: false });
      await f.compose("fresh text", 9);
      await f.dispatch({ type: "send", text: "fresh text", revision: 9 });
      assert.deepEqual(delegate.mock.calls, [[{ type: "send", text: "fresh text", revision: 9 }]]);
    } finally {
      delegate.mockRestore();
    }
  });
});

test("only a valid empty composer report clears the block; existing text and revision limits remain", async () => {
  await fixture(async (f) => {
    await f.compose("retained", 4);
    f.a.updateState({ sessionFile: sessionFile("replacement-for-empty-guard") });
    for (const changes of [
      { revision: 3 },
      { revision: 4.5 },
      { text: "x".repeat(100_001) },
      { followingLatest: "true" },
      { detailVisible: undefined },
    ]) {
      await f.dispatch({
        type: "sidebarViewState",
        text: "",
        revision: 5,
        followingLatest: true,
        detailVisible: true,
        ...changes,
      });
      assert.deepEqual(f.a.entry.composer, { text: "retained", revision: 4 });
      assert.equal(f.a.entry.contextBlocked, true);
    }
    await f.compose(" ", 5);
    assert.equal(f.a.entry.contextBlocked, true, "whitespace is not an empty composer");
    await f.compose("", 6);
    assert.deepEqual(f.latest().sidebar.composer, { text: "", revision: 6, contextBlocked: false });
    f.a.updateState({ sessionFile: sessionFile("replacement-while-empty") });
    f.a.provider.refreshView();
    assert.equal(f.latest().sidebar.composer.contextBlocked, false);
  });
});

test.each(["before", "during"])("background menu launch rejects replacement %s approval", async (phase) => {
  await fixture(async (f) => {
    await f.compose("text for the original session", 4);
    if (phase === "before") f.a.updateState({ sessionFile: sessionFile("before-background") });
    const start = vi.spyOn(f.a.provider.backgroundAgents, "start").mockResolvedValue(undefined);
    const warning = vi.spyOn(mock.window, "showWarningMessage").mockImplementation(async () => {
      if (phase === "during") f.a.updateState({ sessionFile: sessionFile("during-background") });
      return "Start Background Agent";
    });
    try {
      await assert.rejects(
        f.a.provider.runBackground("text for the original session", false, 4),
        /session changed.*clear the composer/i,
      );
      assert.equal(start.mock.calls.length, 0);
      assert.equal(warning.mock.calls.length, phase === "before" ? 0 : 1);
      assert.equal(f.a.entry.composer.text, "text for the original session");
      assert.equal(f.a.entry.contextBlocked, true);
    } finally {
      start.mockRestore();
      warning.mockRestore();
    }
  });
});

test("late acceptance cannot clear a blocked composer, even with matching text and revision", async () => {
  await fixture(async (f) => {
    await f.compose("submitted", 2);
    f.a.updateState({ sessionFile: sessionFile("replacement-before-acceptance") });
    for (const expected of [
      { expectedText: "submitted", expectedRevision: 1 },
      { expectedText: "other text", expectedRevision: 2 },
    ]) {
      f.a.provider.postMessage({ type: "clearInput", ...expected });
      assert.deepEqual(f.a.entry.composer, { text: "submitted", revision: 2 });
      assert.equal(f.a.entry.contextBlocked, true);
    }
    await f.compose("newer input", 3);
    f.a.provider.postMessage({ type: "clearInput", expectedText: "submitted", expectedRevision: 2 });
    assert.deepEqual(f.a.entry.composer, { text: "newer input", revision: 3 });
    assert.equal(f.a.entry.contextBlocked, true);
    f.a.provider.postMessage({ type: "clearInput", expectedText: "newer input", expectedRevision: 3 });
    const stale = [...f.posted].reverse().find((message: any) => message.type === "clearInput");
    assert.deepEqual(stale.sidebar.composer, { text: "newer input", revision: 3, contextBlocked: true });
    assert.deepEqual(f.a.entry.composer, { text: "newer input", revision: 3 });
    await f.compose("", 4);
    await f.compose("current context text", 5);
    f.a.provider.postMessage({ type: "clearInput", expectedText: "current context text", expectedRevision: 5 });
    assert.deepEqual(f.a.entry.composer, { text: "", revision: 6 });
    assert.equal(f.a.entry.contextBlocked, false);
  });
});
