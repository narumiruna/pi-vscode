import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient, buildPiProcessEnvironment } = require("../piRpcClient") as typeof import("../piRpcClient");
const annotationKey = "PI_VSCODE_ANNOTATION_TOKEN";
afterAll(() => mock.restore());

interface Response {
  id: string;
  ok: boolean;
  result?: any;
  error?: string;
}

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function connect(environment: NodeJS.ProcessEnv, method: string, params: unknown, token?: string) {
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(environment.PI_VSCODE_BRIDGE_PORT) });
  const result = new Promise<Response | undefined>((resolve, reject) => {
    let output = "";
    socket.once("connect", () =>
      socket.write(
        JSON.stringify({ id: "annotation-test", token: token ?? environment.PI_VSCODE_BRIDGE_TOKEN, method, params }) +
          "\n",
      ),
    );
    socket.on("data", (chunk) => {
      output += chunk;
    });
    socket.once("error", reject);
    socket.once("close", () => {
      try {
        resolve(output ? JSON.parse(output) : undefined);
      } catch (error) {
        reject(error);
      }
    });
  });
  return { socket, result };
}

function rejected(response: Response | undefined, secrets: readonly string[]) {
  assert.ok(response, "The authenticated bridge must return a bounded rejection.");
  assert.equal(response.ok, false);
  assert.equal(typeof response.error, "string");
  assert.ok(response.error!.length < 1_000);
  assert.equal(response.result, undefined);
  for (const secret of secrets) assert.ok(!JSON.stringify(response).includes(secret), "Errors must not echo tokens.");
}

interface Fixture {
  runtime: InstanceType<typeof PiRuntimeManager>;
  internal: any;
  root: string;
  environment: NodeJS.ProcessEnv;
  terminalEnvironment: Map<string, string>;
  starts: any;
  annotate: any;
  credential: () => string;
  request: (method: string, params: unknown, token?: string) => Promise<Response | undefined>;
  origin: (credential?: string, sessionId?: string, cwd?: string) => Promise<string>;
  marks: (origin: string) => Record<string, unknown>;
}

async function fixture(run: (fixture: Fixture) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-annotation-runtime-"));
  const root = await realpath(directory);
  const folder = { uri: MockUri.file(root), name: "Fixture" };
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  mock.workspace.textDocuments = [];
  mock.window.activeTextEditor = undefined;
  mock.window.visibleTextEditors = [];
  const terminalEnvironment = new Map<string, string>();
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: {
      clear: () => terminalEnvironment.clear(),
      replace: (key: string, value: string) => terminalEnvironment.set(key, value),
    },
  } as unknown as vscode.ExtensionContext);
  const internal = runtime as any;
  const clients: any[] = [];
  const starts = vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(async function (this: any) {
    // Supply transport liveness without a child process or a live provider.
    this.process = { exitCode: null };
    clients.push(this);
  });
  const stop = vi.spyOn(PiRpcClient.prototype, "stop").mockImplementation(async function (this: any) {
    if (!this.process) return;
    this.process = undefined;
    this.emit({ type: "process_exit", expected: true });
  });
  internal.refreshState = async () => {
    internal.updateState({
      connected: true,
      busy: false,
      sessionId: "foreground-session",
      sessionFile: path.join(root, "foreground.jsonl"),
    });
  };
  const annotate = vi.spyOn(internal.annotations, "annotate").mockImplementation(async (...args: any[]) => {
    const [params, origin] = args;
    assert.equal(origin.cwd, root);
    assert.equal(origin.root, root);
    origin.assertCurrent();
    await Promise.resolve();
    origin.assertCurrent();
    return { count: params.annotations.length, visible: true };
  });
  try {
    await runtime.initializeBridge();
    const environment = await internal.bridgeEnvironment();
    const request = (method: string, params: unknown, token?: string) =>
      connect(environment, method, params, token).result;
    const credential = () => internal.client.options.env[annotationKey] as string;
    const origin = async (value = credential(), sessionId = internal.state.sessionId, cwd = root) => {
      const response = await request("annotationOrigin", { credential: value, sessionId, cwd });
      assert.ok(response);
      assert.equal(response.ok, true);
      assert.deepEqual(Object.keys(response.result), ["origin"]);
      assert.match(response.result.origin, /^[a-f0-9]{64}$/);
      return response.result.origin as string;
    };
    await internal.createAndStartClient(undefined);
    await run({
      runtime,
      internal,
      root,
      environment,
      terminalEnvironment,
      starts,
      annotate,
      credential,
      request,
      origin,
      marks: (scope) => ({
        origin: scope,
        path: path.join(root, "source.ts"),
        annotations: [{ startLine: 1, endLine: 1, expectedText: "private source", message: "private explanation" }],
      }),
    });
  } finally {
    runtime.dispose();
    await internal.stopClient();
    for (const client of clients) await client.stop();
    annotate.mockRestore();
    stop.mockRestore();
    starts.mockRestore();
    mock.workspace.isTrusted = true;
    await rm(directory, { recursive: true, force: true });
  }
}

test("annotation credential is private to each foreground client launch, not terminal or default options", async () =>
  fixture(async ({ runtime, internal, environment, terminalEnvironment, credential, starts }) => {
    const first = credential();
    assert.match(first, /^[a-f0-9]{64}$/);
    assert.equal(starts.mock.calls.length, 1);
    assert.equal(terminalEnvironment.has(annotationKey), false);
    assert.equal(terminalEnvironment.get("PI_VSCODE_BRIDGE_TOKEN"), environment.PI_VSCODE_BRIDGE_TOKEN);
    assert.equal(environment[annotationKey], undefined);
    const options = internal.buildClientOptions(undefined, { ...environment, [annotationKey]: first });
    assert.equal(options.env[annotationKey], undefined);
    assert.equal(buildPiProcessEnvironment({ [annotationKey]: first }, options.env)[annotationKey], undefined);
    assert.ok(!JSON.stringify(runtime.currentState).includes(first));
    await internal.stopClient();
    await internal.createAndStartClient(undefined);
    assert.notEqual(credential(), first);
    assert.equal(terminalEnvironment.has(annotationKey), false);
  }));

test("annotation TCP requests require both window authentication and the private foreground binding", async () =>
  fixture(async ({ environment, root, credential, request, origin, marks, annotate }) => {
    const secret = credential();
    const scope = await origin();
    const secrets = [secret, scope, environment.PI_VSCODE_BRIDGE_TOKEN!];
    for (const [method, params] of [
      ["annotationOrigin", { credential: secret, sessionId: "foreground-session", cwd: root }],
      ["annotate", marks(scope)],
    ] as const) {
      rejected(await request(method, params, "0".repeat(64)), secrets);
      rejected(await request(method, params, ""), secrets);
    }
    for (const params of [
      { sessionId: "foreground-session", cwd: root },
      { credential: "0".repeat(64), sessionId: "foreground-session", cwd: root },
      { credential: secret, sessionId: "forged-session", cwd: root },
      { credential: secret, sessionId: "foreground-session", cwd: path.dirname(root) },
      { credential: secret, sessionId: "foreground-session", cwd: "." },
      { credential: secret, sessionId: "foreground-session", cwd: root, origin: scope },
    ])
      rejected(await request("annotationOrigin", params), secrets);
    for (const params of [
      { ...marks(scope), origin: "0".repeat(64) },
      { ...marks(scope), origin: undefined },
      { ...marks(scope), sessionId: "foreground-session" },
    ])
      rejected(await request("annotate", params), secrets);
    assert.equal(annotate.mock.calls.length, 0);
    const accepted = await request("annotate", marks(scope));
    assert.deepEqual(accepted, { id: "annotation-test", ok: true, result: { count: 1, visible: true } });
    assert.doesNotMatch(JSON.stringify(accepted), /private source|private explanation|origin|credential/);
    for (const secret of secrets) assert.ok(!JSON.stringify(accepted).includes(secret));
  }));

test("annotations are permitted inside the actual active prompt while foreground ownership is held", async () =>
  fixture(async ({ runtime, internal, request, origin, marks }) => {
    const began = deferred();
    const prompt = vi.spyOn(PiRpcClient.prototype, "prompt").mockImplementation(async () => {
      began.resolve();
      return undefined;
    });
    const pending = runtime.prompt("Explain this passage.");
    try {
      await began.promise;
      assert.equal(internal.ownership.isPending, true);
      assert.equal(internal.promptActive, true);
      const scope = await origin();
      assert.deepEqual((await request("annotate", marks(scope)))?.result, { count: 1, visible: true });
    } finally {
      internal.client.emit({ type: "agent_settled" });
      await pending;
      prompt.mockRestore();
    }
    assert.equal(internal.ownership.isPending, false);
  }));

test("session-control ownership rejects annotation origin and mutation requests", async () =>
  fixture(async ({ runtime, internal, root, credential, request, origin, marks, annotate }) => {
    const scope = await origin();
    const began = deferred();
    const release = deferred();
    const control = vi.spyOn(PiRpcClient.prototype, "newSession").mockImplementation(async () => {
      began.resolve();
      await release.promise;
      return {};
    });
    const pending = runtime.newSession();
    try {
      await began.promise;
      assert.equal(internal.ownership.isPending, true);
      assert.equal(internal.promptActive, false);
      rejected(
        await request("annotationOrigin", { credential: credential(), sessionId: "foreground-session", cwd: root }),
        [credential(), scope],
      );
      rejected(await request("annotate", marks(scope)), [credential(), scope]);
      assert.equal(annotate.mock.calls.length, 0);
    } finally {
      release.resolve();
      await pending;
      control.mockRestore();
    }
    rejected(await request("annotate", marks(scope)), [credential(), scope]);
    assert.notEqual(await origin(), scope);
  }));

test("a replaced client cannot use its launch credential or scope for the current session", async () =>
  fixture(async ({ internal, root, credential, request, origin, marks, annotate }) => {
    const previousClient = internal.client;
    const previousCredential = credential();
    const previousScope = await origin();
    await internal.createAndStartClient(undefined);
    assert.notEqual(internal.client, previousClient);
    assert.notEqual(credential(), previousCredential);
    rejected(
      await request("annotationOrigin", { credential: previousCredential, sessionId: "foreground-session", cwd: root }),
      [previousCredential, previousScope, credential()],
    );
    rejected(await request("annotate", marks(previousScope)), [previousCredential, previousScope, credential()]);
    assert.equal(annotate.mock.calls.length, 0);
    previousClient.emit({ type: "process_exit", expected: true });
    const scope = await origin();
    assert.notEqual(scope, previousScope);
    assert.equal((await request("annotate", marks(scope)))?.ok, true);
  }));

for (const transition of [
  "manual clear",
  "extension UI reset",
  "session ID change",
  "session file change",
  "client replacement",
  "disconnect",
  "stop",
  "dispose",
] as const) {
  test(`${transition} invalidates captured annotation scope and deferred validation`, async () =>
    fixture(async ({ runtime, internal, credential, request, origin, marks, annotate }) => {
      const secret = credential();
      const scope = await origin();
      const began = deferred();
      const release = deferred();
      const settled = deferred<unknown>();
      let committed = 0;
      annotate.mockImplementation(async (_params: unknown, captured: any) => {
        captured.assertCurrent();
        began.resolve();
        try {
          await release.promise;
          captured.assertCurrent();
          committed++;
          settled.resolve(undefined);
          return { count: 1, visible: true };
        } catch (error) {
          settled.resolve(error);
          throw error;
        }
      });
      const pending = request("annotate", marks(scope));
      try {
        await began.promise;
        if (transition === "manual clear") runtime.clearAnnotations();
        else if (transition === "extension UI reset") runtime.resetExtensionUi();
        else if (transition === "session ID change") internal.updateState({ sessionId: "replacement-session" });
        else if (transition === "session file change") internal.updateState({ sessionFile: "/replacement.jsonl" });
        else if (transition === "client replacement") await internal.createAndStartClient(undefined);
        else if (transition === "disconnect") internal.client.emit({ type: "process_exit", expected: false });
        else if (transition === "stop") await internal.stopClient();
        else runtime.dispose();
      } finally {
        release.resolve();
      }
      const error = await settled.promise;
      assert.ok(error instanceof Error);
      assert.ok(!error.message.includes(secret));
      assert.ok(!error.message.includes(scope));
      assert.equal(committed, 0, "Late validation must not restore annotations after a lifecycle reset.");
      const response = await pending;
      if (transition === "dispose") {
        assert.equal(response, undefined, "Disposal closes the actual bridge transport.");
        await assert.rejects(
          internal.annotationRequest("annotate", marks(scope), () => false),
          /foreground/,
        );
      } else {
        rejected(response, [secret, scope]);
        rejected(await request("annotate", marks(scope)), [secret, scope]);
      }
      if (!["disconnect", "stop", "dispose"].includes(transition)) assert.notEqual(await origin(), scope);
    }));
}

test("bridge transport disconnect invalidates origin.assertCurrent during deferred annotation validation", async () =>
  fixture(async ({ internal, environment, origin, marks, annotate, credential }) => {
    const scope = await origin();
    const began = deferred();
    const release = deferred();
    const settled = deferred<unknown>();
    let committed = false;
    annotate.mockImplementation(async (_params: unknown, captured: any) => {
      captured.assertCurrent();
      began.resolve();
      try {
        await release.promise;
        captured.assertCurrent();
        committed = true;
        settled.resolve(undefined);
        return { count: 1, visible: true };
      } catch (error) {
        settled.resolve(error);
        throw error;
      }
    });
    const pending = connect(environment, "annotate", marks(scope));
    try {
      await began.promise;
      const sockets = [...internal.bridge.sockets] as net.Socket[];
      assert.equal(sockets.length, 1);
      const closed = new Promise<void>((resolve) => sockets[0]!.once("close", () => resolve()));
      // Production AbortSignal handling calls ordinary destroy(), not a forced TCP reset.
      pending.socket.destroy();
      await closed;
    } finally {
      release.resolve();
    }
    const error = await settled.promise;
    assert.ok(error instanceof Error);
    assert.match(error.message, /foreground/);
    assert.ok(!error.message.includes(credential()));
    assert.ok(!error.message.includes(scope));
    assert.equal(committed, false);
    assert.equal(await pending.result, undefined);
    assert.equal(await origin(), scope, "Cancelling one transport must not expire other current-session requests.");
  }));
