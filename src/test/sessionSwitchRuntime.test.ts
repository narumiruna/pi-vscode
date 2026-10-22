import assert from "node:assert/strict";
import { mkdtemp, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
afterAll(() => mock.restore());

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-session-switch-")));
  const source = path.join(root, "source.jsonl");
  const target = path.join(root, "target.jsonl");
  const header = (id: string, cwd = root) => `${JSON.stringify({ type: "session", id, cwd })}\n`;
  await writeFile(source, header("source-id"));
  await writeFile(target, header("target-id"));
  const folder = { uri: MockUri.file(root) };
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.isTrusted = true;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  const writes: unknown[] = [];
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: {
      get: () => undefined,
      update: async (_key: string, value: unknown) => {
        writes.push(value);
      },
    },
    environmentVariableCollection: { clear() {} },
  } as any);
  const internal = runtime as any;
  const events: any[] = [];
  runtime.onEvent((event) => events.push(event));
  let switches = 0;
  let stops = 0;
  const actual: any = { sessionFile: source, sessionId: "source-id" };
  const client: any = {
    isRunning: true,
    onEvent: () => ({ dispose() {} }),
    getState: async () => ({ ...actual }),
    getSessionStats: async () => ({}),
    getAvailableModels: async () => [],
    getAvailableThinkingLevels: async () => [],
    getCommands: async () => [],
    switchSession: async (destination: string) => {
      switches++;
      assert.equal(destination, target);
      assert.equal(hasOperation(root), true, "RPC dispatch must hold the canonical workspace gate");
      assert.equal(events.at(-1)?.type, "extension_ui_reset", "Pi can emit fresh UI during the switch RPC");
      actual.sessionFile = target;
      actual.sessionId = "target-id";
      return {};
    },
    stop: async () => {
      stops++;
      client.isRunning = false;
    },
  };
  internal.client = client;
  internal.state = {
    ...internal.state,
    connected: true,
    sessionFile: source,
    sessionId: "source-id",
    recoveredDrafts: [{ id: "retained", text: "unsent draft", uncertain: false }],
  };
  internal.control.clientStarted();
  try {
    await action({
      runtime,
      internal,
      client,
      actual,
      root,
      source,
      target,
      folder,
      header,
      events,
      writes,
      switches: () => switches,
      stops: () => stops,
    });
  } finally {
    internal.client = undefined;
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function assertRejectedUnchanged(f: any): void {
  assert.equal(f.switches(), 0);
  assert.equal(f.runtime.currentState.sessionFile, f.source);
  assert.equal(f.runtime.currentState.sessionId, "source-id");
  assert.equal(f.runtime.currentState.connected, true);
  assert.deepEqual(f.events, [], "pre-dispatch rejection must not reset extension UI");
  assert.deepEqual(f.writes, []);
  assert.equal(hasOperation(f.root), false);
}

test("session switching owns the canonical workspace gate through RPC and authoritative refresh", async () => {
  await fixture(async (f) => {
    const switchSession = f.client.switchSession;
    f.client.switchSession = async (destination: string) => {
      assert.equal(f.runtime.currentState.busy, true);
      await assert.rejects(f.runtime.switchSession(f.target), /current Pi request|session operation/);
      await assert.rejects(f.runtime.prompt("conflict"), /current Pi request|session operation/);
      await assert.rejects(f.runtime.executeBash("conflict", false), /current Pi request|session operation/);
      for (const operation of ["Apply", "import", "checkpoint restore", "direct shell", "terminal handoff"])
        assert.throws(() => acquireOperation(f.root, operation), /switching session/);
      return switchSession(destination);
    };
    f.client.getCommands = async () => {
      assert.equal(hasOperation(f.root), true, "the gate must also cover post-RPC state refresh");
      return [];
    };
    await f.runtime.switchSession(f.target);
    assert.equal(f.switches(), 1);
    assert.equal(f.stops(), 0);
    assert.equal(f.runtime.currentState.sessionFile, f.target);
    assert.equal(f.runtime.currentState.sessionId, "target-id");
    assert.equal(f.runtime.currentState.connected, true);
    assert.equal(f.runtime.currentState.busy, false);
    assert.deepEqual(f.writes, [f.target]);
    assert.equal(hasOperation(f.root), false);
  });
});

test("session switching keeps the launch workspace when the runtime resource is untitled", async () => {
  await fixture(async (f) => {
    f.internal.resource = new MockUri("untitled", "/Untitled-1");
    mock.workspace.getWorkspaceFolder = () => undefined;
    await f.runtime.switchSession(f.target, "target-id");
    assert.equal(f.switches(), 1);
    assert.equal(f.runtime.currentState.sessionId, "target-id");
  });
});

for (const operation of ["Apply", "import", "checkpoint restore", "direct shell"]) {
  test(`session switch cannot overlap a canonical ${operation} operation`, async () => {
    await fixture(async (f) => {
      const release = acquireOperation(f.root, operation);
      try {
        await assert.rejects(f.runtime.switchSession(f.target), new RegExp(operation));
        assert.equal(f.switches(), 0);
        assert.deepEqual(f.events, []);
      } finally {
        release();
      }
      assertRejectedUnchanged(f);
    });
  });
}

for (const conflict of ["busy", "steering", "followUp", "pending", "awaiting", "queue-operation", "dialog"]) {
  test(`session switch rejects ${conflict} without clearing session state`, async () => {
    await fixture(async (f) => {
      let release: (() => void) | undefined;
      if (conflict === "busy") f.internal.state.busy = true;
      if (conflict === "steering" || conflict === "followUp")
        f.internal.state.queue = { steering: [], followUp: [], [conflict]: ["queued instruction"] };
      if (conflict === "pending") f.internal.state.pendingQueue = { steering: [{ id: "pending" }], followUp: [] };
      if (conflict === "awaiting") f.internal.awaitingQueueStarts.push({ id: "awaiting" });
      if (conflict === "queue-operation") release = f.internal.queueGate.acquire();
      if (conflict === "dialog") Object.defineProperty(f.runtime, "hasPendingExtensionDialogs", { get: () => true });
      const before = { ...f.internal.state };
      try {
        await assert.rejects(f.runtime.switchSession(f.target), /foreground work|queues|dialogs/);
        assert.deepEqual(f.internal.state, before);
        assertRejectedUnchanged(f);
      } finally {
        release?.();
      }
    });
  });
}

for (const conflict of ["streaming", "compacting", "remote-queue", "actual-session"]) {
  test(`session switch checks authoritative ${conflict} before dispatch`, async () => {
    await fixture(async (f) => {
      if (conflict === "streaming") f.actual.isStreaming = true;
      if (conflict === "compacting") f.actual.isCompacting = true;
      if (conflict === "remote-queue") f.actual.pendingMessageCount = 1;
      if (conflict === "actual-session") f.actual.sessionId = "another-id";
      await assert.rejects(f.runtime.switchSession(f.target), /actual session is busy or changed/);
      assertRejectedUnchanged(f);
    });
  });
}

for (const conflict of ["trust", "virtual", "workspace", "terminal", "policy"]) {
  test(`session switch enforces ${conflict} admission`, async () => {
    await fixture(async (f) => {
      if (conflict === "trust") mock.workspace.isTrusted = false;
      if (conflict === "virtual") f.folder.uri = new MockUri("vscode-vfs", f.root);
      if (conflict === "workspace") mock.workspace.workspaceFolders = [{ uri: MockUri.file(process.cwd()) }];
      if (conflict === "terminal") f.internal.control.persistedOwnership = "invalid";
      if (conflict === "policy")
        mock.workspace.getConfiguration = () => ({
          get: (key: string, fallback: unknown) => (key === "approveProjectResources" ? true : fallback),
        });
      await assert.rejects(f.runtime.switchSession(f.target), /trusted|file-backed|directory|terminal|policy/);
      assert.equal(f.switches(), 0);
      assert.deepEqual(f.events, []);
      assert.equal(f.runtime.currentState.sessionFile, f.source);
      if (conflict !== "terminal") assert.equal(hasOperation(f.root), false);
    });
  });
}

for (const change of [
  "trust",
  "policy",
  "workspace",
  "client",
  "generation",
  "session",
  "dialog",
  "queue",
  "dispose",
]) {
  test(`session switch rejects stale ${change} during asynchronous origin checks`, async () => {
    await fixture(async (f) => {
      const getState = f.client.getState;
      let reads = 0;
      f.client.getState = async () => {
        const state = await getState();
        if (++reads === 2) {
          if (change === "trust") mock.workspace.isTrusted = false;
          if (change === "policy")
            mock.workspace.getConfiguration = () => ({
              get: (key: string, fallback: unknown) => (key === "approveProjectResources" ? true : fallback),
            });
          if (change === "workspace") mock.workspace.workspaceFolders = [{ uri: MockUri.file(process.cwd()) }];
          if (change === "client") f.internal.client = { ...f.client };
          if (change === "generation") f.internal.control.invalidate();
          if (change === "session") f.internal.state.sessionId = "replacement-id";
          if (change === "dialog") Object.defineProperty(f.runtime, "hasPendingExtensionDialogs", { get: () => true });
          if (change === "queue") f.internal.state.queue = { steering: ["new instruction"], followUp: [] };
          if (change === "dispose") f.runtime.dispose();
        }
        return state;
      };
      await assert.rejects(f.runtime.switchSession(f.target));
      assert.equal(f.switches(), 0);
      assert.deepEqual(f.writes, []);
      if (change !== "dispose") assert.deepEqual(f.events, []);
      assert.equal(hasOperation(f.root), false);
    });
  });
}

for (const change of ["deleted", "replaced", "foreign-workspace", "invalid-header", "missing-id"]) {
  test(`destination ${change} during final origin validation never reaches switch RPC`, async () => {
    await fixture(async (f) => {
      const getState = f.client.getState;
      let reads = 0;
      f.client.getState = async () => {
        const state = await getState();
        if (++reads === 2) {
          if (change === "deleted") await rm(f.target);
          if (change === "replaced") {
            const replacement = path.join(f.root, "replacement.jsonl");
            await writeFile(replacement, f.header("replacement-id"));
            await rename(replacement, f.target);
          }
          if (change === "foreign-workspace") await writeFile(f.target, f.header("target-id", process.cwd()));
          if (change === "invalid-header") await writeFile(f.target, "invalid\n");
          if (change === "missing-id")
            await writeFile(f.target, `${JSON.stringify({ type: "session", cwd: f.root })}\n`);
        }
        return state;
      };
      await assert.rejects(f.runtime.switchSession(f.target));
      assertRejectedUnchanged(f);
    });
  });
}

test("selected session ID rejects a same-workspace replacement before runtime admission", async () => {
  await fixture(async (f) => {
    await writeFile(f.target, f.header("replacement-id"));
    await assert.rejects(f.runtime.switchSession(f.target, "target-id"), /no longer matches the selected session/);
    assertRejectedUnchanged(f);
  });
});

test("matching selected session ID preserves the existing switch API", async () => {
  await fixture(async (f) => {
    await f.runtime.switchSession(f.target, "target-id");
    assert.equal(f.switches(), 1);
    assert.equal(f.runtime.currentState.sessionId, "target-id");
  });
});

test("symlink destinations are not accepted as saved session files", async () => {
  if (process.platform === "win32") return;
  await fixture(async (f) => {
    const alias = path.join(f.root, "alias.jsonl");
    await symlink(f.target, alias);
    await assert.rejects(f.runtime.switchSession(alias));
    assertRejectedUnchanged(f);
  });
});

test("explicit RPC cancellation preserves runtime session, queue recovery and restore identity", async () => {
  await fixture(async (f) => {
    let attempts = 0;
    f.client.switchSession = async () => {
      attempts++;
      return { cancelled: true };
    };
    const before = { ...f.internal.state };
    await assert.rejects(f.runtime.switchSession(f.target), /cancelled/);
    assert.equal(attempts, 1, "cancelled switches must not replay");
    assert.deepEqual(f.internal.state, before);
    assert.deepEqual(f.writes, []);
    assert.equal(f.stops(), 0);
    assert.deepEqual(
      f.events.map((event: any) => event.type),
      ["extension_ui_reset"],
    );
    assert.equal(hasOperation(f.root), false);
  });
});

for (const changed of [false, true]) {
  test(`lost RPC result disconnects without replay even when actual switching is ${changed}`, async () => {
    await fixture(async (f) => {
      let attempts = 0;
      f.client.switchSession = async () => {
        attempts++;
        if (changed) {
          f.actual.sessionFile = f.target;
          f.actual.sessionId = "target-id";
        }
        throw new Error("RPC timeout: result lost");
      };
      await assert.rejects(f.runtime.switchSession(f.target), /may have switched sessions.*disconnected/);
      assert.equal(attempts, 1);
      assert.equal(f.stops(), 1);
      assert.equal(f.runtime.currentState.connected, false);
      assert.equal(f.internal.client, undefined);
      assert.deepEqual(f.writes, []);
      assert.equal(hasOperation(f.root), false);
    });
  });
}

for (const failure of [
  "state",
  "catalog",
  "storage",
  "wrong-path",
  "wrong-id",
  "missing-id",
  "busy",
  "stale-refresh",
  "deleted",
  "trust",
  "policy",
  "generation",
]) {
  test(`accepted switch followed by ${failure} verification failure disconnects without replay`, async () => {
    await fixture(async (f) => {
      const switchSession = f.client.switchSession;
      f.client.switchSession = async (destination: string) => {
        const result = await switchSession(destination);
        if (failure === "state")
          f.client.getState = async () => {
            throw new Error("state failure");
          };
        if (failure === "catalog")
          f.client.getCommands = async () => {
            throw new Error("catalog failure");
          };
        if (failure === "storage")
          f.internal.context.workspaceState.update = async () => {
            throw new Error("storage failure");
          };
        if (failure === "wrong-path") f.actual.sessionFile = f.source;
        if (failure === "wrong-id") f.actual.sessionId = "foreign-id";
        if (failure === "missing-id") delete f.actual.sessionId;
        if (failure === "busy") f.actual.isStreaming = true;
        if (failure === "stale-refresh")
          f.client.getCommands = async () => {
            f.internal.refreshRevision++;
            return [];
          };
        if (failure === "deleted") await rm(f.target);
        if (failure === "trust") mock.workspace.isTrusted = false;
        if (failure === "policy")
          mock.workspace.getConfiguration = () => ({
            get: (key: string, fallback: unknown) => (key === "approveProjectResources" ? true : fallback),
          });
        if (failure === "generation") f.internal.nextClientGeneration++;
        return result;
      };
      await assert.rejects(f.runtime.switchSession(f.target), /switched sessions.*disconnected/);
      assert.equal(f.switches(), 1);
      assert.equal(f.stops(), 1);
      assert.equal(f.internal.client, undefined);
      assert.equal(f.runtime.currentState.connected, false);
      assert.equal(f.runtime.currentState.busy, false);
      assert.equal(hasOperation(f.root), false);
      assert.deepEqual(f.writes, [], "unverified target identity must not replace the restore pointer");
      assert.throws(() => f.internal.requireClient(), /not running/);
    });
  });
}

test("failed cleanup after an accepted switch still detaches the stale client", async () => {
  await fixture(async (f) => {
    f.client.getCommands = async () => {
      throw new Error("refresh failure");
    };
    f.client.stop = async () => {
      throw new Error("cleanup failure");
    };
    await assert.rejects(f.runtime.switchSession(f.target), /cleanup failure/);
    assert.equal(f.switches(), 1);
    assert.equal(f.internal.client, undefined);
    assert.equal(f.runtime.currentState.connected, false);
    assert.equal(f.runtime.currentState.busy, false);
    assert.equal(hasOperation(f.root), false);
    assert.throws(() => f.internal.requireClient(), /not running/);
  });
});
