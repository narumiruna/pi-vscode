import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hasOperation } from "../operationLocks";
import { PiRpcClient } from "../piRpcClient";
import { installVscodeMock, MockUri } from "./vscodeMock";

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

test("background launch retains runtime options and appends credential removal to runtime unsets", async () => {
  const vscode = installVscodeMock();
  const { BackgroundAgentManager } = require("../backgroundAgents") as typeof import("../backgroundAgents");
  const vscodePi = require("../vscodePi") as typeof import("../vscodePi");
  const { buildPiProcessEnvironment } = require("../piSpawn") as typeof import("../piSpawn");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-background-runtime-")));
  const read = vi.spyOn(vscodePi, "readPiInvocationOptions").mockReturnValue({
    executablePath: process.execPath,
    executableArgs: ["/extension path/pi cli.js"],
    cwd: root,
    env: { ELECTRON_RUN_AS_NODE: "1", PI_SKIP_VERSION_CHECK: "1" },
    unsetEnv: ["PI_PACKAGE_DIR", "PI_MANAGED_INSTALL_ROOT"],
  });
  const manager = new BackgroundAgentManager({
    workspaceState: { get: () => undefined, update: async () => {} },
    extensionUri: MockUri.file(root),
  } as unknown as import("vscode").ExtensionContext);
  const start = vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(async function (this: any) {
    assert.deepEqual(this.options.executableArgs, ["/extension path/pi cli.js"]);
    assert.deepEqual(this.options.unsetEnv, [
      "PI_PACKAGE_DIR",
      "PI_MANAGED_INSTALL_ROOT",
      "PI_VSCODE_BRIDGE_PORT",
      "PI_VSCODE_BRIDGE_TOKEN",
      "PI_VSCODE_BRIDGE_EXTENSION",
      "PI_VSCODE_ANNOTATION_TOKEN",
    ]);
    const base = Object.fromEntries(this.options.unsetEnv.map((key: string) => [key, "private"]));
    const env = buildPiProcessEnvironment(base, this.options.env, this.options.unsetEnv);
    assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(env.PI_SKIP_VERSION_CHECK, "1");
    for (const key of this.options.unsetEnv) assert.equal(env[key], undefined);
    assert.equal(this.options.extensions, undefined);
  });
  vi.spyOn(PiRpcClient.prototype, "setSessionName").mockResolvedValue(undefined);
  vi.spyOn(PiRpcClient.prototype, "prompt").mockResolvedValue(undefined);
  vi.spyOn(PiRpcClient.prototype, "stop").mockResolvedValue(undefined);
  try {
    await manager.start("runtime fixture", [], [], root, false);
    assert.equal(start.mock.calls.length, 1);
  } finally {
    manager.dispose();
    await vi.waitFor(() => assert.equal(hasOperation(root), false));
    read.mockRestore();
    vi.restoreAllMocks();
    vscode.restore();
    await rm(root, { recursive: true, force: true });
  }
});

for (const isolated of [false, true]) {
  test(`missing packaged runtime fails the background task and retains prepared worktree (${isolated})`, async () => {
    const vscode = installVscodeMock();
    const { BackgroundAgentManager } = require("../backgroundAgents") as typeof import("../backgroundAgents");
    const vscodePi = require("../vscodePi") as typeof import("../vscodePi");
    const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-background-missing-runtime-")));
    const manager = new BackgroundAgentManager({
      workspaceState: { get: () => undefined, update: async () => {} },
      extensionUri: MockUri.file(root),
    } as unknown as import("vscode").ExtensionContext);
    const start = vi.spyOn(PiRpcClient.prototype, "start");
    vscodePi.initializePiRuntime(root);
    if (isolated) (manager as any).createWorktree = async () => ({ worktreePath: root, origin: {} });
    try {
      await assert.rejects(manager.start("missing runtime", [], [], root, isolated), /Packaged Pi/);
      assert.equal(manager.states[0]?.status, "failed");
      assert.equal(start.mock.calls.length, 0);
      assert.equal(hasOperation(root), false);
      if (isolated) assert.equal(manager.states[0]?.worktreePath, root);
      assert.equal((await stat(root)).isDirectory(), true);
    } finally {
      start.mockRestore();
      manager.dispose();
      vscodePi.initializePiRuntime(process.cwd());
      vscode.restore();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("background manager preserves launch order, acceptance, cancellation and failure cleanup", async () => {
  const vscode = installVscodeMock();
  const { BackgroundAgentManager } = require("../backgroundAgents") as typeof import("../backgroundAgents");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-background-launch-")));
  vscode.workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "executablePath" ? "pi" : fallback),
  });
  try {
    for (const mode of ["accepted", "startup-rejected", "naming-rejected", "prompt-rejected", "cancelled"] as const) {
      const manager = new BackgroundAgentManager({
        workspaceState: { get: () => undefined, update: async () => {} },
        extensionUri: MockUri.file(root),
      } as unknown as import("vscode").ExtensionContext);
      const started = deferred();
      const allowStart = deferred();
      const named = deferred();
      const allowName = deferred();
      const prompted = deferred();
      const allowPrompt = deferred();
      const order: string[] = [];
      const failure = new Error(mode);
      let disposed = 0;
      let settled = false;
      vi.spyOn(PiRpcClient.prototype, "onEvent").mockReturnValue({ dispose: () => disposed++ });
      vi.spyOn(PiRpcClient.prototype, "processId", "get").mockReturnValue(12345);
      vi.spyOn(PiRpcClient.prototype, "start").mockImplementation(async () => {
        order.push("start");
        started.resolve();
        await allowStart.promise;
        if (mode === "startup-rejected") throw failure;
      });
      vi.spyOn(PiRpcClient.prototype, "setSessionName").mockImplementation(async (title) => {
        assert.equal(title, "launch fixture");
        assert.equal(manager.states[0]?.processId, 12345);
        order.push("name");
        named.resolve();
        await allowName.promise;
        if (mode === "naming-rejected") throw failure;
      });
      const prompt = vi.spyOn(PiRpcClient.prototype, "prompt").mockImplementation(async () => {
        order.push("prompt");
        prompted.resolve();
        await allowPrompt.promise;
        if (mode === "prompt-rejected") throw failure;
        return undefined;
      });
      vi.spyOn(PiRpcClient.prototype, "clearQueue").mockImplementation(async () => {
        order.push("clear");
        return { steering: [], followUp: [] };
      });
      vi.spyOn(PiRpcClient.prototype, "abort").mockImplementation(async () => {
        order.push("abort");
      });
      const stop = vi.spyOn(PiRpcClient.prototype, "stop").mockImplementation(async () => {
        assert.equal(hasOperation(root), true, "the operation lock remains held until client cleanup finishes");
      });
      try {
        const launch = manager.start("launch fixture", [], [], root, false).finally(() => {
          settled = true;
        });
        const rejected =
          mode === "accepted"
            ? undefined
            : assert.rejects(launch, mode === "cancelled" ? /cancelled before submission/ : failure);
        await started.promise;
        assert.deepEqual(order, ["start"]);
        assert.equal(settled, false);
        assert.equal(manager.states[0]?.status, "starting");
        assert.equal(hasOperation(root), true);
        allowStart.resolve();
        if (mode !== "startup-rejected") {
          await named.promise;
          assert.deepEqual(order, ["start", "name"]);
          assert.equal(prompt.mock.calls.length, 0);
          if (mode === "cancelled") {
            const task = manager.states[0];
            assert.ok(task);
            await manager.cancel(task.id);
            assert.deepEqual(order, ["start", "name", "clear", "abort"]);
          }
          allowName.resolve();
          if (mode === "accepted" || mode === "prompt-rejected") {
            await prompted.promise;
            assert.deepEqual(order, ["start", "name", "prompt"]);
            assert.equal(settled, false, "launch waits for prompt acceptance");
            allowPrompt.resolve();
          }
        }
        if (mode === "accepted") {
          const id = await launch;
          assert.equal(manager.states[0]?.id, id);
          assert.equal(manager.states[0]?.status, "running", "launch does not wait for task settlement");
          assert.equal(hasOperation(root), true);
          assert.equal(disposed, 0);
          assert.equal(stop.mock.calls.length, 0);
        } else {
          await rejected;
          assert.equal(manager.states[0]?.status, mode === "cancelled" ? "cancelled" : "failed");
          assert.equal(disposed, 1);
          assert.equal(stop.mock.calls.length, 1);
          assert.equal(hasOperation(root), false);
          assert.equal(prompt.mock.calls.length, mode === "prompt-rejected" ? 1 : 0);
        }
      } finally {
        allowStart.resolve();
        allowName.resolve();
        allowPrompt.resolve();
        manager.dispose();
        await vi.waitFor(() => assert.equal(hasOperation(root), false));
        vi.restoreAllMocks();
      }
    }
  } finally {
    vscode.restore();
    await rm(root, { recursive: true, force: true });
  }
});
