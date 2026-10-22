import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import type { PiRpcClient, PiRpcClientOptions, PiRpcEvent } from "../piRpcClient";
import type { PiRuntimeManager, PiRuntimeState } from "../piRuntime";
import { installVscodeMock } from "./vscodeMock";

interface RuntimeInternals {
  client: PiRpcClient | undefined;
  clientSubscription: vscode.Disposable | undefined;
  state: PiRuntimeState;
  ensureStarted: () => Promise<void>;
  handleEvent: (event: PiRpcEvent) => void;
  bridgeEnvironment: () => Promise<NodeJS.ProcessEnv>;
  buildClientOptions: () => PiRpcClientOptions;
  refreshState: () => Promise<void>;
  createAndStartClient: (sessionPath: string | undefined) => Promise<void>;
}

const mock = installVscodeMock();
afterAll(() => mock.restore());

const cleanupWarning: PiRpcEvent = {
  type: "runtime_warning",
  warningCode: "cleanup-unverified",
  message: "Pi process exited; Windows descendant cleanup could not be verified.",
};

class CleanupClient {
  public readonly listeners = new Set<(event: PiRpcEvent) => void>();
  public isRunning = true;
  public readonly order: string[] = [];

  public constructor(private readonly fails: boolean) {}

  public onEvent(listener: (event: PiRpcEvent) => void): vscode.Disposable {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
      },
    };
  }

  public emit(event: PiRpcEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  public async stop(): Promise<void> {
    this.order.push("stop");
    await Promise.resolve();
    this.emit(cleanupWarning);
    this.isRunning = false;
    this.emit({ type: "process_exit", code: 0, signal: null, expected: true });
    this.order.push("stop-settled");
    if (this.fails) throw new Error("Fixture stop failed.");
  }
}

function createRuntime(): PiRuntimeManager {
  const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
  return new PiRuntimeManager({
    extensionUri: mock.Uri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
}

for (const mode of ["trash", "permanent", "stop-failure"] as const) {
  test(`foreground ${mode} reports cleanup before deleting or replacing a session`, async () => {
    const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-cleanup-"));
    const session = path.join(root, "session.jsonl");
    writeFileSync(session, `${JSON.stringify({ type: "session", cwd: process.cwd() })}\n`);
    const runtime = createRuntime();
    const internal = runtime as unknown as RuntimeInternals;
    const client = new CleanupClient(mode === "stop-failure");
    const events: PiRpcEvent[] = [];
    runtime.onEvent((event) => {
      if (event.type !== "extension_ui_reset") events.push(event);
      if (event.type === "runtime_warning") client.order.push("warning");
    });
    internal.state = { ...runtime.currentState, connected: true, sessionFile: session };
    internal.client = client as unknown as PiRpcClient;
    internal.clientSubscription = client.onEvent((event) => internal.handleEvent(event));
    internal.ensureStarted = async () => {
      if (!internal.state.connected) {
        client.order.push("replacement");
        internal.state = { ...internal.state, connected: true, sessionFile: path.join(root, "replacement.jsonl") };
      }
    };
    mock.workspace.fs = {
      delete: async (uri: vscode.Uri, options: { useTrash: boolean }) => {
        assert.equal(uri.fsPath, session);
        assert.equal(options.useTrash, mode !== "permanent");
        client.order.push("delete");
        rmSync(session);
      },
    };
    try {
      const deletion = mode === "permanent" ? runtime.deleteSessionPermanently(session) : runtime.deleteSession();
      if (mode === "stop-failure") {
        await assert.rejects(deletion, /Fixture stop failed/);
        assert.deepEqual(client.order, ["stop", "warning", "stop-settled"]);
      } else {
        await deletion;
        assert.deepEqual(client.order, ["stop", "warning", "stop-settled", "delete", "replacement"]);
      }
      assert.deepEqual(events, [cleanupWarning], "old-client exit must not enter the detached runtime event stream");
      assert.equal(client.listeners.size, 0, "cleanup subscriptions must be released on success and failure");
      client.emit(cleanupWarning);
      client.emit({ type: "process_exit", code: 7, signal: null, expected: false });
      assert.deepEqual(events, [cleanupWarning], "late detached-client events must not reach a replacement session");
    } finally {
      runtime.dispose();
      rmSync(root, { recursive: true, force: true });
    }
  });
}

for (const phase of ["refresh", "start-exit"]) {
  test(`foreground ${phase} failure reports cleanup and releases its subscription`, async () => {
    const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
    const startupExit: PiRpcEvent = { type: "process_exit", code: 1, signal: null, expected: true };
    const reset: PiRpcEvent = { type: "extension_ui_reset" };
    const expectedEvents =
      phase === "start-exit" ? [reset, startupExit, cleanupWarning] : [reset, reset, cleanupWarning];
    const start = vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(async function (this: PiRpcClient) {
      if (phase === "start-exit") {
        (this as unknown as { emit: (event: PiRpcEvent) => void }).emit(startupExit);
        throw new Error("Fixture startup failed.");
      }
    });
    let stoppedClient: { emit: (event: PiRpcEvent) => void; listeners: Set<unknown> } | undefined;
    const stop = vi.spyOn(PiRpcClient.prototype, "stop").mockImplementation(async function (this: PiRpcClient) {
      stoppedClient = this as unknown as NonNullable<typeof stoppedClient>;
      await Promise.resolve();
      stoppedClient.emit(cleanupWarning);
      stoppedClient.emit({ type: "process_exit", code: 0, signal: null, expected: true });
    });
    const runtime = createRuntime();
    const internal = runtime as unknown as RuntimeInternals;
    const events: PiRpcEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    internal.bridgeEnvironment = async () => ({});
    internal.buildClientOptions = () => ({ executablePath: process.execPath, cwd: process.cwd() });
    internal.refreshState = async () => {
      throw new Error("Fixture refresh failed.");
    };
    try {
      await assert.rejects(internal.createAndStartClient(undefined), /Fixture (startup|refresh) failed/);
      assert.deepEqual(events, expectedEvents);
      assert.equal(internal.client, undefined);
      assert.equal(internal.clientSubscription, undefined);
      assert.ok(stoppedClient);
      assert.equal(stoppedClient.listeners.size, 0);
      stoppedClient.emit(cleanupWarning);
      assert.deepEqual(events, expectedEvents);
    } finally {
      runtime.dispose();
      start.mockRestore();
      stop.mockRestore();
    }
  });
}
