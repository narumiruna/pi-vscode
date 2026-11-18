import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MockInstance } from "vitest";
import type * as vscode from "vscode";
import type { EditorAnnotations } from "../editorAnnotations";
import type { ExtensionDialogRequest } from "../extensionDialogRequests";
import { acquireAgentOperation, acquireOperation } from "../operationLocks";
import type { PiRpcClientOptions, PiRpcEvent, PiRpcClient as RpcClient } from "../piRpcClient";
import type { PiRuntimeOptions } from "../piRuntime";
import type { PiRuntimeControl } from "../piRuntimeControl";
import { SessionInUseError, SessionWriters } from "../sessionWriters";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
const operationLocks = require("../operationLocks") as typeof import("../operationLocks");
afterAll(() => mock.restore());

const restoreKey = "pi.rpc.sessionPath.v1";
const cleanupWarning: PiRpcEvent = {
  type: "runtime_warning",
  warningCode: "cleanup-unverified",
  message: "Fixture cleanup could not verify that the writer stopped.",
};

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((finish, fail) => {
    resolve = finish;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function clientInternals(client: RpcClient | undefined) {
  assert.ok(client);
  return client as unknown as {
    options: PiRpcClientOptions;
    emit: (event: PiRpcEvent) => void;
    listeners: Set<(event: PiRpcEvent) => void>;
  };
}

interface Transport {
  running: boolean;
  state: Record<string, unknown>;
}

interface RuntimeInternals {
  client: RpcClient | undefined;
  control: PiRuntimeControl;
  bridge: { dispose: () => void; start: () => Promise<NodeJS.ProcessEnv> };
  annotations: EditorAnnotations;
  annotationLaunch: { credential: string } | undefined;
  annotationScope: string;
  annotationRequest: (method: string, params: Record<string, unknown>, cancelled: () => boolean) => Promise<unknown>;
  bridgeEnvironment: () => Promise<NodeJS.ProcessEnv>;
  createAndStartClient: (file: string) => Promise<void>;
  createSettledWaiter: (timeoutMs?: number) => { promise: Promise<string | undefined>; dispose: () => void };
  emitWarning: (event: PiRpcEvent, generation?: number) => void;
  refreshState: (catalogs: boolean) => Promise<void>;
  stopClient: () => Promise<void>;
  stopDetachedClient: (client: RpcClient) => Promise<void>;
  rememberSession: (file: string | undefined) => Promise<void>;
}

interface RuntimeHandle {
  runtime: InstanceType<typeof PiRuntimeManager>;
  internal: RuntimeInternals;
  reads: string[];
  writes: { key: string; value: unknown }[];
  saved: Map<string, unknown>;
  environment: Map<string, string>;
  environmentChanges: string[];
  collection: { description: string; clear: () => void; replace: (key: string, value: string) => void };
  events: PiRpcEvent[];
}

interface RuntimeFixture {
  root: string;
  writers: SessionWriters;
  transport: (client: RpcClient | undefined) => Transport;
  start: MockInstance<RpcClient["start"]>;
  stop: MockInstance<RpcClient["stop"]>;
  switchSession: MockInstance<RpcClient["switchSession"]>;
  session: (name: string) => Promise<string>;
  create: (options?: PiRuntimeOptions, storedSession?: string) => RuntimeHandle;
  launch: (file: string, options?: PiRuntimeOptions) => Promise<RuntimeHandle>;
}

async function fixture(action: (f: RuntimeFixture) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-concurrent-runtime-")));
  const folder = { uri: MockUri.file(root) };
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  mock.workspace.fs = { delete: async () => {} };
  mock.window.activeTextEditor = undefined;
  const writers = new SessionWriters();
  const runtimes: InstanceType<typeof PiRuntimeManager>[] = [];
  const clients: RpcClient[] = [];
  const transports = new WeakMap<RpcClient, Transport>();
  const transport = (client: RpcClient | undefined): Transport => {
    assert.ok(client);
    const current = transports.get(client);
    assert.ok(current, "The fixture client must have started");
    return current;
  };
  const start = vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(async function (this: RpcClient) {
    clients.push(this);
    const sessionFile =
      clientInternals(this).options.sessionPath ?? path.join(root, `assigned-${clients.length}.jsonl`);
    transports.set(this, {
      running: true,
      state: { sessionFile, sessionId: path.basename(sessionFile, ".jsonl") },
    });
  });
  vi.spyOn(PiRpcClient.prototype, "isRunning", "get").mockImplementation(function (this: RpcClient) {
    return transports.get(this)?.running ?? false;
  });
  const stop = vi.spyOn(PiRpcClient.prototype, "stop").mockImplementation(async function (this: RpcClient) {
    const transport = transports.get(this);
    if (!transport?.running) return;
    transport.running = false;
    clientInternals(this).emit({ type: "process_exit", expected: true, code: 0, signal: null });
  });
  vi.spyOn(PiRpcClient.prototype, "getState").mockImplementation(async function (this: RpcClient) {
    return { ...transport(this).state };
  });
  vi.spyOn(PiRpcClient.prototype, "getSessionStats").mockResolvedValue({});
  vi.spyOn(PiRpcClient.prototype, "getAvailableModels").mockResolvedValue([]);
  vi.spyOn(PiRpcClient.prototype, "getAvailableThinkingLevels").mockResolvedValue([]);
  vi.spyOn(PiRpcClient.prototype, "getCommands").mockResolvedValue([]);
  vi.spyOn(PiRpcClient.prototype, "prompt").mockResolvedValue(undefined);
  const switchSession = vi.spyOn(PiRpcClient.prototype, "switchSession").mockImplementation(async function (
    this: RpcClient,
    destination: string,
  ) {
    transport(this).state = {
      sessionFile: destination,
      sessionId: path.basename(destination, ".jsonl"),
    };
    return {};
  });
  const session = async (name: string) => {
    const file = path.join(root, `${name}.jsonl`);
    await writeFile(file, `${JSON.stringify({ type: "session", id: name, cwd: root })}\n`);
    return file;
  };
  const create = (options: PiRuntimeOptions = { editorSession: true }, storedSession?: string): RuntimeHandle => {
    const reads: string[] = [];
    const writes: { key: string; value: unknown }[] = [];
    const saved = new Map<string, unknown>([[restoreKey, storedSession]]);
    const environment = new Map([["PRIMARY_BRIDGE", "unchanged"]]);
    const environmentChanges: string[] = [];
    const collection = {
      description: "Primary bridge environment",
      clear: () => {
        environmentChanges.push("clear");
        environment.clear();
      },
      replace: (key: string, value: string) => {
        environmentChanges.push(key);
        environment.set(key, value);
      },
    };
    const runtime = new PiRuntimeManager(
      {
        extensionUri: MockUri.file(process.cwd()),
        workspaceState: {
          get: (key: string) => {
            reads.push(key);
            return saved.get(key);
          },
          update: async (key: string, value: unknown) => {
            writes.push({ key, value });
            saved.set(key, value);
          },
        },
        environmentVariableCollection: collection,
      } as unknown as vscode.ExtensionContext,
      undefined,
      { ...options, sessionWriters: writers },
    );
    runtimes.push(runtime);
    const internal = runtime as unknown as RuntimeInternals;
    internal.bridgeEnvironment = async () => ({});
    const events: PiRpcEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    return { runtime, internal, reads, writes, saved, environment, environmentChanges, collection, events };
  };
  const launch = async (file: string, options?: PiRuntimeOptions) => {
    const handle = create(options);
    await handle.internal.createAndStartClient(file);
    return handle;
  };
  try {
    await action({ root, writers, transport, start, stop, switchSession, session, create, launch });
  } finally {
    await Promise.allSettled(runtimes.map((runtime) => runtime.shutdown()));
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  }
}

async function boundWorkspace(
  f: RuntimeFixture,
  alias = false,
  role: "editorSession" | "sidebarSession" = "editorSession",
) {
  const target = path.join(f.root, "workspace-a");
  const other = path.join(f.root, "workspace-b");
  await Promise.all([mkdir(target), mkdir(other)]);
  const opened = alias ? path.join(f.root, "opened-a") : target;
  const linkType = process.platform === "win32" ? "junction" : "dir";
  if (alias) await symlink(target, opened, linkType);
  const folder = { uri: MockUri.file(opened) };
  const otherFolder = { uri: MockUri.file(other) };
  mock.workspace.workspaceFolders = [otherFolder, folder];
  mock.workspace.getWorkspaceFolder = (resource: MockUri) =>
    [...mock.workspace.workspaceFolders]
      .sort((a, b) => b.uri.fsPath.length - a.uri.fsPath.length)
      .find(({ uri }) => {
        const relative = path.relative(uri.fsPath, resource.fsPath);
        return (
          uri.scheme === resource.scheme &&
          (relative === "" ||
            (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)))
        );
      });
  mock.workspace.getConfiguration = (_section: string, resource?: MockUri) => ({
    get: (key: string, fallback: unknown) =>
      key === "model"
        ? mock.workspace.getWorkspaceFolder(resource ?? otherFolder.uri) === folder
          ? "model-a"
          : "model-b"
        : fallback,
  });
  const uri = folder.uri as unknown as vscode.Uri;
  const options = { [role]: true, editorWorkspace: { uri, root: target } };
  const editor = f.create(options);
  const exit = () => {
    const client = editor.internal.client;
    f.transport(client).running = false;
    clientInternals(client).emit({ type: "process_exit", expected: false });
  };
  return { target, other, opened, linkType, folder, otherFolder, uri, editor, exit };
}

for (const fallback of ["first-folder", "parent-folder"] as const) {
  test(`removed editor workspace rejects reconnect and resource-less send instead of ${fallback} fallback`, async () => {
    await fixture(async (f) => {
      const { target, folder, otherFolder, uri, editor, exit } = await boundWorkspace(f);
      if (fallback === "parent-folder") mock.workspace.workspaceFolders.push({ uri: MockUri.file(f.root) });
      await editor.runtime.ensureStarted(uri);
      assert.equal(clientInternals(editor.internal.client).options.cwd, target);
      assert.equal(clientInternals(editor.internal.client).options.model, "model-a");
      assert.equal(editor.runtime.currentState.sessionFile?.includes("assigned-"), true, "The session is unsaved");
      exit();
      mock.workspace.workspaceFolders = mock.workspace.workspaceFolders.filter((entry: unknown) => entry !== folder);
      mock.window.activeTextEditor = { document: { uri: MockUri.joinPath(otherFolder.uri, "source.ts") } };
      vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
      const results = await Promise.allSettled([
        editor.runtime.ensureStarted(uri),
        editor.runtime.prompt("Do not send in another workspace"),
      ]);
      assert.deepEqual(
        results.map((result) => result.status),
        ["rejected", "rejected"],
      );
      for (const result of results) {
        assert.ok(result.status === "rejected");
        assert.match(String(result.reason), /workspace changed/i);
      }
      assert.equal(f.start.mock.calls.length, 1);
      assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
      assert.equal(editor.internal.client, undefined);
    });
  });
}

for (const state of ["exited", "running"] as const) {
  test(`retargeted editor workspace alias rejects reconnect and resource-less send (${state})`, async () => {
    await fixture(async (f) => {
      const { opened, other, linkType, uri, editor, exit } = await boundWorkspace(f, true);
      await editor.runtime.ensureStarted(uri);
      if (state === "exited") exit();
      await rm(opened);
      await symlink(other, opened, linkType);
      vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
      const results = await Promise.allSettled([
        editor.runtime.ensureStarted(uri),
        editor.runtime.prompt("Do not send through a retargeted alias"),
      ]);
      assert.deepEqual(
        results.map((result) => result.status),
        ["rejected", "rejected"],
      );
      assert.equal(f.start.mock.calls.length, 1);
      assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
    });
  });
}

test("unchanged editor workspace alias keeps its canonical cwd and scoped settings with workspace B active", async () => {
  await fixture(async (f) => {
    const { target, otherFolder, uri, editor, exit } = await boundWorkspace(f, true);
    await editor.runtime.ensureStarted(uri);
    exit();
    mock.window.activeTextEditor = { document: { uri: MockUri.joinPath(otherFolder.uri, "source.ts") } };
    await editor.runtime.ensureStarted(uri);
    assert.equal(f.start.mock.calls.length, 2);
    assert.equal(clientInternals(editor.internal.client).options.cwd, target);
    assert.equal(clientInternals(editor.internal.client).options.model, "model-a");
    assert.equal(editor.runtime.currentCwd, uri.fsPath);
    vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
    assert.deepEqual(await editor.runtime.prompt("Still workspace A"), { disposition: "handled" });
    assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 1);
  });
});

test("editor startup cannot replace its opened resource with another explicit resource or active editor", async () => {
  await fixture(async (f) => {
    const { target, otherFolder, uri, editor } = await boundWorkspace(f, true);
    mock.window.activeTextEditor = { document: { uri: MockUri.joinPath(otherFolder.uri, "source.ts") } };
    await editor.runtime.ensureStarted(otherFolder.uri as unknown as vscode.Uri);
    assert.equal(clientInternals(editor.internal.client).options.cwd, target);
    assert.equal(clientInternals(editor.internal.client).options.model, "model-a");
    await editor.internal.stopClient();
    await editor.runtime.ensureStarted();
    assert.equal(clientInternals(editor.internal.client).options.cwd, target);
    assert.equal(clientInternals(editor.internal.client).options.model, "model-a");
    assert.equal(editor.runtime.currentCwd, uri.fsPath);
  });
});

for (const change of ["folder", "alias"] as const) {
  test(`editor startup rechecks ${change} binding after an awaited writer reservation`, async () => {
    await fixture(async (f) => {
      const { target, opened, other, otherFolder, linkType, uri, editor } = await boundWorkspace(f, true);
      const file = path.join(f.root, "saved-a.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "session", id: "saved-a", cwd: target })}\n`);
      await editor.internal.rememberSession(file);
      const reached = deferred();
      const resume = deferred();
      const reserve = f.writers.reserve.bind(f.writers);
      vi.spyOn(f.writers, "reserve").mockImplementationOnce(async (owner, sessionFile, isCurrent) => {
        const key = await reserve(owner, sessionFile, isCurrent);
        reached.resolve();
        await resume.promise;
        return key;
      });
      const startup = editor.runtime.ensureStarted(uri);
      const result = Promise.allSettled([startup]);
      await reached.promise;
      try {
        if (change === "folder") mock.workspace.workspaceFolders = [otherFolder];
        else {
          await rm(opened);
          await symlink(other, opened, linkType);
        }
      } finally {
        resume.resolve();
      }
      assert.equal((await result)[0]?.status, "rejected");
      assert.equal(f.start.mock.calls.length, 0);
      assert.equal(editor.internal.client, undefined);
      assert.equal(await reserve({}, file), file, "Rejected startup must release its writer reservation");
    });
  });
}

test("a changed editor binding rejects a second ensureStarted before joining pending startup", async () => {
  await fixture(async (f) => {
    const { uri, editor, otherFolder } = await boundWorkspace(f);
    const reached = deferred();
    const resume = deferred();
    editor.internal.bridgeEnvironment = async () => {
      reached.resolve();
      await resume.promise;
      return {};
    };
    const startup = editor.runtime.ensureStarted(uri);
    const result = Promise.allSettled([startup]);
    await reached.promise;
    mock.workspace.workspaceFolders = [otherFolder];
    let outcome = "pending";
    const joining = editor.runtime.ensureStarted(uri).then(
      () => {
        outcome = "resolved";
      },
      () => {
        outcome = "rejected";
      },
    );
    try {
      await vi.waitFor(() => assert.equal(outcome, "rejected"));
    } finally {
      resume.resolve();
      await joining;
      await result;
    }
    assert.equal((await result)[0]?.status, "rejected");
    assert.equal(f.start.mock.calls.length, 0);
  });
});

test("a running editor rechecks exact folder membership after awaiting its canonical root", async () => {
  await fixture(async (f) => {
    const { opened, uri, editor, otherFolder } = await boundWorkspace(f);
    await editor.runtime.ensureStarted(uri);
    const fs: typeof import("node:fs/promises") = require("node:fs/promises");
    const actual = fs.realpath;
    vi.spyOn(fs, "realpath").mockImplementation(async (value, options) => {
      const root = await actual(value, options);
      if (value === opened) mock.workspace.workspaceFolders = [otherFolder];
      return root;
    });
    await assert.rejects(editor.runtime.ensureStarted(), /workspace changed/i);
    assert.equal(f.start.mock.calls.length, 1);
  });
});

test("resource-less editor prompt rechecks its binding after the pre-submit callback", async () => {
  await fixture(async (f) => {
    const { uri, editor, otherFolder } = await boundWorkspace(f);
    await editor.runtime.ensureStarted(uri);
    vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
    await assert.rejects(
      editor.runtime.prompt("Do not dispatch", undefined, undefined, undefined, () => {
        mock.workspace.workspaceFolders = [otherFolder];
      }),
      /workspace changed/i,
    );
    assert.equal(f.start.mock.calls.length, 1);
    assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
  });
});

for (const transition of ["shutdown", "replacement"] as const) {
  test(`editor prompt cannot dispatch to a retired client after awaited binding validation (${transition})`, async () => {
    await fixture(async (f) => {
      const { opened, uri, editor, exit } = await boundWorkspace(f);
      await editor.runtime.ensureStarted(uri);
      const original = editor.internal.client;
      const reached = deferred();
      const resume = deferred();
      const fs: typeof import("node:fs/promises") = require("node:fs/promises");
      const actual = fs.realpath;
      let checks = 0;
      vi.spyOn(fs, "realpath").mockImplementation(async (value, options) => {
        const root = await actual(value, options);
        if (value === opened && ++checks === 2) {
          reached.resolve();
          await resume.promise;
        }
        return root;
      });
      vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
      const request = editor.runtime.prompt("Do not dispatch to a retired client");
      const result = Promise.allSettled([request]);
      await reached.promise;
      try {
        if (transition === "shutdown") await editor.runtime.shutdown();
        else {
          exit();
          await editor.runtime.ensureStarted(uri);
          assert.notEqual(editor.internal.client, original);
        }
      } finally {
        resume.resolve();
      }
      const outcome = (await result)[0];
      assert.ok(outcome?.status === "rejected");
      assert.match(String(outcome.reason), /disposed|replaced/);
      assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
    });
  });
}

test("sidebar startup keeps its active-resource and first-folder fallback without an editor binding", async () => {
  await fixture(async (f) => {
    const { target, other, uri } = await boundWorkspace(f);
    const primary = f.create({ editorSession: false });
    await primary.runtime.ensureStarted(uri);
    assert.equal(clientInternals(primary.internal.client).options.cwd, target);
    await primary.internal.stopClient();
    mock.workspace.workspaceFolders = [{ uri: MockUri.file(other) }];
    await primary.runtime.ensureStarted();
    assert.equal(clientInternals(primary.internal.client).options.cwd, other);
    assert.equal(clientInternals(primary.internal.client).options.model, "model-b");
  });
});

test("independent editor runtimes retain separate writers and reject an already-open saved session before start", async () => {
  await fixture(async (f) => {
    const firstFile = await f.session("first");
    const secondFile = await f.session("second");
    const [first, second] = await Promise.all([f.launch(firstFile), f.launch(secondFile)]);
    assert.notEqual(first.runtime.clientGeneration, second.runtime.clientGeneration);
    const duplicate = f.create();
    const starts = f.start.mock.calls.length;
    await assert.rejects(duplicate.internal.createAndStartClient(firstFile), SessionInUseError);
    assert.equal(f.start.mock.calls.length, starts);
    assert.equal(duplicate.internal.client, undefined);
    assert.equal(first.runtime.currentState.sessionFile, firstFile);
    assert.equal(second.runtime.currentState.sessionFile, secondFile);
    await first.runtime.shutdown();
    assert.equal(await f.writers.reserve({}, firstFile), firstFile);
    await assert.rejects(f.writers.reserve({}, secondFile), SessionInUseError);
    assert.equal(second.runtime.currentState.connected, true);
  });
});

test("simultaneous runtime startups admit only one writer for the same saved session", async () => {
  await fixture(async (f) => {
    const file = await f.session("shared");
    const first = f.create();
    const second = f.create();
    const results = await Promise.allSettled([
      first.internal.createAndStartClient(file),
      second.internal.createAndStartClient(file),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof SessionInUseError);
    assert.equal(f.start.mock.calls.length, 1);
    const winner = results[0]?.status === "fulfilled" ? first : second;
    const loser = winner === first ? second : first;
    assert.equal(winner.runtime.currentState.connected, true);
    assert.equal(loser.internal.client, undefined);
    await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    await winner.runtime.shutdown();
    assert.equal(await f.writers.reserve({}, file), file);
  });
});

test("startup rejects hardlinked sessions before starting either pathname", async () => {
  await fixture(async (f) => {
    const file = await f.session("linked");
    const alias = path.join(f.root, "hardlink.jsonl");
    await link(file, alias);
    for (const sessionFile of [file, alias]) {
      const editor = f.create();
      await assert.rejects(editor.internal.createAndStartClient(sessionFile), /single-link/);
      assert.equal(editor.internal.client, undefined);
    }
    assert.equal(f.start.mock.calls.length, 0);
  });
});

test("startup rejects a canonical parent symlink alias owned by another runtime", async () => {
  if (process.platform === "win32") return;
  await fixture(async (f) => {
    const file = await f.session("original");
    const alias = path.join(f.root, "root-alias");
    await symlink(f.root, alias, "dir");
    const original = await f.launch(file);
    const duplicate = f.create();
    const starts = f.start.mock.calls.length;
    await assert.rejects(
      duplicate.internal.createAndStartClient(path.join(alias, "original.jsonl")),
      SessionInUseError,
    );
    assert.equal(f.start.mock.calls.length, starts);
    assert.equal(original.runtime.currentState.connected, true);
    await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
  });
});

for (const role of ["editorSession", "sidebarSession"] as const) {
  test(`${role} startup and shutdown do not read or write primary restore or terminal environment`, async () => {
    await fixture(async (f) => {
      const primary = await f.session("primary");
      const editor = f.create({ [role]: true }, primary);
      await editor.runtime.initializeControlOwnership();
      await editor.runtime.initializeBridge();
      await editor.runtime.ensureStarted();
      const client = editor.internal.client as RpcClient;
      assert.equal(clientInternals(client).options.sessionPath, undefined);
      assert.equal(clientInternals(client).options.env?.PI_VSCODE_ANNOTATION_TOKEN, undefined);
      assert.notEqual(editor.runtime.currentState.sessionFile, primary);
      await editor.runtime.shutdown();
      assert.equal(editor.reads.includes(restoreKey), false);
      assert.equal(
        editor.writes.some((write) => write.key === restoreKey),
        false,
      );
      assert.equal(editor.saved.get(restoreKey), primary);
      assert.deepEqual(editor.environmentChanges, []);
      assert.deepEqual([...editor.environment], [["PRIMARY_BRIDGE", "unchanged"]]);
      assert.equal(editor.collection.description, "Primary bridge environment");
    });
  });

  test(`${role} startup cannot bypass the primary session's persisted terminal ownership`, async () => {
    await fixture(async (f) => {
      const primary = await f.session("primary");
      const editor = f.create({ [role]: true }, primary);
      const marker = { version: 1, root: f.root, sessionFile: primary, sessionId: "primary" };
      editor.saved.set("pi.control.externalOwnership.v1", marker);
      await editor.runtime.initializeControlOwnership();
      assert.equal(editor.reads.length, 0, "Additional runtimes must not create a second terminal recovery owner");
      await assert.rejects(editor.runtime.ensureStarted(), /terminal|uncertain/);
      assert.equal(f.start.mock.calls.length, 0);
      assert.equal(editor.internal.client, undefined);
      assert.equal(editor.runtime.currentState.connected, false);
      assert.equal(editor.reads.includes(restoreKey), false);
      assert.deepEqual(editor.writes, []);
      await editor.runtime.shutdown();
      assert.equal(editor.saved.get("pi.control.externalOwnership.v1"), marker);
      assert.equal(editor.saved.get(restoreKey), primary);
    });
  });

  test(`${role} observes ownership recovery without caching the primary marker or taking its gate`, async () => {
    await fixture(async (f) => {
      const editor = f.create({ [role]: true });
      editor.saved.set("pi.control.externalOwnership.v1", { version: 1, root: f.root });
      await assert.rejects(editor.runtime.ensureStarted(), /terminal/);
      const releaseBefore = acquireOperation(f.root, "check marker observer");
      releaseBefore();
      editor.saved.delete("pi.control.externalOwnership.v1");
      await editor.runtime.ensureStarted();
      assert.equal(editor.runtime.currentState.connected, true);
      const releaseAfter = acquireOperation(f.root, "check recovered runtime");
      releaseAfter();
      assert.deepEqual(editor.writes, []);
    });
  });

  for (const state of ["saved", "unsaved", "no-path"] as const) {
    test(`${role} restore uses only verified saved runtime memory (${state})`, async () => {
      await fixture(async (f) => {
        const primary = await f.session("primary");
        const editor = f.create({ [role]: true }, primary);
        await editor.runtime.ensureStarted();
        const client = editor.internal.client as RpcClient;
        const file = state === "saved" ? await f.session("editor") : path.join(f.root, "unsaved.jsonl");
        f.transport(client).state = { sessionFile: state === "no-path" ? undefined : file, sessionId: "editor" };
        await editor.internal.refreshState(false);
        assert.equal(editor.runtime.currentState.sessionFile, state === "no-path" ? undefined : file);
        await editor.internal.stopClient();
        await editor.runtime.ensureStarted();
        assert.equal(clientInternals(editor.internal.client).options.sessionPath, state === "saved" ? file : undefined);
        const independent = f.create({ [role]: true }, primary);
        await independent.runtime.ensureStarted();
        assert.equal(clientInternals(independent.internal.client).options.sessionPath, undefined);
        assert.equal(editor.reads.includes(restoreKey), false);
        assert.equal(
          editor.writes.some((write) => write.key === restoreKey),
          false,
        );
        assert.equal(editor.saved.get(restoreKey), primary);
      });
    });
  }
}

test("primary runtime still restores and updates its own workspace key", async () => {
  await fixture(async (f) => {
    const saved = await f.session("primary");
    const primary = f.create({ editorSession: false }, saved);
    await primary.runtime.ensureStarted();
    assert.equal(clientInternals(primary.internal.client).options.sessionPath, saved);
    assert.equal(primary.reads.includes(restoreKey), true);
    assert.ok(primary.writes.some((write) => write.key === restoreKey && write.value === saved));
    await primary.runtime.shutdown();
    assert.deepEqual(primary.environmentChanges, ["clear"]);
  });
});

for (const role of ["editorSession", "sidebarSession"] as const) {
  for (const operation of ["restartSessionProcess", "returnFromTerminal", "openInTerminal"] as const) {
    test(`${role} rejects ${operation} before delegating to primary controls`, async () => {
      await fixture(async (f) => {
        const editor = await f.launch(await f.session("editor"), { [role]: true });
        const delegate = vi.spyOn(editor.internal.control, operation).mockResolvedValue(true);
        const before = editor.runtime.currentState;
        await assert.rejects(editor.runtime[operation](), /editor session|sidebar/i);
        assert.equal(delegate.mock.calls.length, 0);
        assert.deepEqual(editor.runtime.currentState, before);
        assert.deepEqual(editor.writes, []);
      });
    });
  }

  for (const method of ["annotationOrigin", "annotate"] as const) {
    test(`${role} rejects ${method} even with current launch credentials`, async () => {
      await fixture(async (f) => {
        const editor = await f.launch(await f.session("editor"), { [role]: true });
        const annotate = vi.spyOn(editor.internal.annotations, "annotate");
        await assert.rejects(
          editor.internal.annotationRequest(
            method,
            {
              credential: editor.internal.annotationLaunch?.credential ?? "0".repeat(64),
              origin: editor.internal.annotationScope,
              sessionId: editor.runtime.currentState.sessionId,
              cwd: f.root,
              path: path.join(f.root, "source.ts"),
              annotations: [],
            },
            () => false,
          ),
          /only.*sidebar/i,
        );
        assert.equal(annotate.mock.calls.length, 0);
      });
    });
  }
}

test("switch to a sibling-owned session rejects before RPC or UI reset and preserves the source", async () => {
  await fixture(async (f) => {
    const source = await f.session("source");
    const destination = await f.session("destination");
    const original = await f.launch(source);
    const sibling = await f.launch(destination);
    const before = original.runtime.currentState;
    original.events.splice(0);
    await assert.rejects(original.runtime.switchSession(destination, "destination"), SessionInUseError);
    assert.equal(f.switchSession.mock.calls.length, 0);
    assert.equal(f.stop.mock.calls.length, 0);
    assert.deepEqual(original.runtime.currentState, before);
    assert.deepEqual(original.events, []);
    assert.deepEqual(original.writes, []);
    for (const file of [source, destination]) await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    await sibling.runtime.shutdown();
    await original.runtime.switchSession(destination, "destination");
    assert.equal(f.switchSession.mock.calls.length, 1);
    assert.equal(original.runtime.currentState.sessionFile, destination);
    assert.equal(await f.writers.reserve({}, source), source);
    await assert.rejects(f.writers.reserve({}, destination), SessionInUseError);
  });
});

test("a rejected post-reservation switch origin stops its client and releases both verified claims", async () => {
  await fixture(async (f) => {
    const source = await f.session("source");
    const destination = await f.session("destination");
    const editor = await f.launch(source);
    const reserve = f.writers.reserve.bind(f.writers);
    vi.spyOn(f.writers, "reserve").mockImplementation(async (owner, file, isCurrent) => {
      const key = await reserve(owner, file, isCurrent);
      if (file === destination) mock.workspace.isTrusted = false;
      return key;
    });
    try {
      await assert.rejects(editor.runtime.switchSession(destination), /verification failed/);
      assert.equal(f.switchSession.mock.calls.length, 0);
      assert.equal(f.stop.mock.calls.length, 1);
      assert.equal(editor.runtime.currentState.connected, false);
      for (const file of [source, destination]) assert.equal(await reserve({}, file), file);
    } finally {
      mock.workspace.isTrusted = true;
    }
  });
});

for (const permanent of [false, true]) {
  test(`${permanent ? "permanent deletion" : "Trash"} cannot delete a file claimed after the old writer stops`, async () => {
    await fixture(async (f) => {
      const file = await f.session("editor");
      const editor = await f.launch(file);
      const stop = editor.internal.stopClient.bind(editor.internal);
      vi.spyOn(editor.internal, "stopClient").mockImplementation(async () => {
        await stop();
        await f.writers.reserve({}, file);
      });
      const deletion = vi.spyOn(mock.workspace.fs, "delete").mockResolvedValue(undefined);
      const action = permanent ? editor.runtime.deleteSessionPermanently(file) : editor.runtime.deleteSession();
      await assert.rejects(action, SessionInUseError);
      assert.equal(deletion.mock.calls.length, 0);
      await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    });
  });
}

test("runtime switch retains both reservations through RPC and authoritative state verification", async () => {
  await fixture(async (f) => {
    const source = await f.session("source");
    const destination = await f.session("destination");
    const editor = await f.launch(source);
    const verifyHeld = async () => {
      for (const file of [source, destination]) await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    };
    f.switchSession.mockImplementationOnce(async () => {
      await verifyHeld();
      f.transport(editor.internal.client).state = { sessionFile: destination, sessionId: "destination" };
      return {};
    });
    const commands = vi.mocked(PiRpcClient.prototype.getCommands);
    commands.mockImplementationOnce(async () => {
      await verifyHeld();
      return [];
    });
    await editor.runtime.switchSession(destination, "destination");
    assert.equal(await f.writers.reserve({}, source), source);
    await assert.rejects(f.writers.reserve({}, destination), SessionInUseError);
    assert.equal(editor.runtime.currentState.sessionFile, destination);
  });
});

test("verified switch cancellation retains the source writer and releases only the destination", async () => {
  await fixture(async (f) => {
    const source = await f.session("source");
    const destination = await f.session("destination");
    const editor = await f.launch(source);
    f.switchSession.mockResolvedValueOnce({ cancelled: true });
    await assert.rejects(editor.runtime.switchSession(destination), /cancelled/);
    assert.equal(editor.runtime.currentState.sessionFile, source);
    assert.equal(editor.runtime.currentState.connected, true);
    assert.equal(f.stop.mock.calls.length, 0);
    await assert.rejects(f.writers.reserve({}, source), SessionInUseError);
    assert.equal(await f.writers.reserve({}, destination), destination);
  });
});

for (const failure of ["warning-during-stop", "warning-before-stop", "stop-error"] as const) {
  test(`shutdown quarantines the writer after ${failure}`, async () => {
    await fixture(async (f) => {
      const file = await f.session("editor");
      const editor = await f.launch(file);
      const client = editor.internal.client as RpcClient;
      if (failure === "warning-before-stop") clientInternals(client).emit(cleanupWarning);
      const stopClient = vi.spyOn(client, "stop").mockImplementation(async () => {
        if (failure === "warning-during-stop") clientInternals(client).emit(cleanupWarning);
        if (failure === "stop-error") throw new Error("Fixture stop failed.");
        f.transport(client).running = false;
        clientInternals(client).emit({ type: "process_exit", expected: true, code: 0, signal: null });
      });
      const shutdown = editor.runtime.shutdown();
      if (failure === "stop-error") await assert.rejects(shutdown, /Fixture stop failed/);
      else await shutdown;
      assert.equal(stopClient.mock.calls.length, 1);
      assert.equal(clientInternals(client).listeners.size, 0);
      await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      editor.runtime.dispose();
      await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    });
  });
}

for (const failure of ["cleanup-unverified", "stop-error"] as const) {
  test(`failed switch keeps source and destination quarantined after ${failure}`, async () => {
    await fixture(async (f) => {
      const source = await f.session("source");
      const destination = await f.session("destination");
      const editor = await f.launch(source);
      const client = editor.internal.client as RpcClient;
      f.switchSession.mockRejectedValueOnce(new Error("Fixture lost switch response."));
      vi.spyOn(client, "stop").mockImplementation(async () => {
        if (failure === "stop-error") throw new Error("Fixture stop failed.");
        clientInternals(client).emit(cleanupWarning);
        f.transport(client).running = false;
      });
      await assert.rejects(editor.runtime.switchSession(destination), /verification failed|Fixture stop failed/);
      assert.equal(editor.internal.client, undefined);
      for (const file of [source, destination]) await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      await editor.runtime.shutdown();
      vi.mocked(client.stop).mockResolvedValue(undefined);
      const repeatedStop = editor.internal.stopDetachedClient(client);
      if (failure === "stop-error") await assert.rejects(repeatedStop, /Fixture stop failed/);
      else await repeatedStop;
      for (const file of [source, destination]) await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    });
  });
}

test("shutdown settles the accepted request waiter and awaits bounded stop before releasing its writer", async () => {
  await fixture(async (f) => {
    const file = await f.session("editor");
    const editor = await f.launch(file);
    const client = editor.internal.client as RpcClient;
    const accepted = deferred();
    const stopped = deferred();
    const stopping = deferred();
    let promptOutcome: "pending" | "resolved" | "rejected" = "pending";
    let waiterOutcome: "pending" | "resolved" | "rejected" = "pending";
    let shutdownSettled = false;
    const createWaiter = editor.internal.createSettledWaiter.bind(editor.internal);
    vi.spyOn(editor.internal, "createSettledWaiter").mockImplementation(() => {
      const waiter = createWaiter();
      void waiter.promise.then(
        () => {
          waiterOutcome = "resolved";
        },
        () => {
          waiterOutcome = "rejected";
        },
      );
      return waiter;
    });
    const pendingPrompt = editor.runtime
      .prompt("Wait for shutdown", undefined, undefined, () => accepted.resolve())
      .then(
        () => {
          promptOutcome = "resolved";
        },
        () => {
          promptOutcome = "rejected";
        },
      );
    await accepted.promise;
    assert.equal(editor.runtime.currentState.busy, true);
    assert.equal(editor.runtime.shutdownCompletion, undefined);
    vi.useFakeTimers();
    let stopScheduled = false;
    vi.spyOn(client, "stop").mockImplementation(() => {
      if (!stopScheduled) {
        stopScheduled = true;
        setTimeout(() => {
          f.transport(client).running = false;
          clientInternals(client).emit({ type: "process_exit", expected: true, code: 0, signal: null });
          stopped.resolve();
        }, 5_000);
        stopping.resolve();
      }
      return stopped.promise;
    });
    const shutdown = editor.runtime.shutdown();
    void shutdown.then(() => {
      shutdownSettled = true;
    });
    try {
      assert.equal(editor.runtime.shutdownCompletion, shutdown);
      assert.equal(editor.runtime.shutdown(), shutdown);
      editor.runtime.dispose();
      assert.equal(editor.events.at(-1)?.type, "runtime_shutdown", "Shutdown must notify request waiters immediately");
      await stopping.promise;
      await vi.advanceTimersByTimeAsync(0);
      assert.equal(
        waiterOutcome,
        "rejected",
        "The accepted request waiter must settle before process cleanup finishes",
      );
      assert.equal(
        promptOutcome,
        "pending",
        "The public request must retain operation ownership until cleanup finishes",
      );
      assert.equal(shutdownSettled, false);
      await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      await vi.advanceTimersByTimeAsync(4_999);
      assert.equal(shutdownSettled, false, "Shutdown must wait for the client's bounded stop result");
      await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      await vi.advanceTimersByTimeAsync(1);
      await shutdown;
      await pendingPrompt;
      assert.equal(promptOutcome, "rejected");
      assert.equal(shutdownSettled, true);
      assert.equal(await f.writers.reserve({}, file), file);
      assert.equal(clientInternals(client).listeners.size, 0);
    } finally {
      await vi.advanceTimersByTimeAsync(5_000);
      await Promise.allSettled([shutdown, pendingPrompt]);
      vi.useRealTimers();
    }
  });
});

for (const outcome of ["clean", "warning", "error"] as const) {
  test(`shutdown waits for an earlier detached stop before disposal (${outcome})`, async () => {
    await fixture(async (f) => {
      const file = await f.session("editor");
      const editor = await f.launch(file);
      const client = editor.internal.client as RpcClient;
      const stopStarted = deferred();
      const finishStop = deferred();
      const controlDisposed = vi.spyOn(editor.internal.control, "dispose");
      const bridgeDisposed = vi.spyOn(editor.internal.bridge, "dispose");
      const annotationsDisposed = vi.spyOn(editor.internal.annotations, "dispose");
      vi.spyOn(client, "stop").mockImplementation(async () => {
        stopStarted.resolve();
        await finishStop.promise;
        if (outcome === "warning") clientInternals(client).emit(cleanupWarning);
        if (outcome === "error") throw new Error("Earlier stop failed.");
        f.transport(client).running = false;
        clientInternals(client).emit({ type: "process_exit", expected: true });
      });
      const stopping = editor.internal.stopClient();
      const stopResult = Promise.allSettled([stopping]);
      await stopStarted.promise;
      assert.equal(editor.internal.client, undefined);
      const shutdown = editor.runtime.shutdown();
      const shutdownResult = Promise.allSettled([shutdown]);
      let closed = false;
      void shutdownResult.then(() => {
        closed = true;
      });
      try {
        assert.equal(editor.internal.annotationLaunch, undefined, "Annotation authority is revoked synchronously");
        assert.equal(bridgeDisposed.mock.calls.length, 1, "Bridge access is revoked synchronously");
        assert.equal(annotationsDisposed.mock.calls.length, 1);
        await assert.rejects(editor.internal.bridge.start(), /disposed/);
        await Promise.resolve();
        assert.equal(closed, false);
        assert.equal(controlDisposed.mock.calls.length, 0);
        await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      } finally {
        finishStop.resolve();
      }
      const [stopStatus] = await stopResult;
      const [shutdownStatus] = await shutdownResult;
      assert.equal(stopStatus?.status, outcome === "error" ? "rejected" : "fulfilled");
      assert.equal(shutdownStatus?.status, outcome === "error" ? "rejected" : "fulfilled");
      assert.equal(controlDisposed.mock.calls.length, 1);
      assert.equal(clientInternals(client).listeners.size, 0);
      assert.equal(vi.mocked(client.stop).mock.calls.length, 1);
      const warnings = editor.events.filter((event) => event.warningCode === "cleanup-unverified");
      assert.equal(warnings.length, outcome === "clean" ? 0 : 1, "Late warnings must precede emitter disposal");
      if (outcome === "clean") assert.equal(await f.writers.reserve({}, file), file);
      else await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
    });
  });
}

for (const failure of ["timeout", "prompt-rejection", "process-exit"] as const) {
  for (const pendingObserved of [false, true]) {
    test(`queued snapshots survive ${failure} with a ${pendingObserved ? "reported" : "unreported"} pending record`, async () => {
      await fixture(async (f) => {
        const editor = await f.launch(await f.session("editor"));
        const client = editor.internal.client as RpcClient;
        const submitted = deferred();
        const acknowledgement = deferred<string | undefined>();
        const pendingAck = deferred();
        const stopStarted = deferred();
        const finishStop = deferred();
        const restored: string[] = [];
        const emit = clientInternals(client).emit.bind(client);
        let queue = { steering: [] as string[], followUp: [] as string[] };
        vi.spyOn(client, "steer").mockImplementation(async (text) => {
          queue = { ...queue, steering: [...queue.steering, text] };
          emit({ type: "queue_update", ...queue });
        });
        vi.spyOn(client, "followUp").mockImplementation(async (text) => {
          if (pendingObserved) {
            queue = { ...queue, followUp: [...queue.followUp, text] };
            emit({ type: "queue_update", ...queue });
          }
          await pendingAck.promise;
        });
        vi.spyOn(client, "prompt").mockImplementation(async () => {
          submitted.resolve();
          return failure === "prompt-rejection" ? acknowledgement.promise : undefined;
        });
        const createWaiter = editor.internal.createSettledWaiter.bind(editor.internal);
        vi.spyOn(editor.internal, "createSettledWaiter").mockImplementation(() => createWaiter(100));
        vi.useFakeTimers();
        const request = editor.runtime.prompt("ordinary request", undefined, undefined, undefined, undefined, true);
        const rejectedRequest = assert.rejects(request, /Timed out|Prompt acknowledgement failed|exited/);
        try {
          await submitted.promise;
          for (const text of ["delivered", "awaiting", "queued"]) {
            await editor.runtime.queueInstruction("steer", text, {
              recoveryText: `${text} draft`,
              hasAttachments: true,
              recoveryBytes: 10,
              restoreAttachments: () => restored.push(text),
            });
          }
          queue = { ...queue, steering: ["queued"] };
          emit({ type: "queue_update", ...queue });
          emit({ type: "message_start", message: { role: "user", content: "delivered" } });
          const pending = editor.runtime.queueInstruction("followUp", "pending", {
            recoveryText: "pending attachment draft",
            hasAttachments: true,
            recoveryBytes: 10,
            restoreAttachments: () => restored.push("pending"),
          });
          const rejectedPending = assert.rejects(pending, /uncertain/);
          vi.spyOn(client, "stop").mockImplementation(async () => {
            stopStarted.resolve();
            await finishStop.promise;
            f.transport(client).running = false;
            emit({ type: "process_exit", expected: true });
          });
          if (failure === "timeout") await vi.advanceTimersByTimeAsync(100);
          else if (failure === "prompt-rejection") acknowledgement.reject(new Error("Prompt acknowledgement failed."));
          else {
            f.transport(client).running = false;
            emit({ type: "process_exit", expected: false });
          }
          await stopStarted.promise;
          const recovered = editor.runtime.currentState.recoveredDrafts;
          assert.deepEqual(
            recovered?.map(({ text, uncertain, hasAttachments }) => ({ text, uncertain, hasAttachments })),
            ["awaiting draft", "queued draft", "pending attachment draft"].map((text) => ({
              text,
              uncertain: true,
              hasAttachments: true,
            })),
          );
          assert.equal(editor.internal.client, undefined);
          emit({ type: "process_exit", expected: true });
          emit({ type: "queue_update", steering: ["late old queue"], followUp: [] });
          await editor.internal.stopClient();
          assert.deepEqual(editor.runtime.currentState.recoveredDrafts, recovered, "Recovery is idempotent");
          for (const draft of recovered ?? []) {
            editor.runtime.restoreRecoveredDraftAttachments(draft.id);
            editor.runtime.restoreRecoveredDraftAttachments(draft.id);
          }
          assert.deepEqual(restored, ["awaiting", "queued", "pending"]);
          assert.equal(vi.mocked(client.prompt).mock.calls.length, 1, "Recovery must not replay the prompt");
          assert.equal(vi.mocked(client.steer).mock.calls.length, 3, "Recovery must not replay queued instructions");
          finishStop.resolve();
          await rejectedRequest;
          pendingAck.reject(new Error("Queue acknowledgement failed after exit."));
          await rejectedPending;
          assert.deepEqual(
            editor.runtime.currentState.recoveredDrafts?.map((draft) => draft.text),
            recovered?.map((draft) => draft.text),
          );
        } finally {
          finishStop.resolve();
          pendingAck.resolve();
          acknowledgement.resolve(undefined);
          await vi.advanceTimersByTimeAsync(100);
          await Promise.allSettled([request]);
          vi.useRealTimers();
        }
      });
    });
  }
}

for (const kind of ["steer", "followUp"] as const) {
  for (const pendingObserved of [false, true]) {
    test(`equal-text ${kind} snapshots survive timeout with ${pendingObserved ? "a reported" : "an unreported"} pending record`, async () => {
      await fixture(async (f) => {
        const editor = await f.launch(await f.session("editor"));
        const client = editor.internal.client as RpcClient;
        const submitted = deferred();
        const pendingAck = deferred();
        const firstImages = [{ type: "image" as const, data: "R0lGODlhAgADAAAAAA==", mimeType: "image/gif" }];
        const secondImages = [{ type: "image" as const, data: "R0lGODlhBAAFAAAAAA==", mimeType: "image/gif" }];
        const restored: unknown[] = [];
        const emit = clientInternals(client).emit.bind(client);
        let queue = { steering: [] as string[], followUp: [] as string[] };
        let submissions = 0;
        const queued = vi.spyOn(client, kind).mockImplementation(async (text) => {
          submissions++;
          if (submissions === 1 || pendingObserved) {
            const queueKind = kind === "steer" ? "steering" : "followUp";
            queue = { ...queue, [queueKind]: [...queue[queueKind], text] };
            emit({ type: "queue_update", ...queue });
          }
          if (submissions === 2) await pendingAck.promise;
        });
        vi.spyOn(client, "prompt").mockImplementation(async () => {
          submitted.resolve();
          return undefined;
        });
        const createWaiter = editor.internal.createSettledWaiter.bind(editor.internal);
        vi.spyOn(editor.internal, "createSettledWaiter").mockImplementation(() => createWaiter(100));
        vi.useFakeTimers();
        const request = editor.runtime.prompt("ordinary request", undefined, undefined, undefined, undefined, true);
        const rejectedRequest = assert.rejects(request, /Timed out/);
        let rejectedPending: Promise<void> | undefined;
        try {
          await submitted.promise;
          await editor.runtime.queueInstruction(kind, "revise", {
            images: firstImages,
            recoveryText: "first image draft",
            hasAttachments: true,
            recoveryBytes: 10,
            restoreAttachments: () => restored.push(firstImages),
          });
          const pending = editor.runtime.queueInstruction(kind, "revise", {
            images: secondImages,
            recoveryText: "second image draft",
            hasAttachments: true,
            recoveryBytes: 10,
            restoreAttachments: () => restored.push(secondImages),
          });
          rejectedPending = assert.rejects(pending, /uncertain/);
          await vi.advanceTimersByTimeAsync(100);
          await rejectedRequest;
          const recovered = editor.runtime.currentState.recoveredDrafts;
          assert.deepEqual(
            recovered?.map(({ text, uncertain, hasAttachments }) => ({ text, uncertain, hasAttachments })),
            ["first image draft", "second image draft"].map((text) => ({
              text,
              uncertain: true,
              hasAttachments: true,
            })),
          );
          assert.equal(new Set(recovered?.map((draft) => draft.id)).size, 2, "Each snapshot keeps its own identity");
          for (const draft of recovered ?? []) {
            editor.runtime.restoreRecoveredDraftAttachments(draft.id);
            editor.runtime.restoreRecoveredDraftAttachments(draft.id);
          }
          assert.deepEqual(restored, [firstImages, secondImages], "Each image snapshot is restored only once");
          assert.deepEqual(
            queued.mock.calls.map((call) => call[1]),
            [firstImages, secondImages],
          );
          assert.equal(vi.mocked(client.prompt).mock.calls.length, 1, "Recovery must not replay the request");
          assert.equal(submissions, 2, "Recovery must not replay either queued instruction");
          pendingAck.reject(new Error("Queue acknowledgement failed after timeout."));
          await rejectedPending;
          emit({ type: "process_exit", expected: true });
          assert.deepEqual(
            editor.runtime.currentState.recoveredDrafts?.map((draft) => draft.text),
            ["first image draft", "second image draft"],
            "Late acknowledgement failure and exit do not repeat recovery",
          );
        } finally {
          pendingAck.resolve();
          await vi.advanceTimersByTimeAsync(100);
          await Promise.allSettled([rejectedRequest, rejectedPending]);
          vi.useRealTimers();
        }
      });
    });
  }
}

for (const phase of ["idle", "active", "startup", "detached-warning", "detached-error"] as const) {
  test(`cleanup uncertainty marks the captured canonical launch root (${phase})`, async () => {
    await fixture(async (f) => {
      const mark = vi.spyOn(operationLocks, "markWorkspaceCleanupUnverified");
      const editor = f.create();
      const otherCwd = path.join(f.root, "changed-workspace");
      const currentCwd = vi.spyOn(editor.runtime, "currentCwd", "get").mockReturnValue(f.root);
      if (phase === "startup") {
        const start = f.start.getMockImplementation();
        assert.ok(start);
        f.start.mockImplementationOnce(async function (this: RpcClient) {
          await start.call(this);
          currentCwd.mockReturnValue(otherCwd);
          throw new Error("Startup failed after launch.");
        });
        f.stop.mockRejectedValueOnce(new Error("Startup cleanup failed."));
        await assert.rejects(editor.runtime.ensureStarted(), /Startup cleanup failed/);
      } else {
        await editor.runtime.ensureStarted();
        const client = editor.internal.client as RpcClient;
        const accepted = deferred();
        let request: Promise<unknown> | undefined;
        if (phase === "active") {
          request = assert.rejects(
            editor.runtime.prompt("active request", undefined, undefined, () => accepted.resolve()),
            /exited/,
          );
          await accepted.promise;
        }
        currentCwd.mockReturnValue(otherCwd);
        if (phase.startsWith("detached")) {
          vi.spyOn(client, "stop").mockImplementation(async () => {
            if (phase === "detached-error") throw new Error("Detached cleanup failed.");
            clientInternals(client).emit(cleanupWarning);
          });
          const stopping = editor.internal.stopClient();
          if (phase === "detached-error") await assert.rejects(stopping, /Detached cleanup failed/);
          else await stopping;
        } else {
          clientInternals(client).emit(cleanupWarning);
          assert.deepEqual(mark.mock.calls, [[f.root]], "Mark before the request lease can settle");
          f.transport(client).running = false;
          clientInternals(client).emit({ type: "process_exit", expected: false });
          await request;
        }
      }
      assert.ok(mark.mock.calls.length > 0);
      assert.ok(mark.mock.calls.every(([root]) => root === f.root));
      assert.throws(() => acquireOperation(f.root, "Apply"), /cleanup is unverified/);
      const releaseOther = acquireOperation(otherCwd, "unrelated workspace operation");
      releaseOther();
    });
  });
}

test("a detached cleanup warning marks only its original root after another workspace starts", async () => {
  await fixture(async (f) => {
    const mark = vi.spyOn(operationLocks, "markWorkspaceCleanupUnverified");
    const editor = await f.launch(await f.session("original"));
    const original = editor.internal.client as RpcClient;
    const stopStarted = deferred();
    const finishStop = deferred();
    vi.spyOn(original, "stop").mockImplementation(async () => {
      stopStarted.resolve();
      await finishStop.promise;
      clientInternals(original).emit(cleanupWarning);
    });
    const stopping = editor.internal.stopClient();
    await stopStarted.promise;
    const otherRoot = await mkdtemp(path.join(f.root, "other-workspace-"));
    vi.spyOn(editor.runtime, "currentCwd", "get").mockReturnValue(otherRoot);
    await editor.internal.rememberSession(undefined);
    try {
      await editor.runtime.ensureStarted();
      const replacement = editor.internal.client;
      assert.notEqual(replacement, original);
      assert.equal(clientInternals(replacement).options.cwd, otherRoot);
      finishStop.resolve();
      await stopping;
      assert.deepEqual(mark.mock.calls, [[f.root]]);
      assert.equal(editor.internal.client, replacement);
      assert.equal(editor.runtime.currentState.connected, true, "Old stop completion must not reset its replacement");
      assert.throws(() => acquireOperation(f.root, "Apply"), /cleanup is unverified/);
      const release = acquireOperation(otherRoot, "Apply in the replacement workspace");
      release();
    } finally {
      finishStop.resolve();
      await stopping;
    }
  });
});

test("saved session storage is not used as the workspace cleanup root", async () => {
  await fixture(async (f) => {
    const storage = await realpath(await mkdtemp(path.join(tmpdir(), "pi-separate-session-storage-")));
    try {
      const file = path.join(storage, "session.jsonl");
      await writeFile(file, `${JSON.stringify({ type: "session", id: "stored", cwd: f.root })}\n`);
      const editor = await f.launch(file);
      const client = editor.internal.client as RpcClient;
      clientInternals(client).emit(cleanupWarning);
      assert.throws(() => acquireOperation(f.root, "Apply"), /cleanup is unverified/);
      const release = acquireOperation(storage, "unrelated session storage operation");
      release();
    } finally {
      await rm(storage, { recursive: true, force: true });
    }
  });
});

test("clean cleanup and stale generic warnings do not infer a workspace cleanup root", async () => {
  await fixture(async (f) => {
    const mark = vi.spyOn(operationLocks, "markWorkspaceCleanupUnverified");
    const file = await f.session("editor");
    const editor = await f.launch(file);
    const generation = editor.runtime.clientGeneration;
    await editor.internal.stopClient();
    assert.deepEqual(mark.mock.calls, []);
    await editor.runtime.ensureStarted();
    editor.internal.emitWarning(cleanupWarning, generation);
    assert.deepEqual(mark.mock.calls, []);
    const release = acquireOperation(f.root, "Apply after clean cleanup");
    release();
    const unboundClient = new PiRpcClient({ executablePath: process.execPath, cwd: f.root });
    vi.spyOn(unboundClient, "stop").mockImplementation(async () => clientInternals(unboundClient).emit(cleanupWarning));
    await editor.internal.stopDetachedClient(unboundClient);
    assert.deepEqual(mark.mock.calls, [], "Do not infer a launch root from the session path or current workspace");
  });
});

test("shutdown drains every detached and current stop after one stop rejects", async () => {
  await fixture(async (f) => {
    const files = await Promise.all([f.session("first"), f.session("second"), f.session("third")]);
    const editor = await f.launch(files[0]);
    const clients: RpcClient[] = [];
    const releases = [deferred(), deferred(), deferred()] as const;
    const started = [deferred(), deferred(), deferred()] as const;
    const stops: Promise<void>[] = [];
    for (const [index, file] of files.entries()) {
      const release = releases[index];
      const start = started[index];
      assert.ok(release && start);
      if (index) await editor.internal.createAndStartClient(file);
      const client = editor.internal.client as RpcClient;
      clients.push(client);
      vi.spyOn(client, "stop").mockImplementation(async () => {
        start.resolve();
        await release.promise;
        if (!index) throw new Error("First detached stop failed.");
        if (index === 1) clientInternals(client).emit(cleanupWarning);
        f.transport(client).running = false;
        clientInternals(client).emit({ type: "process_exit", expected: true });
      });
      if (index < files.length - 1) stops.push(editor.internal.stopClient());
    }
    const stopsResult = Promise.allSettled(stops);
    const controlDisposed = vi.spyOn(editor.internal.control, "dispose");
    const shutdown = editor.runtime.shutdown();
    const shutdownResult = Promise.allSettled([shutdown]);
    let closed = false;
    void shutdownResult.then(() => {
      closed = true;
    });
    try {
      await Promise.all(started.map((signal) => signal.promise));
      releases[0].resolve();
      // Wait for the rejection without waiting for the other stop.
      const firstStop = stops[0];
      assert.ok(firstStop);
      await assert.rejects(firstStop, /First detached stop failed/);
      await Promise.resolve();
      assert.equal(closed, false, "A failed stop must not dispose subscriptions for remaining stops");
      assert.equal(controlDisposed.mock.calls.length, 0);
      for (const file of files) await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      releases[2].resolve();
      await Promise.resolve();
      assert.equal(closed, false, "The still-pending earlier stop must remain part of shutdown");
    } finally {
      for (const release of releases) release.resolve();
    }
    await stopsResult;
    const [result] = await shutdownResult;
    assert.equal(result?.status, "rejected");
    assert.equal(controlDisposed.mock.calls.length, 1);
    assert.equal(editor.events.filter((event) => event.warningCode === "cleanup-unverified").length, 2);
    for (const client of clients) assert.equal(clientInternals(client).listeners.size, 0);
    await assert.rejects(f.writers.reserve({}, files[0]), SessionInUseError);
    await assert.rejects(f.writers.reserve({}, files[1]), SessionInUseError);
    assert.equal(await f.writers.reserve({}, files[2]), files[2]);
  });
});

for (const phase of ["reservation", "client-start"] as const) {
  test(`disposal during ${phase} waits for startup cleanup without leaking a writer`, async () => {
    await fixture(async (f) => {
      const file = await f.session("editor");
      const editor = f.create();
      await editor.internal.rememberSession(file);
      const reached = deferred();
      const release = deferred();
      if (phase === "reservation") {
        const reserve = f.writers.reserve.bind(f.writers);
        vi.spyOn(f.writers, "reserve").mockImplementationOnce(async (owner: object, sessionFile: string) => {
          const key = await reserve(owner, sessionFile);
          reached.resolve();
          await release.promise;
          return key;
        });
      } else {
        const start = f.start.getMockImplementation();
        assert.ok(start);
        f.start.mockImplementationOnce(async function (this: RpcClient) {
          await start.call(this);
          reached.resolve();
          await release.promise;
        });
      }
      const startup = editor.runtime.ensureStarted();
      const rejectedStartup = assert.rejects(startup, /disposed|replaced/);
      await reached.promise;
      const client = editor.internal.client as RpcClient;
      editor.runtime.dispose();
      const shutdown = editor.runtime.shutdownCompletion;
      assert.ok(shutdown);
      let shutdownSettled = false;
      void shutdown.then(() => {
        shutdownSettled = true;
      });
      try {
        await Promise.resolve();
        assert.equal(shutdownSettled, false);
        await assert.rejects(f.writers.reserve({}, file), SessionInUseError);
      } finally {
        release.resolve();
      }
      await rejectedStartup;
      await shutdown;
      assert.equal(editor.internal.client, undefined);
      assert.equal(clientInternals(client).listeners.size, 0);
      assert.equal(f.start.mock.calls.length, phase === "reservation" ? 0 : 1);
      assert.equal(f.stop.mock.calls.length, 1);
      assert.equal(await f.writers.reserve({}, file), file);
    });
  });
}

for (const saved of [false, true]) {
  test(`cold auxiliary Sidebar startup (${saved ? "saved" : "fresh"}) preserves A's active agent lease`, async () => {
    await fixture(async (f) => {
      const firstFile = await f.session("primary");
      const first = await f.launch(firstFile, { editorSession: false });
      clientInternals(first.internal.client).emit({ type: "agent_start" });
      clientInternals(first.internal.client).emit({ type: "queue_update", steering: ["A only"], followUp: [] });
      const before = first.runtime.currentState;
      const client = first.internal.client;
      const file = saved ? await f.session("auxiliary") : undefined;
      const auxiliary = f.create({
        sidebarSession: true,
        editorWorkspace: { uri: MockUri.file(f.root) as unknown as vscode.Uri, root: f.root },
        ...(file ? { initialSession: { file, sessionId: "auxiliary" } } : {}),
      });
      const release = acquireAgentOperation(f.root, "A agent request", () => {});
      try {
        await auxiliary.runtime.ensureStarted();
        assert.equal(clientInternals(auxiliary.internal.client).options.sessionPath, file);
        assert.equal(auxiliary.runtime.currentState.connected, true);
        assert.equal(f.start.mock.calls.length, 2);
        assert.equal(f.switchSession.mock.calls.length, 0);
        assert.equal(f.stop.mock.calls.length, 0);
        assert.equal(first.internal.client, client);
        assert.deepEqual(first.runtime.currentState, before);
        assert.throws(() => acquireOperation(f.root, "Apply"), /A agent request/);
        await assert.rejects(auxiliary.runtime.switchSession(firstFile, "primary"), /A agent request/);
        assert.equal(f.switchSession.mock.calls.length, 0);
        for (const sessionFile of [firstFile, auxiliary.runtime.currentState.sessionFile]) {
          assert.ok(sessionFile);
          await assert.rejects(f.writers.reserve({}, sessionFile), SessionInUseError);
        }
      } finally {
        release();
      }
    });
  });
}

for (const executable of ["", "pi"]) {
  test(`initial saved identity mismatch never falls back (${executable || "bundled"})`, async () => {
    await fixture(async (f) => {
      mock.workspace.getConfiguration = () => ({
        get: (key: string, fallback: unknown) => (key === "executablePath" ? executable : fallback),
      });
      const file = await f.session("replaced");
      const auxiliary = f.create({ sidebarSession: true, initialSession: { file, sessionId: "selected" } });
      await assert.rejects(auxiliary.runtime.ensureStarted(), /no longer matches the selected session/);
      assert.equal(f.start.mock.calls.length, 0);
      assert.equal(f.switchSession.mock.calls.length, 0);
      assert.deepEqual(auxiliary.writes, []);
      assert.equal(
        auxiliary.events.some((event) => event.warningCode === "session-replaced"),
        false,
      );
      assert.equal(await f.writers.reserve({}, file), file);
    });
  });
}

for (const invalid of ["missing", "foreign-cwd", "missing-id", "symlink", "hardlink", "writer"] as const) {
  test(`initial saved session rejects ${invalid} before spawning`, async () => {
    if (invalid === "symlink" && process.platform === "win32") return;
    await fixture(async (f) => {
      let file = await f.session("selected");
      if (invalid === "missing") await rm(file);
      if (invalid === "foreign-cwd" || invalid === "missing-id")
        await writeFile(
          file,
          `${JSON.stringify({
            type: "session",
            ...(invalid === "missing-id" ? {} : { id: "selected" }),
            cwd: invalid === "foreign-cwd" ? process.cwd() : f.root,
          })}\n`,
        );
      if (invalid === "symlink") {
        const alias = path.join(f.root, "alias.jsonl");
        await symlink(file, alias);
        file = alias;
      }
      if (invalid === "hardlink") await link(file, path.join(f.root, "linked.jsonl"));
      if (invalid === "writer") await f.writers.reserve({}, file);
      const auxiliary = f.create({ sidebarSession: true, initialSession: { file, sessionId: "selected" } });
      await assert.rejects(auxiliary.runtime.ensureStarted());
      assert.equal(f.start.mock.calls.length, 0);
      assert.equal(f.switchSession.mock.calls.length, 0);
      assert.equal(auxiliary.internal.client, undefined);
      assert.deepEqual(auxiliary.writes, []);
      assert.equal(
        auxiliary.events.some((event) => event.warningCode === "session-replaced"),
        false,
      );
    });
  });
}

for (const phase of ["bridge", "writer"] as const) {
  test(`initial saved session replacement during ${phase} preparation rejects its unchanged header ID`, async () => {
    await fixture(async (f) => {
      const file = await f.session("selected");
      const auxiliary = f.create({ sidebarSession: true, initialSession: { file, sessionId: "selected" } });
      const replace = async () => {
        const replacement = path.join(f.root, "replacement.jsonl");
        await writeFile(replacement, `${JSON.stringify({ type: "session", id: "selected", cwd: f.root })}\n`);
        await rename(replacement, file);
      };
      if (phase === "bridge")
        auxiliary.internal.bridgeEnvironment = async () => {
          await replace();
          return {};
        };
      else {
        const reserve = f.writers.reserve.bind(f.writers);
        vi.spyOn(f.writers, "reserve").mockImplementationOnce(async (owner, sessionFile, isCurrent) => {
          const key = await reserve(owner, sessionFile, isCurrent);
          await replace();
          return key;
        });
      }
      await assert.rejects(auxiliary.runtime.ensureStarted(), /changed before startup/);
      assert.equal(f.start.mock.calls.length, 0);
      assert.equal(auxiliary.internal.client, undefined);
      assert.deepEqual(auxiliary.writes, []);
      assert.equal(await f.writers.reserve({}, file), file);
    });
  });
}

for (const mismatch of ["sessionId", "sessionFile"] as const) {
  test(`initial startup disconnects if RPC reports a different ${mismatch}`, async () => {
    await fixture(async (f) => {
      const file = await f.session("selected");
      const auxiliary = f.create({ sidebarSession: true, initialSession: { file } });
      const start = f.start.getMockImplementation();
      assert.ok(start);
      f.start.mockImplementationOnce(async function (this: RpcClient) {
        await start.call(this);
        f.transport(this).state[mismatch] = mismatch === "sessionId" ? "other" : await f.session("other");
      });
      await assert.rejects(auxiliary.runtime.ensureStarted(), /different destination session/);
      assert.equal(f.start.mock.calls.length, 1);
      assert.equal(f.stop.mock.calls.length, 1);
      assert.equal(auxiliary.internal.client, undefined);
      assert.deepEqual(auxiliary.writes, []);
      assert.equal(await f.writers.reserve({}, file), file);
    });
  });
}

test("a concurrent request cannot bypass initial-session verification once its process is running", async () => {
  await fixture(async (f) => {
    const file = await f.session("selected");
    const auxiliary = f.create({ sidebarSession: true, initialSession: { file, sessionId: "selected" } });
    const reached = deferred();
    const resume = deferred();
    vi.spyOn(PiRpcClient.prototype, "getState").mockImplementationOnce(async () => {
      reached.resolve();
      await resume.promise;
      return { sessionFile: file, sessionId: "replacement" };
    });
    vi.mocked(PiRpcClient.prototype.prompt).mockResolvedValue("handled");
    const startup = auxiliary.runtime.ensureStarted();
    const startupResult = Promise.allSettled([startup]);
    await reached.promise;
    const request = auxiliary.runtime.prompt("Do not send before verifying the selected session");
    const requestResult = Promise.allSettled([request]);
    try {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
    } finally {
      resume.resolve();
    }
    assert.equal((await startupResult)[0]?.status, "rejected");
    assert.equal((await requestResult)[0]?.status, "rejected");
    assert.equal(f.start.mock.calls.length, 1);
    assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
  });
});

test("initial session is consumed after verified startup; later reconnect uses this runtime's current memory", async () => {
  await fixture(async (f) => {
    const first = await f.session("first");
    const second = await f.session("second");
    const auxiliary = f.create({ sidebarSession: true, initialSession: { file: first, sessionId: "first" } });
    await auxiliary.runtime.ensureStarted();
    await auxiliary.runtime.switchSession(second, "second");
    await auxiliary.internal.stopClient();
    await auxiliary.runtime.ensureStarted();
    assert.equal(clientInternals(auxiliary.internal.client).options.sessionPath, second);
    assert.equal(auxiliary.runtime.currentState.sessionId, "second");
    assert.deepEqual(auxiliary.writes, []);
    assert.equal(auxiliary.reads.includes(restoreKey), false);
  });
});

for (const change of ["removed", "retargeted"] as const) {
  test(`auxiliary Sidebar rejects its ${change} bound workspace without editor fallback`, async () => {
    await fixture(async (f) => {
      const { opened, other, otherFolder, linkType, uri, editor, exit } = await boundWorkspace(
        f,
        true,
        "sidebarSession",
      );
      await editor.runtime.ensureStarted(uri);
      exit();
      if (change === "removed") mock.workspace.workspaceFolders = [otherFolder];
      else {
        await rm(opened);
        await symlink(other, opened, linkType);
      }
      await assert.rejects(editor.runtime.ensureStarted(), /workspace changed/);
      await assert.rejects(editor.runtime.prompt("Do not send elsewhere"), /workspace changed/);
      assert.equal(f.start.mock.calls.length, 1);
      assert.equal(vi.mocked(PiRpcClient.prototype.prompt).mock.calls.length, 0);
    });
  });
}

for (const ending of ["response", "expiry", "invalidation"] as const) {
  test(`dialog ${ending} emits current runtime state after removing only its origin request`, async () => {
    await fixture(async (f) => {
      const first = await f.launch(await f.session("first"), { sidebarSession: true });
      const second = await f.launch(await f.session("second"), { sidebarSession: true });
      const pending: boolean[] = [];
      first.runtime.onDidChangeState(() => pending.push(first.runtime.hasPendingExtensionDialogs));
      const send = vi.spyOn(PiRpcClient.prototype, "sendExtensionUiResponse").mockImplementation(() => {});
      const event: PiRpcEvent = {
        type: "extension_ui_request",
        id: "equal-id",
        method: "input",
        ...(ending === "expiry" ? { timeout: 5 } : {}),
      };
      clientInternals(first.internal.client).emit(event);
      clientInternals(second.internal.client).emit({ ...event, timeout: undefined });
      const request: ExtensionDialogRequest | undefined = first.runtime.claimExtensionUiRequest(event);
      assert.ok(request);
      assert.equal(first.runtime.hasPendingExtensionDialogs, true);
      assert.equal(second.runtime.hasPendingExtensionDialogs, true);
      if (ending === "response") request.respond({ value: "first only" });
      if (ending === "invalidation") first.runtime.resetExtensionUi();
      await vi.waitFor(() => assert.deepEqual(pending, [false]));
      assert.equal(first.runtime.hasPendingExtensionDialogs, false);
      assert.equal(second.runtime.hasPendingExtensionDialogs, true);
      assert.equal(send.mock.calls.length, ending === "response" ? 1 : 0);
      request.respond({ value: "late" });
      assert.deepEqual(pending, [false]);
      assert.equal(send.mock.calls.length, ending === "response" ? 1 : 0);
    });
  });
}
