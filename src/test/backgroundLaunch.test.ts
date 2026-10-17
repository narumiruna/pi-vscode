import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
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

test("background manager preserves launch order, acceptance, cancellation and failure cleanup", async () => {
  const vscode = installVscodeMock();
  const { BackgroundAgentManager } = require("../backgroundAgents") as typeof import("../backgroundAgents");
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-background-launch-")));
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
