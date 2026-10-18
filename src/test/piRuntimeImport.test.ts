import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import type { PiRpcClient, PiRpcEvent } from "../piRpcClient";
import type { PiRuntimeManager, PiRuntimeState } from "../piRuntime";
import { installVscodeMock } from "./vscodeMock";

const mock = installVscodeMock();
afterAll(() => mock.restore());

for (const outcome of ["success", "cancelled", "switch-failed", "refresh-failed", "wrong-session"] as const) {
  test(`import activation ${outcome} stays in captured ownership and reconciles without replay`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "pi-runtime-import-"));
    const target = path.join(root, "import.jsonl");
    await writeFile(target, `${JSON.stringify({ type: "session", cwd: root })}\n`);
    mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(root) }];
    const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
    const runtime = new PiRuntimeManager({
      workspaceState: { update: async () => {} },
      environmentVariableCollection: { clear() {} },
    } as unknown as vscode.ExtensionContext);
    const internal = runtime as unknown as {
      client: PiRpcClient;
      state: PiRuntimeState;
      owned<T>(action: () => Promise<T>): Promise<T>;
      refreshState: (catalog: boolean, strict?: boolean) => Promise<void>;
    };
    const events: PiRpcEvent[] = [];
    runtime.onEvent((event) => events.push(event));
    const order: string[] = [];
    let switches = 0;
    let running = true;
    const client = {
      get isRunning() {
        return running;
      },
      switchSession: async () => {
        switches++;
        order.push("switch");
        assert.equal(events.at(-1)?.type, "extension_ui_reset", "old dialogs must reset before switch");
        if (outcome === "switch-failed") throw new Error("fixture failure");
        return { cancelled: outcome === "cancelled" };
      },
      onEvent: () => ({ dispose() {} }),
      stop: async () => {
        running = false;
      },
    } as unknown as PiRpcClient;
    internal.client = client;
    internal.state = {
      ...runtime.currentState,
      sessionId: "old",
      sessionFile: path.join(root, "old.jsonl"),
      connected: true,
    };
    internal.refreshState = async (_catalog, strict) => {
      order.push(strict ? "refresh-strict" : "refresh-recovery");
      if (outcome === "refresh-failed" && strict) throw new Error("catalog failure");
      if (outcome !== "cancelled" && outcome !== "switch-failed")
        internal.state = {
          ...internal.state,
          sessionId: "imported",
          sessionFile: outcome === "wrong-session" ? "wrong.jsonl" : target,
        };
    };
    try {
      await assert.rejects(runtime.activateImportedSession(client, target), /no longer owns/);
      const action = () => internal.owned(() => runtime.activateImportedSession(client, target));
      if (outcome === "success") {
        await action();
        assert.equal(events.at(-1)?.type, "session_imported");
        assert.deepEqual(order, ["switch", "refresh-strict"]);
      } else {
        await assert.rejects(action());
        assert.ok(!events.some((event) => event.type === "session_imported"));
        assert.equal(order.at(-1), "refresh-recovery");
      }
      assert.equal(switches, 1, "uncertain or cancelled activation must not be replayed");
      assert.equal(runtime.currentState.busy, false, "operation ownership must be released");
    } finally {
      runtime.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
}

test("history from a replaced client cannot be applied to the current session", async () => {
  const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
  const runtime = new PiRuntimeManager({
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
  const internal = runtime as unknown as { client: PiRpcClient | undefined; ensureStarted(): Promise<void> };
  internal.ensureStarted = async () => {};
  const oldClient = {
    isRunning: true,
    getMessages: async () => {
      internal.client = undefined;
      return [{ role: "user", content: "old private data" }];
    },
  } as unknown as PiRpcClient;
  internal.client = oldClient;
  try {
    await assert.rejects(runtime.getMessages(), /expired client or session/);
  } finally {
    runtime.dispose();
  }
});
