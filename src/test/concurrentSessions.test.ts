import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.QuickPickItemKind = { Separator: -1 };
const { ConcurrentSessions } = require("../concurrentSessions") as typeof import("../concurrentSessions");
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { registerExtensionUiDialogs } = require("../extensionUiDialogs") as typeof import("../extensionUiDialogs");
const { SessionWriters } = require("../sessionWriters") as typeof import("../sessionWriters");
const { nullLogger } = require("../logging") as typeof import("../logging");
const { readPiInvocationSettings } = require("../vscodePi") as typeof import("../vscodePi");

afterAll(() => mock.restore());

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-concurrent-ui-")));
  const folder = { uri: MockUri.file(root) };
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = (resource: MockUri) =>
    [...mock.workspace.workspaceFolders]
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
      .find(({ uri }) => {
        if (uri.scheme !== resource.scheme) return false;
        const relative = path.relative(uri.fsPath, resource.fsPath);
        return (
          relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
        );
      });
  mock.workspace.isTrusted = true;
  mock.window.activeTextEditor = undefined;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
  mock.window.showWarningMessage = async () => "Open Session";
  const state = new Map<string, unknown>();
  state.set("pi.sidebar.messages.v1", [{ id: "cached", role: "user", content: "sidebar cached text" }]);
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
  const clients = new Map<any, any>();
  const starts: { runtime: any; resource?: import("vscode").Uri }[] = [];
  let sequence = 0;
  const start = vi.spyOn(PiRuntimeManager.prototype, "ensureStarted").mockImplementation(async function (
    this: any,
    resource?: import("vscode").Uri,
  ) {
    starts.push({ runtime: this, resource });
    if (this.disposed) throw new Error("Pi runtime disposed.");
    if (this.client?.isRunning) return;
    if (this.fixtureStarting) return this.fixtureStarting;
    this.resource = resource ?? this.resource ?? mock.window.activeTextEditor?.document.uri;
    this.fixtureStarting = (async () => {
      const id = `session-${++sequence}`;
      const sessionFile = path.join(root, `${id}.jsonl`);
      await writeFile(sessionFile, `${JSON.stringify({ type: "session", id, cwd: this.currentCwd })}\n`);
      const events = new EventEmitter();
      const history: any[] = [];
      const client: any = {
        isRunning: true,
        active: false,
        stops: 0,
        aborts: 0,
        prompts: [] as string[],
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
        prompt: async (text: string) => {
          client.prompts.push(text);
          history.push({ role: "user", content: text });
          client.active = true;
          events.emit("event", { type: "agent_start" });
          return "submitted";
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
  const manager = new ConcurrentSessions(context, runtime, primary, dialogs, writers, nullLogger);
  const entries = () => [...(manager as any).sessions] as any[];
  const open = async () => {
    await manager.open();
    const session = entries().at(-1)!;
    session.panel.receive({ type: "ready" });
    session.panel.receive({ type: "draftSelect", scope: "session" });
    await vi.waitFor(() => assert.equal(session.provider.historyAvailable, true));
    return session;
  };
  try {
    await action({ root, state, environment, runtime, primary, manager, clients, starts, entries, open });
  } finally {
    await manager.shutdown();
    await runtime.shutdown();
    for (const disposable of context.subscriptions) disposable.dispose();
    start.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

async function aliasedWorkspace(f: any) {
  const target = path.join(f.root, "workspace-a");
  const other = path.join(f.root, "workspace-b");
  const alias = path.join(f.root, "opened-a");
  const alternate = path.join(f.root, "alternate-a");
  await mkdir(target);
  await mkdir(other);
  const linkType = process.platform === "win32" ? "junction" : "dir";
  await symlink(target, alias, linkType);
  await symlink(target, alternate, linkType);
  const folder = { uri: MockUri.file(alias) };
  const otherFolder = { uri: MockUri.file(other) };
  mock.workspace.workspaceFolders = [otherFolder, folder, { uri: MockUri.file(alternate) }];
  f.runtime.resource = MockUri.joinPath(folder.uri, "source.ts");
  return { target, other, alias, alternate, folder, otherFolder, linkType };
}

test("an opened workspace alias is used for folder lookup and panel startup settings", async () => {
  await fixture(async (f) => {
    const { target, folder, otherFolder } = await aliasedWorkspace(f);
    assert.equal(mock.workspace.getWorkspaceFolder(MockUri.file(target)), undefined);
    assert.equal(mock.workspace.getWorkspaceFolder(folder.uri), folder);
    mock.workspace.getConfiguration = (_section: string, resource?: MockUri) => ({
      get: (key: string, fallback: unknown) =>
        key === "model"
          ? mock.workspace.getWorkspaceFolder(resource ?? otherFolder.uri) === folder
            ? "model-a"
            : "model-b"
          : fallback,
    });
    const session = await f.open();
    assert.equal(f.starts.find((start: any) => start.runtime === session.runtime)?.resource, folder.uri);
    assert.equal(session.provider.surface.resource, folder.uri);
    assert.deepEqual(session.runtime.options.editorWorkspace, { uri: folder.uri, root: target });
    assert.equal(session.runtime.resource, folder.uri);
    assert.equal(session.runtime.currentCwd, folder.uri.fsPath);
    assert.equal(readPiInvocationSettings(session.runtime.resource).model, "model-a");
    const request = session.provider.runRequest("alias request", [], []);
    await vi.waitFor(() => assert.equal(f.clients.get(session.runtime).active, true));
    assert.equal(hasOperation(target), true, "requests must lock the canonical workspace, not its alias");
    f.clients.get(session.runtime).complete("alias response");
    assert.equal(await request, "alias response");
  });
});

test.each(["alias", "cwd", "folder"])("panel creation rejects a changed %s after confirmation", async (change) => {
  await fixture(async (f) => {
    const { alias, alternate, other, linkType } = await aliasedWorkspace(f);
    const cwd = change === "folder" ? vi.spyOn(f.runtime, "currentCwd", "get").mockReturnValue(alias) : undefined;
    mock.window.showWarningMessage = async () => {
      if (change === "alias") {
        await rm(alias);
        await symlink(other, alias, linkType);
      } else if (change === "cwd") {
        // Both aliases resolve to the same root; a canonical-only check cannot detect this change.
        f.runtime.resource = MockUri.file(alternate);
      } else {
        mock.workspace.workspaceFolders = [{ uri: MockUri.file(f.root) }];
      }
      return "Open Session";
    };
    try {
      await assert.rejects(f.manager.open(), /workspace changed/);
      assert.equal(f.entries().length, 0);
      assert.equal(f.clients.size, 0);
    } finally {
      cwd?.mockRestore();
    }
  });
});

test.each(["cwd", "folder", "trust"])("panel creation rechecks %s after the final filesystem check", async (change) => {
  await fixture(async (f) => {
    const { alias, alternate } = await aliasedWorkspace(f);
    const cwd = change === "folder" ? vi.spyOn(f.runtime, "currentCwd", "get").mockReturnValue(alias) : undefined;
    const fs: any = require("node:fs/promises");
    const actual = fs.realpath;
    let reads = 0;
    const resolveRoot = vi.spyOn(fs, "realpath").mockImplementation(async (value: unknown) => {
      const root = await actual(value);
      if (value === alias && ++reads === 4) {
        if (change === "cwd") f.runtime.resource = MockUri.file(alternate);
        else if (change === "folder") mock.workspace.workspaceFolders = [{ uri: MockUri.file(f.root) }];
        else mock.workspace.isTrusted = false;
      }
      return root;
    });
    try {
      await assert.rejects(f.manager.open(), change === "trust" ? /trusted/ : /workspace changed/);
      assert.equal(reads, 4);
      assert.equal(f.entries().length, 0);
      assert.equal(f.clients.size, 0);
    } finally {
      resolveRoot.mockRestore();
      cwd?.mockRestore();
      mock.workspace.isTrusted = true;
    }
  });
});

test("a stopped panel reconnects to workspace A while a source editor in workspace B is active", async () => {
  await fixture(async (f) => {
    const { folder, otherFolder } = await aliasedWorkspace(f);
    const session = await f.open();
    const previous = f.clients.get(session.runtime);
    await session.runtime.stopClient();
    assert.equal(previous.isRunning, false);
    mock.window.activeTextEditor = { document: { uri: MockUri.joinPath(otherFolder.uri, "source.ts") } };
    const before = f.starts.length;
    await session.provider.reconnect();
    assert.equal(f.starts[before].runtime, session.runtime);
    assert.equal(f.starts[before].resource, folder.uri);
    assert.equal(session.runtime.resource, folder.uri);
    assert.equal(session.runtime.currentCwd, folder.uri.fsPath);
    assert.notEqual(f.clients.get(session.runtime), previous);
  });
});

test("sidebar reconnect keeps its active editor and no-editor fallbacks", async () => {
  await fixture(async (f) => {
    const { otherFolder } = await aliasedWorkspace(f);
    const source = MockUri.joinPath(otherFolder.uri, "source.ts");
    mock.window.activeTextEditor = { document: { uri: source } };
    await f.primary.reconnect();
    assert.equal(f.starts[0].resource, source);
    assert.equal(f.runtime.currentCwd, otherFolder.uri.fsPath);
    await f.runtime.stopClient();
    mock.window.activeTextEditor = undefined;
    const before = f.starts.length;
    await f.primary.reconnect();
    assert.equal(f.starts[before].resource, undefined);
    assert.equal(f.runtime.resource, source, "no editor must preserve the runtime's existing fallback");
  });
});

test("editor sessions run concurrently with isolated transcripts, Stop, visibility, and close", async () => {
  await fixture(async (f) => {
    const first = await f.open();
    const second = await f.open();
    assert.equal(first.provider.draftStore, f.primary.draftStore);
    assert.equal(second.provider.backgroundAgents, f.primary.backgroundAgents);
    assert.deepEqual(first.provider.messages, [], "a panel must not restore the sidebar transcript cache");
    const a = first.provider.runRequest("request A", [], []);
    const b = second.provider.runRequest("request B", [], []);
    const aResult = a.catch((error: Error) => error);
    await vi.waitFor(() => {
      assert.equal(f.clients.get(first.runtime).active, true);
      assert.equal(f.clients.get(second.runtime).active, true);
    });
    assert.equal(hasOperation(f.root), true);
    assert.throws(() => acquireOperation(f.root, "Apply"), /foreground Pi request/);
    first.panel.reveal();
    second.panel.reveal();
    assert.equal(f.clients.get(first.runtime).stops, 0, "changing tabs must not stop a request");
    first.panel.receive({ type: "cancel" });
    await vi.waitFor(() => assert.equal(f.clients.get(first.runtime).aborts, 1));
    await aResult;
    assert.equal(f.clients.get(second.runtime).aborts, 0);
    assert.equal(f.clients.get(second.runtime).active, true);
    first.panel.dispose();
    await vi.waitFor(() => assert.equal(f.entries().length, 1));
    assert.equal(f.clients.get(first.runtime).stops, 1);
    assert.equal(f.clients.get(second.runtime).stops, 0);
    f.clients.get(second.runtime).complete("answer B");
    assert.equal(await b, "answer B");
    assert.equal(hasOperation(f.root), false);
    assert.ok(second.provider.messages.some((message: any) => message.content === "answer B"));
    assert.ok(!second.provider.messages.some((message: any) => message.content.includes("request A")));
    assert.deepEqual(f.state.get("pi.sidebar.messages.v1"), [
      { id: "cached", role: "user", content: "sidebar cached text" },
    ]);
    assert.equal(f.state.has("pi.rpc.sessionPath.v1"), false);
    assert.equal(f.environment.clear.mock.calls.length, 0);
  });
});

test("revealing a hidden session republishes its completed host state without another request", async () => {
  await fixture(async (f) => {
    const first = await f.open();
    const second = await f.open();
    const a = first.provider.runRequest("hidden A", [], []);
    const b = second.provider.runRequest("visible B", [], []);
    await vi.waitFor(() => assert.equal(f.clients.get(second.runtime).active, true));
    first.panel.hide();
    const delivered: any[] = [];
    vi.spyOn(first.panel.webview, "postMessage").mockImplementation(async (message) => {
      if (!first.panel.visible) return false;
      delivered.push(message);
      return true;
    });
    f.clients.get(first.runtime).complete("completed while hidden");
    assert.equal(await a, "completed while hidden");
    assert.equal(delivered.length, 0);
    first.panel.reveal();
    const state = delivered.find((message) => message.type === "state");
    assert.ok(state);
    assert.equal(state.runtime.busy, false);
    assert.ok(state.messages.some((message: any) => message.html?.includes("completed while hidden")));
    assert.equal(f.clients.get(first.runtime).prompts.length, 1);
    assert.equal(f.clients.get(second.runtime).active, true);
    f.clients.get(second.runtime).complete("visible B finished");
    await b;
  });
});

test("closing an accepted active session settles its request and keeps its sibling running", async () => {
  await fixture(async (f) => {
    const first = await f.open();
    const second = await f.open();
    const a = first.provider.runRequest("close A", [], []).catch((error: Error) => error);
    const b = second.provider.runRequest("keep B", [], []);
    await vi.waitFor(() => assert.equal(f.clients.get(second.runtime).active, true));
    first.panel.dispose();
    assert.ok((await a) instanceof Error);
    await vi.waitFor(() => assert.equal(f.entries().length, 1));
    assert.equal(f.clients.get(second.runtime).active, true);
    assert.throws(() => acquireOperation(f.root, "restore"));
    f.clients.get(second.runtime).complete("still B");
    assert.equal(await b, "still B");
    assert.equal(hasOperation(f.root), false);
  });
});

test("panel creation rechecks trust and consent without starting a process", async () => {
  await fixture(async (f) => {
    mock.window.showWarningMessage = async () => undefined;
    await f.manager.open();
    assert.equal(f.clients.size, 0);
    assert.equal(f.entries().length, 0);
    mock.window.showWarningMessage = async () => {
      mock.workspace.isTrusted = false;
      return "Open Session";
    };
    await assert.rejects(f.manager.open(), /trusted/);
    assert.equal(f.clients.size, 0);
    mock.workspace.isTrusted = true;
  });
});

test("shutdown during the final workspace check cannot open an unmanaged editor session", async () => {
  await fixture(async (f) => {
    const fs: any = require("node:fs/promises");
    const actual = fs.realpath;
    let reads = 0;
    let reached!: () => void;
    let resume!: (root: string) => void;
    const boundary = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const pendingRoot = new Promise<string>((resolve) => {
      resume = resolve;
    });
    const resolveRoot = vi.spyOn(fs, "realpath").mockImplementation(async (value: unknown) => {
      if (value === f.root && ++reads === 4) {
        reached();
        return pendingRoot;
      }
      return actual(value);
    });
    try {
      const opening = f.manager.open();
      await boundary;
      await f.manager.shutdown();
      resume(f.root);
      await assert.rejects(opening, /closing/);
      assert.equal(f.entries().length, 0);
      assert.equal(f.clients.size, 0);
    } finally {
      resolveRoot.mockRestore();
    }
  });
});

test("editor session capacity includes closed sessions with unverified cleanup", async () => {
  await fixture(async (f) => {
    const sessions = [];
    for (let index = 0; index < 8; index++) sessions.push(await f.open());
    await assert.rejects(f.manager.open(), /session slot/);
    const first = sessions[0];
    first.runtime.handleEvent({ type: "runtime_warning", warningCode: "cleanup-unverified" });
    first.panel.dispose();
    await first.closing;
    assert.equal(f.entries().length, 8);
    await assert.rejects(f.manager.open(), /session slot/);
    const second = sessions[1];
    second.panel.dispose();
    await second.closing;
    assert.equal(f.entries().length, 7);
    await f.open();
    assert.equal(f.entries().length, 8);
  });
});

test.each(["clean", "warning", "error"])(
  "panel capacity waits for an already detached stop with %s cleanup",
  async (outcome) => {
    await fixture(async (f) => {
      for (let index = 0; index < 8; index++) await f.open();
      const session = f.entries()[0];
      const client = f.clients.get(session.runtime);
      const stop = client.stop;
      let reached!: () => void;
      let resume!: () => void;
      const entered = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const pending = new Promise<void>((resolve) => {
        resume = resolve;
      });
      client.stop = async () => {
        reached();
        await pending;
        if (outcome === "warning") client.emit({ type: "runtime_warning", warningCode: "cleanup-unverified" });
        if (outcome === "error") throw new Error("fixture stop failed");
        await stop();
      };
      const stopping = session.runtime.stopClient().catch((error: Error) => error);
      try {
        assert.equal(session.runtime.client, undefined);
        await entered;
        session.panel.dispose();
        let closed = false;
        void session.closing.then(() => {
          closed = true;
        });
        await assert.rejects(f.manager.open(), /session slot/);
        assert.equal(closed, false, "panel close must wait for the earlier detached stop");
        assert.equal(f.entries().length, 8);
      } finally {
        resume();
      }
      const result = await stopping;
      await session.closing;
      if (outcome === "clean") {
        assert.equal(result, undefined);
        assert.equal(f.entries().length, 7);
        await f.open();
        assert.equal(f.entries().length, 8);
      } else {
        assert.equal(result instanceof Error, outcome === "error");
        assert.equal(session.cleanupUnverified, true);
        assert.equal(f.entries().length, 8);
        await assert.rejects(f.manager.open(), /session slot/);
      }
    });
  },
);

test("panel messages and More cannot route sidebar-only workflows to another runtime", async () => {
  await fixture(async (f) => {
    const session = await f.open();
    const execute = vi.spyOn(mock.commands, "executeCommand");
    await session.provider.handleMessage({ type: "exportSession" });
    await session.provider.handleMessage({ type: "openTerminal" });
    assert.equal(execute.mock.calls.length, 0);
    mock.window.showQuickPick = async (items: any[]) => {
      assert.ok(
        !items.some((item) =>
          ["terminal", "returnTerminal", "restart", "export", "import", "share", "review"].includes(item.action),
        ),
      );
      return undefined;
    };
    await session.provider.showMoreActions("", 0);
    execute.mockRestore();
  });
});
