import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.QuickPickItemKind = { Separator: -1 };
const { SidebarSessions } = require("../sidebarSessions") as typeof import("../sidebarSessions");
const { ConcurrentSessions } = require("../concurrentSessions") as typeof import("../concurrentSessions");
const { InteractiveSessionSlots } =
  require("../interactiveSessionSlots") as typeof import("../interactiveSessionSlots");
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiChatViewProvider, registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
const { registerExtensionUiDialogs } = require("../extensionUiDialogs") as typeof import("../extensionUiDialogs");
const { SessionWriters } = require("../sessionWriters") as typeof import("../sessionWriters");
const { nullLogger } = require("../logging") as typeof import("../logging");

// Only process creation is replaced. Prompts, events, history, dialogs, writer claims, and shutdown use the real hosts.
afterAll(() => mock.restore());

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

const nextTurn = () => new Promise<void>((resolve) => setImmediate(resolve));

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-sidebar-sessions-")));
  const folder = { uri: MockUri.file(root) };
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = (resource: MockUri) => {
    const relative = path.relative(root, resource.fsPath);
    return resource.scheme === "file" &&
      (relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
      ? folder
      : undefined;
  };
  mock.workspace.isTrusted = true;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  mock.window.activeTextEditor = undefined;
  mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
  mock.window.showWarningMessage = async (_message: string, _options: unknown, ...choices: string[]) => choices[0];
  mock.window.showQuickPick = async () => undefined;
  mock.window.showInputBox = async () => undefined;
  const state = new Map<string, unknown>([
    ["pi.sidebar.messages.v1", [{ id: "cached", role: "user", content: "Primary cached text" }]],
  ]);
  const environment = { replace: vi.fn(), clear: vi.fn() };
  const context: any = {
    extensionUri: MockUri.file(process.cwd()),
    globalStorageUri: MockUri.file(root),
    subscriptions: [],
    workspaceState: {
      get: (key: string) => state.get(key),
      update: async (key: string, value: unknown) => {
        if (value === undefined) state.delete(key);
        else state.set(key, value);
      },
    },
    environmentVariableCollection: environment,
  };
  const writers = new SessionWriters();
  const slots = new InteractiveSessionSlots();
  const clients = new Map<any, any>();
  const starts: any[] = [];
  const acceptances = new Map<any, ReturnType<typeof deferred<string>>>();
  let sequence = 0;
  const start = vi.spyOn(PiRuntimeManager.prototype, "ensureStarted").mockImplementation(async function (
    this: any,
    resource?: import("vscode").Uri,
  ) {
    if (this.disposed) throw new Error("Pi runtime disposed.");
    if (this.client?.isRunning) return;
    if (this.fixtureStarting) return this.fixtureStarting;
    this.resource = resource ?? this.resource ?? mock.window.activeTextEditor?.document.uri;
    this.fixtureStarting = (async () => {
      const initial = this.options.initialSession;
      let id = `session-${++sequence}`;
      const sessionFile = initial?.file ?? path.join(root, `${id}.jsonl`);
      let history: any[] = [];
      if (initial) {
        const records = (await readFile(sessionFile, "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        id = records[0].id;
        history = records.filter((record) => record.type === "message").map((record) => record.message);
      } else {
        await writeFile(sessionFile, `${JSON.stringify({ type: "session", id, cwd: this.currentCwd })}\n`);
      }
      const events = new EventEmitter();
      const client: any = {
        isRunning: true,
        active: false,
        stops: 0,
        aborts: 0,
        prompts: [] as string[],
        replies: [] as { id: string; fields: unknown }[],
        onEvent: (listener: (event: unknown) => void) => {
          events.on("event", listener);
          return { dispose: () => events.off("event", listener) };
        },
        getState: async () => ({ sessionId: id, sessionFile, isStreaming: client.active }),
        getMessages: async () => history,
        getSessionStats: async () => ({}),
        getAvailableModels: async () => [],
        getAvailableThinkingLevels: async () => [],
        getCommands: async () => [],
        clearQueue: async () => ({ steering: [], followUp: [] }),
        sendExtensionUiResponse: (requestId: string, fields: unknown) => client.replies.push({ id: requestId, fields }),
        prompt: async (text: string) => {
          client.prompts.push(text);
          history.push({ role: "user", content: text });
          client.active = true;
          events.emit("event", { type: "agent_start" });
          return (await acceptances.get(this)?.promise) ?? "submitted";
        },
        emit: (event: unknown) => events.emit("event", event),
        complete: (text?: string) => {
          client.active = false;
          if (text) {
            const message = { role: "assistant", content: [{ type: "text", text }] };
            history.push(message);
            events.emit("event", { type: "message_end", message });
          }
          events.emit("event", { type: "agent_settled" });
        },
        abort: async () => {
          client.aborts++;
          client.complete();
        },
        stop: async () => {
          client.stops++;
          client.active = false;
          client.isRunning = false;
          events.emit("event", { type: "process_exit", expected: true });
        },
      };
      await writers.commit(client, sessionFile);
      this.client = client;
      this.clientGenerations.set(client, ++this.nextClientGeneration);
      this.clientSubscription = client.onEvent((event: any) => this.handleEvent(event));
      this.state = { ...this.state, connected: true, sessionId: id, sessionFile };
      this.stateEmitter.fire(this.state);
      clients.set(this, client);
      starts.push({ runtime: this, resource, initial });
    })();
    try {
      await this.fixtureStarting;
    } finally {
      this.fixtureStarting = undefined;
    }
  });
  const runtime = new PiRuntimeManager(context, nullLogger, { sessionWriters: writers });
  const primary = registerPiSidebar(context, runtime, nullLogger);
  const dialogs = registerExtensionUiDialogs(context, runtime);
  const manager = new SidebarSessions({
    context,
    primaryRuntime: runtime,
    primary,
    dialogs,
    writers,
    slots,
    logger: nullLogger,
    createConversation: (ownedRuntime, resource, label) =>
      new PiChatViewProvider(
        context,
        ownedRuntime,
        new WorkspaceChangeTracker(),
        primary.backgroundAgents,
        nullLogger,
        { resource, label, reveal: () => {} },
        primary.draftStore,
      ),
  });
  const editors = new ConcurrentSessions(context, runtime, primary, dialogs, writers, nullLogger, slots);
  const events = new EventEmitter();
  const listen = (name: string, listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return { dispose: () => events.off(name, listener) };
  };
  const view = {
    visible: true,
    webview: {
      html: "",
      options: {},
      cspSource: "https://mock.invalid",
      messages: [] as any[],
      asWebviewUri: (uri: MockUri) => uri,
      postMessage: async (message: unknown) => {
        view.webview.messages.push(message);
        return true;
      },
      onDidReceiveMessage: (listener: (...args: any[]) => void) => listen("message", listener),
    },
    receive: (message: unknown) => events.emit("message", message),
    onDidDispose: (listener: () => void) => listen("dispose", listener),
    onDidChangeVisibility: (listener: () => void) => listen("visibility", listener),
  };
  const entries = () => [...(manager as any).entries.values()] as any[];
  const displayed = () => (manager as any).displayed;
  const latest = () => [...view.webview.messages].reverse().find((message) => message.type === "state");
  const binding = () => {
    assert.ok(latest()?.sidebar, "outgoing state must supply the renderer's origin envelope");
    return { entryId: latest().sidebar.entryId, bindingGeneration: latest().sidebar.bindingGeneration };
  };
  const dispatch = (message: Record<string, unknown>, envelope = binding()) =>
    view.receive({ ...message, ...envelope });
  const rows = () =>
    [...view.webview.messages].reverse().find((message) => Array.isArray(message.sessions))?.sessions ?? [];
  const row = (entry: any) => rows().find((item: any) => item.id === entry.id);
  const open = async () => {
    await manager.create();
    const entry = displayed();
    await entry.controller.connectSidebarSession();
    return entry;
  };
  const compose = (text: string, revision = 1, followingLatest = true, detailVisible = true) => {
    dispatch({ type: "sidebarViewState", text, revision, followingLatest, detailVisible });
  };
  const send = async (entry: any, text: string, revision = 1) => {
    assert.equal(displayed(), entry);
    compose(text, revision);
    dispatch({ type: "send", text, revision });
    await vi.waitFor(() => assert.equal(clients.get(entry.runtime)?.active, true));
  };
  const complete = async (entry: any, text: string) => {
    clients.get(entry.runtime).complete(text);
    await vi.waitFor(() => assert.equal(row(entry)?.activity, "completed"));
  };
  try {
    primary.resolveWebviewView(view as any);
    view.receive({ type: "ready" });
    await vi.waitFor(() => assert.equal((primary as any).historyAvailable, true));
    await action({
      root,
      state,
      environment,
      runtime,
      primary,
      manager,
      editors,
      slots,
      writers,
      clients,
      starts,
      acceptances,
      entries,
      displayed,
      view,
      latest,
      binding,
      dispatch,
      rows,
      row,
      open,
      compose,
      send,
      complete,
      a: entries()[0],
    });
  } finally {
    for (const acceptance of acceptances.values()) acceptance.resolve("submitted");
    await editors.shutdown();
    await manager.shutdown();
    await runtime.shutdown();
    for (const disposable of context.subscriptions) disposable.dispose();
    start.mockRestore();
    await nextTurn();
    await rm(root, { recursive: true, force: true });
  }
}

test("one Sidebar view runs A/B concurrently and opens fresh C while both remain busy", async () => {
  await fixture(async (f) => {
    const panelsBefore = mock.panels.length;
    await f.send(f.a, "request A");
    const b = await f.open();
    await f.send(b, "request B");
    assert.equal(f.row(f.a).activity, "running");
    assert.equal(f.row(b).activity, "running");
    f.dispatch({ type: "switchRecentSession", id: f.a.id });
    await vi.waitFor(() => assert.equal(f.latest().sidebar.entryId, f.a.id));
    f.dispatch({ type: "switchRecentSession", id: b.id });
    await vi.waitFor(() => assert.equal(f.latest().sidebar.entryId, b.id));
    f.dispatch({ type: "newSession" });
    await vi.waitFor(() => assert.equal(f.entries().length, 3));
    const c = f.displayed();
    assert.notEqual(c, f.a);
    assert.notEqual(c, b);
    assert.deepEqual(f.latest().messages, []);
    assert.equal(f.latest().sidebar.primary, false);
    assert.equal(f.clients.has(c.runtime), false, "fresh C must not start or reuse a process before Send");
    assert.equal(mock.panels.length, panelsBefore, "Sidebar switching must not allocate native editor panels");
    for (const entry of [f.a, b]) {
      assert.equal(f.clients.get(entry.runtime).active, true);
      assert.equal(f.clients.get(entry.runtime).aborts, 0);
      assert.equal(f.clients.get(entry.runtime).stops, 0);
    }
    await f.complete(f.a, "answer unique A");
    await f.complete(b, "answer unique B");
    assert.equal(f.row(f.a).unread, true);
    assert.equal(f.row(b).unread, true);
    await f.manager.select(f.a.id);
    assert.ok(f.latest().messages.some((message: any) => message.content.includes("answer unique A")));
    assert.ok(!f.latest().messages.some((message: any) => message.content.includes("answer unique B")));
    await f.manager.select(b.id);
    assert.ok(f.latest().messages.some((message: any) => message.content.includes("answer unique B")));
    assert.ok(!f.latest().messages.some((message: any) => message.content.includes("answer unique A")));
    assert.equal(f.clients.get(f.a.runtime).prompts.length, 1);
    assert.equal(f.clients.get(b.runtime).prompts.length, 1);
  });
});

test("source envelopes reject stale sends and Stop; a late A acceptance cannot clear B's composer", async () => {
  await fixture(async (f) => {
    const acceptance = deferred<string>();
    f.acceptances.set(f.a.runtime, acceptance);
    await f.send(f.a, "delayed A", 4);
    const oldA = f.binding();
    const b = await f.open();
    f.compose("keep B draft", 4);
    const mark = f.view.webview.messages.length;
    f.dispatch({ type: "send", text: "wrong owner", revision: 4 }, oldA);
    f.dispatch({ type: "cancel" }, oldA);
    f.dispatch(
      { type: "sidebarViewState", text: "wrong draft", revision: 99, followingLatest: true, detailVisible: true },
      oldA,
    );
    acceptance.resolve("submitted");
    await vi.waitFor(() => assert.equal(f.a.composer.text, ""));
    assert.deepEqual(b.composer, { text: "keep B draft", revision: 4 });
    assert.equal(f.clients.get(b.runtime).prompts.length, 0);
    assert.equal(f.clients.get(f.a.runtime).aborts, 0);
    assert.ok(!f.view.webview.messages.slice(mark).some((message: any) => message.type === "clearInput"));
    await f.manager.select(f.a.id);
    assert.equal(f.latest().sidebar.composer.text, "");
    assert.notEqual(f.binding().bindingGeneration, oldA.bindingGeneration);
    f.dispatch({ type: "cancel" }, oldA);
    await nextTurn();
    assert.equal(f.clients.get(f.a.runtime).aborts, 0, "same entry with an old binding generation remains stale");
    await f.complete(f.a, "accepted by A only");
    await f.manager.select(b.id);
    assert.equal(f.latest().sidebar.composer.text, "keep B draft");
  });
});

test("unread results need a visible latest-following detail and the current result revision", async () => {
  await fixture(async (f) => {
    const b = await f.open();
    await f.send(b, "first B result");
    const oldB = f.binding();
    await f.manager.select(f.a.id);
    await f.complete(b, "first unread answer");
    assert.equal(f.row(b).unread, true);
    f.dispatch({ type: "acknowledgeResult", revision: 1 }, oldB);
    await nextTurn();
    assert.equal(f.row(b).unread, true);
    await f.manager.select(b.id);
    assert.equal(f.row(b).unread, true, "selection is not a rendered-result acknowledgement");
    const revision = f.latest().sidebar.resultRevision;
    assert.equal(revision, 1);
    f.compose("", 2, true, false);
    f.dispatch({ type: "acknowledgeResult", revision });
    assert.equal(f.row(b).unread, true);
    f.compose("", 2, false, true);
    f.dispatch({ type: "acknowledgeResult", revision });
    assert.equal(f.row(b).unread, true);
    f.compose("", 2, true, true);
    f.view.visible = false;
    f.dispatch({ type: "acknowledgeResult", revision });
    assert.equal(f.row(b).unread, true);
    f.view.visible = true;
    f.dispatch({ type: "acknowledgeResult", revision: revision + 1 });
    assert.equal(f.row(b).unread, true);
    f.dispatch({ type: "acknowledgeResult", revision });
    assert.equal(f.row(b).unread, false);
    await f.send(b, "second B result", 3);
    await f.manager.select(f.a.id);
    await f.complete(b, "newer unread answer");
    await f.manager.select(b.id);
    assert.equal(f.latest().sidebar.resultRevision, 2);
    f.compose("", 4);
    f.dispatch({ type: "acknowledgeResult", revision });
    assert.equal(f.row(b).unread, true, "an earlier rendered result cannot acknowledge the newer result");
    f.dispatch({ type: "acknowledgeResult", revision: 2 });
    assert.equal(f.row(b).unread, false);
  });
});

test("Stop cancels only the selected Sidebar runtime and preserves the sibling request", async () => {
  await fixture(async (f) => {
    await f.send(f.a, "keep A running");
    const b = await f.open();
    await f.send(b, "stop B only");
    f.dispatch({ type: "cancel" });
    await vi.waitFor(() => assert.equal(f.row(b)?.activity, "stopped"));
    assert.equal(f.clients.get(b.runtime).aborts, 1);
    assert.equal(f.clients.get(f.a.runtime).aborts, 0);
    assert.equal(f.clients.get(f.a.runtime).active, true);
    await f.manager.select(f.a.id);
    await f.complete(f.a, "A survived B Stop");
    assert.equal(f.clients.get(f.a.runtime).stops, 0);
  });
});

test.each(["cancel", "capacity", "editor", "current", "missing"])(
  "row selection settles its unchanged source binding after %s",
  async (outcome) => {
    await fixture(async (f) => {
      const saved = path.join(f.root, "saved-navigation.jsonl");
      await writeFile(saved, `${JSON.stringify({ type: "session", id: "saved-navigation", cwd: f.root })}\n`);
      await f.manager.showSessions();
      const launcher = f.displayed();
      const savedRow = f.rows().find((row: any) => row.sessionId === "saved-navigation");
      assert.ok(savedRow);
      const releases: (() => void)[] = [];
      const reveal = vi.fn(() => true);
      if (outcome === "cancel") mock.window.showWarningMessage = async () => undefined;
      if (outcome === "capacity") for (let i = 0; i < 8; i++) releases.push(f.slots.acquire());
      if (outcome === "editor") (f.manager as any).services.revealEditorSession = reveal;
      if (outcome === "current") await f.manager.select(f.a.id);
      const origin = f.binding();
      const entry = f.displayed();
      const mark = f.view.webview.messages.length;
      try {
        f.dispatch({
          type: "switchRecentSession",
          id: outcome === "current" ? f.a.id : outcome === "missing" ? "missing" : savedRow.id,
        });
        await vi.waitFor(() => {
          const reply = f.view.webview.messages
            .slice(mark)
            .find((message: any) => message.type === "sessionSwitchRejected");
          assert.ok(reply, "every row selection must settle if it leaves the binding unchanged");
          assert.equal(reply.sidebar.entryId, origin.entryId);
          assert.equal(reply.sidebar.bindingGeneration, origin.bindingGeneration);
        });
        assert.equal(f.displayed(), entry);
        assert.deepEqual(f.binding(), origin);
        assert.equal(f.entries().length, 2, "no runtime is admitted for a cancelled or unchanged selection");
        if (outcome === "editor") assert.deepEqual(reveal.mock.calls, [[saved]]);
        if (outcome !== "current") assert.equal(f.displayed(), launcher);
      } finally {
        for (const release of releases) release();
      }
    });
  },
);

test("a late row selection completion cannot unlock a newer binding of the same launcher", async () => {
  await fixture(async (f) => {
    await writeFile(
      path.join(f.root, "saved-delayed.jsonl"),
      `${JSON.stringify({ type: "session", id: "saved-delayed", cwd: f.root })}\n`,
    );
    await f.manager.showSessions();
    const launcher = f.displayed();
    const row = f.rows().find((row: any) => row.sessionId === "saved-delayed");
    const decision = deferred<string | undefined>();
    const warning = vi.fn(() => decision.promise);
    mock.window.showWarningMessage = warning;
    f.dispatch({ type: "switchRecentSession", id: row.id });
    await vi.waitFor(() => assert.equal(warning.mock.calls.length, 1));
    f.manager.revealConversation(f.primary);
    await f.manager.showSessions();
    assert.equal(f.displayed(), launcher);
    const mark = f.view.webview.messages.length;
    decision.resolve(undefined);
    await vi.waitFor(() => assert.equal((f.manager as any).navigating, false));
    assert.ok(!f.view.webview.messages.slice(mark).some((message: any) => message.type === "sessionSwitchRejected"));
  });
});

test("returning to A redelivers a retained image evicted from the shared renderer by B", async () => {
  await fixture(async (f) => {
    const browserAssets = new Set<string>();
    const evictions: any[] = [];
    const post = f.view.webview.postMessage;
    f.view.webview.postMessage = async (message: any) => {
      const delivered = await post(message);
      if (message.type === "imageAsset" && !browserAssets.has(message.id)) {
        if (browserAssets.size === 100) {
          const id = browserAssets.values().next().value!;
          browserAssets.delete(id);
          evictions.push({ id, entryId: message.sidebar.entryId });
          f.dispatch(
            { type: "imageAssetEvicted", id },
            {
              entryId: message.sidebar.entryId,
              bindingGeneration: message.sidebar.bindingGeneration,
            },
          );
        }
        browserAssets.add(message.id);
      }
      return delivered;
    };
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MZkAAAAASUVORK5CYII=",
      "base64",
    );
    const images = (entry: any, count: number, offset: number) => {
      const assets = Array.from({ length: count }, (_, i) =>
        entry.controller.imageAssets.store(
          "image/png",
          Buffer.concat([png, Buffer.from([offset + i])]).toString("base64"),
        ),
      );
      assert.ok(assets.every(Boolean));
      entry.controller.messages = [
        {
          id: `${entry.id}-images`,
          role: "user",
          content: "Retained images",
          attachments: assets.map((asset: any) => ({
            type: "image",
            assetId: asset.id,
            label: "retained.png",
            mimeType: asset.mimeType,
            width: asset.width,
            height: asset.height,
            availability: "available",
          })),
        },
      ];
      return assets;
    };
    const [aImage] = images(f.a, 1, 200);
    f.a.controller.refreshView();
    await nextTurn();
    assert.equal(browserAssets.has(aImage.id), true);
    const b = await f.open();
    images(b, 100, 0);
    b.controller.refreshView();
    await nextTurn();
    assert.equal(browserAssets.has(aImage.id), false);
    assert.ok(evictions.some((event) => event.id === aImage.id && event.entryId === b.id));
    assert.equal(f.a.controller.imageAssets.has(aImage.id), true, "A still owns the validated host payload");
    const mark = f.view.webview.messages.length;
    await f.manager.select(f.a.id);
    await nextTurn();
    const resent = f.view.webview.messages.slice(mark).filter((message: any) => message.type === "imageAsset");
    assert.equal(resent.length, 1);
    assert.equal(resent[0].id, aImage.id);
    assert.equal(resent[0].sidebar.entryId, f.a.id);
    assert.equal(browserAssets.has(aImage.id), true);
    f.a.controller.refreshView();
    await nextTurn();
    assert.equal(
      f.view.webview.messages.slice(mark).filter((message: any) => message.type === "imageAsset").length,
      1,
      "ordinary state refreshes must not resend payloads",
    );
  });
});

test("saved unloaded B gets an independent owner while A is busy and reuses it on reselection", async () => {
  await fixture(async (f) => {
    const saved = path.join(f.root, "saved-b.jsonl");
    const records = [
      { type: "session", id: "saved-B", cwd: f.root },
      { type: "session_info", name: "Saved B" },
      { type: "message", message: { role: "user", content: "saved B question" } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "saved B answer" }] } },
    ];
    const original = `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
    await writeFile(saved, original);
    await f.send(f.a, "A stays busy while loading B");
    await f.manager.showSessions();
    const savedRow = f.rows().find((row: any) => row.title === "Saved B");
    assert.ok(savedRow);
    f.dispatch({ type: "switchRecentSession", id: savedRow.id });
    await vi.waitFor(() => assert.equal(f.displayed().runtime.currentState.sessionId, "saved-B"));
    const b = f.displayed();
    await vi.waitFor(() => assert.ok(f.latest().messages.some((message: any) => message.content === "saved B answer")));
    assert.equal(b.runtime.currentState.sessionFile, saved);
    assert.equal(f.clients.get(f.a.runtime).active, true);
    assert.equal(f.clients.get(f.a.runtime).aborts, 0);
    assert.equal(f.slots.count, 1, "the Sessions launcher itself must not consume an interactive slot");
    const count = f.starts.length;
    await f.manager.select(f.a.id);
    await f.manager.select(savedRow.id);
    assert.equal(f.displayed(), b);
    assert.equal(f.starts.length, count);
    assert.equal(await readFile(saved, "utf8"), original, "opening a saved session must not replace its history");
    await f.complete(f.a, "A completed independently");
  });
});

test("auxiliary Sidebar prompts and close leave Primary persistence and terminal environment untouched", async () => {
  await fixture(async (f) => {
    const before = new Map(f.state);
    const primaryFile = f.runtime.currentState.sessionFile;
    const b = await f.open();
    assert.equal(b.controller.draftStore, f.primary.draftStore);
    assert.equal(b.controller.backgroundAgents, f.primary.backgroundAgents);
    assert.deepEqual(b.controller.messages, []);
    await b.runtime.initializeBridge();
    await f.send(b, "memory-only auxiliary transcript");
    await f.complete(b, "memory-only auxiliary answer");
    f.dispatch({ type: "closeSidebarSession" });
    await vi.waitFor(() => assert.ok(!f.entries().includes(b)));
    assert.deepEqual(f.state, before);
    assert.equal(f.runtime.currentState.sessionFile, primaryFile);
    assert.equal(f.clients.get(f.runtime).stops, 0);
    assert.equal(f.environment.replace.mock.calls.length, 0);
    assert.equal(f.environment.clear.mock.calls.length, 0);
    assert.equal(f.slots.count, 0);
    assert.equal(f.latest().sidebar.primary, true);
    assert.equal(f.latest().sidebar.canClose, false);
  });
});

test("shared editor/Sidebar capacity retains an unverified Sidebar slot and writer", async () => {
  await fixture(async (f) => {
    await f.editors.open();
    const editor = [...(f.editors as any).sessions][0] as any;
    await vi.waitFor(() => assert.ok(f.clients.has(editor.runtime)));
    const sidebar = [];
    for (let index = 0; index < 7; index++) sidebar.push(await f.open());
    assert.equal(f.slots.count, 8);
    await assert.rejects(f.manager.create(), /session slot/);
    await assert.rejects(f.editors.open(), /session slot/);
    const quarantined = sidebar[0];
    await f.manager.select(quarantined.id);
    const file = quarantined.runtime.currentState.sessionFile;
    f.clients.get(quarantined.runtime).emit({ type: "runtime_warning", warningCode: "cleanup-unverified" });
    f.dispatch({ type: "closeSidebarSession" });
    await vi.waitFor(() => assert.ok(quarantined.closing));
    await quarantined.closing;
    assert.equal(f.slots.count, 8);
    assert.ok(f.entries().includes(quarantined));
    assert.ok(!f.rows().some((row: any) => row.id === quarantined.id), "closed quarantine is not selectable live work");
    await assert.rejects(f.writers.reserve({}, file), /already open|not stopped safely/);
    await assert.rejects(f.manager.create(), /session slot/);
    const clean = sidebar[1];
    await f.manager.select(clean.id);
    f.dispatch({ type: "closeSidebarSession" });
    await vi.waitFor(() => assert.equal(f.slots.count, 7));
    assert.equal(f.clients.get(editor.runtime).stops, 0);
    assert.equal(f.clients.get(f.runtime).stops, 0);
    await f.editors.open();
    assert.equal(f.slots.count, 8, "verified Sidebar cleanup frees capacity for an editor session");
  });
});

test("native dialogs retain their runtime owner across Sidebar switches and ignore replies after close", async () => {
  await fixture(async (f) => {
    const a = await f.open();
    const b = await f.open();
    const inputs: { title: string; result: ReturnType<typeof deferred<string>> }[] = [];
    mock.window.showInputBox = async (options: { title: string }) => {
      const result = deferred<string>();
      inputs.push({ title: options.title, result });
      return result.promise;
    };
    const ca = f.clients.get(a.runtime);
    const cb = f.clients.get(b.runtime);
    ca.emit({ type: "extension_ui_request", id: "same-id", method: "input", title: "Question A" });
    cb.emit({ type: "extension_ui_request", id: "same-id", method: "input", title: "Question B" });
    await vi.waitFor(() => assert.equal(inputs.length, 2));
    assert.equal(f.row(a).activity, "waiting");
    assert.equal(f.row(b).activity, "waiting");
    await f.manager.select(a.id);
    f.dispatch({ type: "closeSidebarSession" });
    await vi.waitFor(() => assert.ok(!f.entries().includes(a)));
    assert.equal(cb.stops, 0);
    inputs.find((input) => input.title.includes("Question B"))!.result.resolve("answer to B");
    await vi.waitFor(() => assert.deepEqual(cb.replies, [{ id: "same-id", fields: { value: "answer to B" } }]));
    inputs.find((input) => input.title.includes("Question A"))!.result.resolve("late answer to closed A");
    await nextTurn();
    assert.deepEqual(ca.replies, []);
    assert.equal(f.row(b).activity, "idle");
    assert.equal(f.runtime.hasPendingExtensionDialogs, false);
  });
});

for (const action of ["create", "select", "showSessions"] as const) {
  test(`${action} cleans up a runtime when the conversation factory throws`, async () => {
    await fixture(async (f) => {
      const services = (f.manager as any).services;
      let failedRuntime: any;
      let shutdown: any;
      const factory = vi.spyOn(services, "createConversation").mockImplementation((runtime: any) => {
        failedRuntime = runtime;
        shutdown = vi.spyOn(runtime, "shutdown");
        throw new Error("injected conversation factory failure");
      });
      try {
        const saved = path.join(f.root, "factory-failure.jsonl");
        await writeFile(saved, `${JSON.stringify({ type: "session", id: "saved-failure", cwd: f.root })}\n`);
        (f.manager as any).summaries = [
          { key: "saved-failure", path: saved, sessionId: "saved-failure", title: "Saved", updatedAt: 0 },
        ];
        await assert.rejects(f.manager[action]("saved-failure"), /injected conversation factory failure/);
        assert.ok(failedRuntime);
        assert.equal(shutdown.mock.calls.length, 1);
        assert.equal(failedRuntime.disposed, true);
        assert.equal(f.entries().length, 1);
        assert.equal(f.displayed(), f.a);
        assert.equal(f.slots.count, 0, "verified factory cleanup must release any acquired slot");
      } finally {
        factory.mockRestore();
        shutdown?.mockRestore();
      }
    });
  });
}

test("post-entry setup failure retains admission until cleanup and disposes partial registrations", async () => {
  await fixture(async (f) => {
    const services = (f.manager as any).services;
    const dialogs = services.dialogs as any;
    const initialDialogs = dialogs.runtimeSubscriptions.size;
    const createConversation = services.createConversation;
    const cleanup = deferred<void>();
    let controllerDispose: any;
    let trackerDispose: any;
    let failedRuntime: any;
    const factory = vi.spyOn(services, "createConversation").mockImplementation((...args: any[]) => {
      const controller = createConversation(...args);
      failedRuntime = args[0];
      const shutdown = failedRuntime.shutdown.bind(failedRuntime);
      vi.spyOn(failedRuntime, "shutdown").mockImplementationOnce(async () => {
        await cleanup.promise;
        await shutdown();
      });
      controllerDispose = vi.spyOn(controller, "dispose");
      trackerDispose = vi.spyOn(controller.changeTracker, "dispose");
      return controller;
    });
    const checkpoint = vi.spyOn(f.primary, "addCheckpointTracker").mockImplementationOnce(() => {
      throw new Error("injected checkpoint registration failure");
    });
    try {
      const creation = assert.rejects(f.manager.create(), /injected checkpoint registration failure/);
      await vi.waitFor(() => assert.ok(f.entries().find((entry: any) => entry !== f.a)?.closing));
      assert.equal(f.slots.count, 1);
      assert.equal(f.entries().length, 2, "a partial entry remains owned until shutdown settles");
      assert.equal(dialogs.runtimeSubscriptions.size, initialDialogs + 1);
      cleanup.resolve();
      await creation;
      assert.equal(failedRuntime.disposed, true);
      assert.equal(controllerDispose.mock.calls.length, 1);
      assert.equal(trackerDispose.mock.calls.length, 1);
      assert.equal(dialogs.runtimeSubscriptions.size, initialDialogs);
      assert.equal(f.entries().length, 1);
      assert.equal(f.slots.count, 0);
      assert.equal(f.displayed(), f.a);
    } finally {
      cleanup.resolve();
      checkpoint.mockRestore();
      factory.mockRestore();
    }
  });
});

test("failed post-entry setup keeps slot, writer, and root quarantine for late cleanup warnings", async () => {
  await fixture(async (f) => {
    const services = (f.manager as any).services;
    const createConversation = services.createConversation;
    let failedRuntime: any;
    let controllerDispose: any;
    let trackerDispose: any;
    let failedClient: any;
    const initialDialogs = (services.dialogs as any).runtimeSubscriptions.size;
    const factory = vi.spyOn(services, "createConversation").mockImplementation((...args: any[]) => {
      const controller = createConversation(...args);
      failedRuntime = args[0];
      controllerDispose = vi.spyOn(controller, "dispose");
      trackerDispose = vi.spyOn(controller.changeTracker, "dispose");
      const shutdown = failedRuntime.shutdown.bind(failedRuntime);
      vi.spyOn(failedRuntime, "shutdown").mockImplementationOnce(async () => {
        await failedRuntime.ensureStarted(args[1]);
        failedClient = f.clients.get(failedRuntime);
        // The fixture replaces process creation, including the runtime's normal launch-root bookkeeping.
        failedRuntime.clientRoots.set(failedClient, f.root);
        const stop = failedClient.stop;
        failedClient.stop = async () => {
          await nextTurn();
          failedClient.emit({ type: "runtime_warning", warningCode: "cleanup-unverified" });
          await stop();
        };
        await shutdown();
      });
      return controller;
    });
    const attach = vi.spyOn(f.manager as any, "attach").mockImplementationOnce(() => {
      throw new Error("injected view setup failure");
    });
    try {
      await assert.rejects(f.manager.create(), /injected view setup failure/);
      const partial = f.entries().find((entry: any) => entry.runtime === failedRuntime);
      assert.ok(partial?.closing);
      assert.equal(partial.cleanupUnverified, true);
      assert.equal(f.slots.count, 1, "uncertain cleanup must not return the transferred reservation");
      assert.equal(failedRuntime.disposed, true);
      assert.equal(failedClient.stops, 1);
      assert.equal(controllerDispose.mock.calls.length, 1);
      assert.equal(trackerDispose.mock.calls.length, 1);
      assert.equal((services.dialogs as any).runtimeSubscriptions.size, initialDialogs);
      assert.equal(f.displayed(), f.a);
      await assert.rejects(f.writers.reserve({}, partial.runtime.currentState.sessionFile), /not stopped safely/);
      const { acquireOperation } = require("../operationLocks") as typeof import("../operationLocks");
      assert.throws(() => acquireOperation(f.root, "test exclusive operation"), /cleanup is unverified/);
      assert.ok(!f.rows().some((row: any) => row.id === partial.id));
    } finally {
      attach.mockRestore();
      factory.mockRestore();
    }
  });
});

test("navigation admission rejects overlapping actions before asynchronous workspace validation", async () => {
  await fixture(async (f) => {
    const b = await f.open();
    const c = await f.open();
    await f.manager.select(f.a.id);
    const paused = deferred<any>();
    const workspace = vi.spyOn(f.manager as any, "workspace").mockImplementationOnce(() => paused.promise);
    const pending = f.manager.select(b.id);
    try {
      await f.manager.select(c.id);
      assert.equal(f.displayed(), f.a, "a second navigation must not overtake the accepted selection");
      await assert.rejects(f.manager.quickSwitch(), /already pending/);
    } finally {
      paused.resolve({ uri: MockUri.file(f.root), root: f.root });
      await pending;
      workspace.mockRestore();
    }
    assert.equal(f.displayed(), b);
  });
});

test("inactive composer updates stay with their origin and enforce captured revisions", async () => {
  await fixture(async (f) => {
    f.compose("A original draft", 4);
    const b = await f.open();
    f.compose("B must stay unchanged", 7);
    f.clients.get(f.a.runtime).emit({
      type: "extension_ui_request",
      id: "A-editor-text",
      method: "set_editor_text",
      text: "A extension replacement",
    });
    await nextTurn();
    assert.deepEqual(f.a.composer, { text: "A extension replacement", revision: 5 });
    assert.deepEqual(b.composer, { text: "B must stay unchanged", revision: 7 });
    (f.manager as any).fromController(f.a, {
      type: "setInput",
      text: "stale picker",
      expectedRevision: 4,
      expectedText: "A original draft",
    });
    assert.equal(f.a.composer.text, "A extension replacement");
    (f.manager as any).fromController(f.a, {
      type: "appendDraft",
      text: "A recovered text",
      expectedRevision: 5,
    });
    assert.equal(f.a.composer.text, "A extension replacement\n\nA recovered text");
    await f.manager.select(f.a.id);
    assert.equal(f.latest().sidebar.composer.text, "A extension replacement\n\nA recovered text");
    assert.equal(f.latest().sidebar.composer.revision, 6);
    assert.equal(b.composer.text, "B must stay unchanged");
  });
});

test("inactive recovery handshakes and warnings are delivered only after their owner is selected", async () => {
  await fixture(async (f) => {
    f.compose("A guarded draft", 3);
    const b = await f.open();
    const mark = f.view.webview.messages.length;
    (f.manager as any).fromController(f.a, {
      type: "appendDraft",
      text: "A image recovery",
      expectedRevision: 3,
      recoveredDraftId: "A-recovery-id",
    });
    (f.manager as any).fromController(f.a, { type: "notice", level: "warning", message: "A-only warning" });
    assert.equal(f.a.composer.text, "A guarded draft", "attachment restoration must keep its existing handshake");
    assert.equal(f.a.pendingComposerUpdates.length, 1);
    assert.ok(
      !f.view.webview.messages
        .slice(mark)
        .some((message: any) => message.type === "appendDraft" || message.message === "A-only warning"),
    );
    await f.manager.select(f.a.id);
    const delivered = f.view.webview.messages
      .slice(mark)
      .filter((message: any) => message.type === "appendDraft" || message.message === "A-only warning");
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((message: any) => message.sidebar.entryId === f.a.id));
    assert.ok(delivered.every((message: any) => message.sidebar.entryId !== b.id));
    assert.equal(f.a.pendingComposerUpdates.length, 0);
  });
});

test("cancelled or rejected launcher submissions settle without losing their originating draft", async () => {
  await fixture(async (f) => {
    await f.manager.showSessions();
    const launcher = f.displayed();
    f.compose("retain cancelled launcher", 5, true, false);
    mock.window.showWarningMessage = async () => undefined;
    const mark = f.view.webview.messages.length;
    f.dispatch({ type: "sendNewSession", text: launcher.composer.text, revision: 5 });
    await vi.waitFor(() => assert.ok(f.view.webview.messages.slice(mark).some((m: any) => m.type === "sendRejected")));
    assert.equal(f.displayed(), launcher);
    assert.equal(launcher.composer.text, "retain cancelled launcher");
    assert.equal(f.slots.count, 0);
    const releases = Array.from({ length: 8 }, () => f.slots.acquire());
    try {
      const rejected = f.view.webview.messages.length;
      f.dispatch({ type: "sendNewSession", text: launcher.composer.text, revision: 5 });
      await vi.waitFor(() =>
        assert.ok(f.view.webview.messages.slice(rejected).some((m: any) => m.type === "sendRejected")),
      );
      assert.equal(launcher.composer.text, "retain cancelled launcher");
    } finally {
      for (const release of releases) release();
    }
  });
});

test("cancelled slash navigation settles the captured submission and preserves its draft", async () => {
  await fixture(async (f) => {
    mock.window.showWarningMessage = async () => undefined;
    mock.window.showOpenDialog = async () => undefined;
    for (const text of ["/new", "/resume"]) {
      f.compose(text, f.a.composer.revision + 1);
      const mark = f.view.webview.messages.length;
      f.dispatch({ type: "send", text, revision: f.a.composer.revision });
      await vi.waitFor(() =>
        assert.ok(f.view.webview.messages.slice(mark).some((m: any) => m.type === "sendRejected")),
      );
      assert.equal(f.displayed(), f.a);
      assert.equal(f.a.composer.text, text);
      assert.ok(!f.view.webview.messages.slice(mark).some((m: any) => m.type === "clearInput"));
    }
    await f.manager.showSessions();
    const launcher = f.displayed();
    f.compose("/resume", 3, true, false);
    const mark = f.view.webview.messages.length;
    f.dispatch({ type: "sendNewSession", text: "/resume", revision: 3 });
    await vi.waitFor(() => assert.ok(f.view.webview.messages.slice(mark).some((m: any) => m.type === "sendRejected")));
    assert.equal(f.displayed(), launcher);
    assert.equal(launcher.composer.text, "/resume");
  });
});

test("promoted launcher retains acceptance ownership then saves later drafts under its session", async () => {
  await fixture(async (f) => {
    f.primary.draftStore.enable();
    await f.manager.showSessions();
    const entry = f.displayed();
    f.compose("launcher request", 2, true, false);
    const drafts = (entry.controller as any).drafts;
    assert.equal(drafts.scope, "sessions");
    f.dispatch({ type: "draftChanged", binding: drafts.binding.id, revision: 2, text: "launcher request" });
    await nextTurn();
    assert.equal(f.primary.draftStore.get("sessions")?.text, "launcher request");
    f.dispatch({ type: "sendNewSession", text: "launcher request", revision: 2 });
    await vi.waitFor(() => assert.equal(f.clients.get(entry.runtime)?.active, true));
    await vi.waitFor(() => assert.equal(entry.composer.text, ""));
    assert.equal(drafts.scope, "session");
    assert.notEqual(drafts.binding.owner, "sessions");
    assert.equal(f.primary.draftStore.get("sessions"), undefined, "acceptance clears only the captured launcher draft");
    f.compose("later session-only draft", 7);
    f.dispatch({ type: "draftChanged", binding: drafts.binding.id, revision: 7, text: "later session-only draft" });
    await nextTurn();
    assert.equal(f.primary.draftStore.get(drafts.binding.owner)?.text, "later session-only draft");
    await f.manager.showSessions();
    assert.notEqual(f.displayed(), entry);
    assert.equal(f.primary.draftStore.get("sessions"), undefined);
    assert.equal(f.displayed().composer.text, "");
    await f.complete(entry, "result after draft handoff");
    const controlled = f.displayed();
    f.dispatch({ type: "pickModel" });
    const controlledDrafts = (controlled.controller as any).drafts;
    await vi.waitFor(() => {
      assert.equal(controlledDrafts.scope, "session");
      assert.ok(controlledDrafts.binding.owner);
      assert.notEqual(controlledDrafts.binding.owner, "sessions");
    });
    f.compose("control-promoted session draft", 9);
    f.dispatch({
      type: "draftChanged",
      binding: controlledDrafts.binding.id,
      revision: 9,
      text: "control-promoted session draft",
    });
    await nextTurn();
    assert.equal(f.primary.draftStore.get(controlledDrafts.binding.owner)?.text, "control-promoted session draft");
    assert.equal(f.primary.draftStore.get("sessions"), undefined);
  });
});

test("background token events do not repeat unchanged list metadata or copy the active composer", async () => {
  await fixture(async (f) => {
    await f.send(f.a, "stream A");
    const b = await f.open();
    f.compose("B draft", 9);
    await nextTurn();
    const mark = f.view.webview.messages.length;
    for (let i = 0; i < 20; i++) f.clients.get(f.a.runtime).emit({ type: "message_update" });
    await nextTurn();
    const updates = f.view.webview.messages.slice(mark).filter((m: any) => m.type === "sidebarSessions");
    assert.equal(updates.length, 0);
    assert.deepEqual(b.composer, { text: "B draft", revision: 9 });
    await f.complete(f.a, "settled A result");
  });
});

test("factory failure before entry creation still retains admission on uncertain shutdown", async () => {
  await fixture(async (f) => {
    const services = (f.manager as any).services;
    let failedRuntime: any;
    const factory = vi.spyOn(services, "createConversation").mockImplementation((runtime: any) => {
      failedRuntime = runtime;
      const shutdown = runtime.shutdown.bind(runtime);
      vi.spyOn(runtime, "shutdown").mockImplementationOnce(async () => {
        await nextTurn();
        runtime.eventEmitter.fire({ type: "runtime_warning", warningCode: "cleanup-unverified" });
        await shutdown();
      });
      throw new Error("injected factory failure with uncertain cleanup");
    });
    try {
      await assert.rejects(f.manager.create(), /injected factory failure with uncertain cleanup/);
      assert.equal(failedRuntime.disposed, true);
      assert.equal(f.slots.count, 1);
      assert.equal(f.entries().length, 1, "a controller-less failure must not fabricate a selectable entry");
      assert.equal(f.displayed(), f.a);
    } finally {
      factory.mockRestore();
    }
  });
});

test.each(["same-owner", "cross-owner"] as const)(
  "out-of-order %s refreshes keep the newest saved index",
  async (mode) => {
    await fixture(async (f) => {
      await vi.waitFor(() => assert.equal(f.primary.status, "Ready"));
      const latestOwner = mode === "cross-owner" ? await f.open() : f.a;
      await f.manager.select(f.a.id);
      const [olderIndex, newerIndex] = ["older-index", "newer-index"].map((id) => [
        { key: id, path: path.join(f.root, `${id}.jsonl`), sessionId: id, title: id, updatedAt: 0 },
      ]);
      const olderScan = deferred<import("../sessionHistory").PiSessionSummary[]>();
      const newerScan = deferred<import("../sessionHistory").PiSessionSummary[]>();
      const scans = vi
        .spyOn(require("../sessionHistory"), "listRecentPiSessions")
        .mockImplementationOnce(() => olderScan.promise)
        .mockImplementationOnce(() => newerScan.promise);
      const pending: Promise<void>[] = [];
      try {
        const older = f.manager.refresh();
        pending.push(older);
        await f.manager.select(latestOwner.id);
        const newer = f.manager.refresh();
        pending.push(newer);
        assert.deepEqual(scans.mock.calls, [
          [f.a.runtime.currentState.sessionFile, f.a.runtime.currentCwd],
          [latestOwner.runtime.currentState.sessionFile, latestOwner.runtime.currentCwd],
        ]);
        newerScan.resolve(newerIndex);
        await newer;
        assert.deepEqual((f.manager as any).summaries, newerIndex);
        olderScan.resolve(olderIndex);
        await older;
        assert.deepEqual((f.manager as any).summaries, newerIndex);
        assert.ok(f.rows().some((row: any) => row.id === "newer-index"));
        assert.ok(!f.rows().some((row: any) => row.id === "older-index"));
      } finally {
        olderScan.resolve([]);
        newerScan.resolve([]);
        await Promise.all(pending);
        scans.mockRestore();
      }
    });
  },
);

test("selection changes without a newer scan preserve the saved index on stale refresh completion", async () => {
  await fixture(async (f) => {
    await vi.waitFor(() => assert.equal(f.primary.status, "Ready"));
    const b = await f.open();
    await f.manager.select(f.a.id);
    const [retainedIndex, staleIndex] = ["retained-index", "stale-index"].map((id) => [
      { key: id, path: path.join(f.root, `${id}.jsonl`), sessionId: id, title: id, updatedAt: 0 },
    ]);
    const staleScan = deferred<import("../sessionHistory").PiSessionSummary[]>();
    const scans = vi
      .spyOn(require("../sessionHistory"), "listRecentPiSessions")
      .mockResolvedValueOnce(retainedIndex)
      .mockImplementationOnce(() => staleScan.promise);
    const pending: Promise<void>[] = [];
    try {
      await f.manager.refresh();
      assert.deepEqual((f.manager as any).summaries, retainedIndex);
      const stale = f.manager.refresh();
      pending.push(stale);
      await f.manager.select(b.id);
      assert.equal(f.displayed(), b);
      assert.equal(scans.mock.calls.length, 2, "selection must not start a newer scan in this regression");
      staleScan.resolve(staleIndex);
      await stale;
      assert.equal(scans.mock.calls.length, 2);
      assert.deepEqual((f.manager as any).summaries, retainedIndex);
      assert.ok(f.rows().some((row: any) => row.id === "retained-index"));
      assert.ok(!f.rows().some((row: any) => row.id === "stale-index"));
    } finally {
      staleScan.resolve([]);
      await Promise.all(pending);
      scans.mockRestore();
    }
  });
});
