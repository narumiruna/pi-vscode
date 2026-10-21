import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellExecutionDeadlineMs } from "../directShell";
import { acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-shell-runtime-")));
  const extensionRoot = path.join(root, "extension");
  await mkdir(path.join(extensionRoot, "resources"), { recursive: true });
  await writeFile(path.join(extensionRoot, "resources", "pi-read-only-gate.ts"), "// fixture policy identity");
  const folder = { uri: MockUri.file(root) };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.isTrusted = true;
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.window.showWarningMessage = async () => assert.fail("Direct shell must not request host confirmation");
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(extensionRoot),
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: { clear() {} },
  } as any);
  const internal = runtime as any;
  const responses: any[] = [];
  const events: any[] = [];
  runtime.onEvent((event) => events.push(event));
  const result = { output: "fixture output", exitCode: 0, cancelled: false, truncated: false };
  const descriptors = [
    {
      name: "vscode-pi-read-only-ready",
      description: "VS Code read-only direct-shell policy v1; Pi 1.3.0",
      source: "extension",
      sourceInfo: { path: path.join(extensionRoot, "resources", "pi-read-only-gate.ts") },
    },
  ];
  let executions = 0;
  const client: any = {
    isRunning: true,
    onEvent: () => ({ dispose() {} }),
    getCommands: async () => descriptors,
    getState: async () => ({ sessionId: "fixture-session" }),
    sendExtensionUiResponse: (id: string, fields: any) => responses.push({ id, ...fields }),
    bash: async (_command: string, _excludeFromContext: boolean, update: (value: unknown) => void) => {
      executions++;
      update(result);
      return result;
    },
    abortBash: async () => {},
    stop: async () => {
      client.isRunning = false;
    },
  };
  internal.client = client;
  internal.state = { ...runtime.currentState, connected: true, sessionId: "fixture-session", busy: false };
  internal.control.clientStarted();
  internal.refreshStateAfterCommand = async () => {};
  try {
    await action({
      root,
      folder,
      runtime,
      internal,
      client,
      result,
      responses,
      events,
      descriptors,
      executions: () => executions,
    });
  } finally {
    vi.useRealTimers();
    internal.client = undefined;
    runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

test("direct shell is available before the first model turn writes a session file", async () => {
  await fixture(async (f) => {
    f.internal.state.sessionFile = path.join(f.root, "assigned-but-unsaved.jsonl");
    f.client.getState = async () => ({ sessionId: "fixture-session", sessionFile: f.internal.state.sessionFile });
    assert.deepEqual(await f.runtime.executeBash("printf harmless", false), f.result);
    assert.equal(f.executions(), 1);
  });
});

test("direct shell dispatches without host confirmation and retains locks while bash is pending", async () => {
  await fixture(async (f) => {
    const bash = f.client.bash;
    for (const exclude of [false, true]) {
      let ready!: () => void;
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      f.client.bash = async (command: string, excludeFromContext: boolean, update: (value: unknown) => void) => {
        assert.equal(command, "printf harmless");
        assert.equal(excludeFromContext, exclude);
        ready();
        await pending;
        return bash(command, excludeFromContext, update);
      };
      let accepted = 0;
      const execution = f.runtime.executeBash("printf harmless", exclude, () => accepted++);
      await started;
      assert.equal(accepted, 1);
      assert.equal(f.runtime.currentState.busy, true);
      assert.equal(f.runtime.currentState.queueable, false);
      assert.equal(hasOperation(f.root), true);
      await assert.rejects(f.runtime.prompt("conflict"), /current Pi request|session operation/);
      await assert.rejects(f.runtime.newSession(), /current Pi request|session operation/);
      await assert.rejects(f.runtime.executeBash("conflict", false), /current Pi request|session operation/);
      assert.throws(() => acquireOperation(f.root, "Apply/import/restore"), /direct shell/);
      await assert.rejects(f.runtime.queueInstruction("steer", "conflict"), /Only an active ordinary/);
      finish();
      assert.deepEqual(await execution, f.result);
    }
    assert.deepEqual(f.responses, [], "No shell authorization handshake is sent");
    assert.equal(f.executions(), 2);
    assert.equal(hasOperation(f.root), false);
    assert.equal(f.runtime.currentState.busy, false);
    assert.equal(f.internal.shellActive, undefined);
  });
});

test("origin changes during asynchronous command discovery run no shell", async () => {
  await fixture(async (f) => {
    for (const mutate of [
      () => {
        vscode.workspace.isTrusted = false;
      },
      () => {
        f.internal.state = { ...f.internal.state, sessionId: "replacement" };
      },
      () => {
        f.internal.client = { ...f.client };
      },
      () => {
        vscode.workspace.getConfiguration = () => ({
          get: (key: string, fallback: unknown) => (key === "approveProjectResources" ? true : fallback),
        });
      },
    ]) {
      vscode.workspace.isTrusted = true;
      vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
      f.internal.client = f.client;
      f.internal.state.sessionId = "fixture-session";
      f.client.getCommands = async () => {
        await Promise.resolve();
        mutate();
        return f.descriptors;
      };
      let accepted = false;
      await assert.rejects(
        f.runtime.executeBash("printf harmless", false, () => {
          accepted = true;
        }),
        /origin|trusted|policy|workspace/i,
      );
      assert.equal(accepted, false);
      assert.equal(f.executions(), 0);
      assert.equal(hasOperation(f.root), false);
    }
  });
});

test("read-only discovery rejects duplicate, missing, incompatible and foreign metadata without executing", async () => {
  await fixture(async (f) => {
    const descriptor = f.descriptors[0];
    const foreign = path.join(f.root, "foreign-policy.ts");
    await writeFile(foreign, "// foreign policy");
    for (const descriptors of [
      [],
      [descriptor, { ...descriptor }],
      [{ ...descriptor, description: "VS Code read-only direct-shell policy v1" }],
      [{ ...descriptor, description: "VS Code read-only direct-shell policy v1; Pi 1.2.0" }],
      [{ ...descriptor, description: "VS Code read-only direct-shell policy v1; Pi unknown" }],
      [{ ...descriptor, source: "prompt" }],
      [{ ...descriptor, sourceInfo: undefined }],
      [{ ...descriptor, sourceInfo: {} }],
      [{ ...descriptor, sourceInfo: { path: foreign } }],
      [{ ...descriptor, sourceInfo: { path: path.join(f.root, "missing.ts") } }],
      [{ ...descriptor, name: "vscode-pi-permission-ready" }],
    ]) {
      f.client.getCommands = async () => descriptors;
      await assert.rejects(f.runtime.executeBash("printf harmless", false), /verified Pi 1.3.0/);
      assert.equal(f.executions(), 0);
      assert.equal(hasOperation(f.root), false);
    }
    f.client.getCommands = async () => [descriptor];
    assert.deepEqual(await f.runtime.executeBash("printf harmless", false), f.result);
    assert.equal(f.executions(), 1, "Only the read-only sentinel is required");
    if (process.platform !== "win32") {
      const alias = path.join(f.root, "read-only-alias.ts");
      await symlink(descriptor.sourceInfo.path, alias);
      f.client.getCommands = async () => [{ ...descriptor, sourceInfo: { path: alias } }];
      assert.deepEqual(await f.runtime.executeBash("printf harmless", false), f.result);
      assert.equal(f.executions(), 2);
    }
  });
});

test("origin changes during final asynchronous validation prevent dispatch", async () => {
  await fixture(async (f) => {
    let discovered = false;
    f.client.getCommands = async () => {
      discovered = true;
      return f.descriptors;
    };
    f.client.getState = async () => {
      await Promise.resolve();
      if (discovered) f.internal.state.sessionId = "replacement";
      return { sessionId: "fixture-session" };
    };
    await assert.rejects(f.runtime.executeBash("printf harmless", false), /origin|session.*changed/i);
    assert.equal(f.executions(), 0);
    assert.equal(hasOperation(f.root), false);
  });
});

test("pending dialogs/queues, terminal ownership, trust, virtual workspaces and shared mutation locks reject direct shell", async () => {
  await fixture(async (f) => {
    for (const state of ["dialog", "queue", "terminal", "trust", "virtual", "lock"]) {
      let release = () => {};
      if (state === "dialog") {
        f.internal.handleEvent({ type: "extension_ui_request", method: "confirm", id: "dialog", message: "Fixture" });
        assert.equal(f.runtime.hasPendingExtensionDialogs, true);
      }
      if (state === "queue") f.internal.state.queue = { steering: ["pending"], followUp: [] };
      if (state === "terminal") f.internal.control.terminal = { root: f.root, release() {} };
      if (state === "trust") vscode.workspace.isTrusted = false;
      if (state === "virtual") f.folder.uri = { scheme: "virtual" };
      if (state === "lock") release = acquireOperation(f.root, "Apply/import/restore");
      await assert.rejects(f.runtime.executeBash("printf harmless", false));
      release();
      f.runtime.invalidateExtensionDialogs();
      f.internal.state.queue = undefined;
      f.internal.control.terminal = undefined;
      vscode.workspace.isTrusted = true;
      f.folder.uri = MockUri.file(f.root);
    }
    assert.equal(f.executions(), 0);
  });
});

test("shell-specific Stop waits for final result; failed abort disconnects without replay and reports descendant uncertainty", async () => {
  await fixture(async (f) => {
    let finish!: (value: unknown) => void;
    let ready!: () => void;
    let started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.client.bash = () =>
      new Promise((resolve) => {
        finish = resolve;
        ready();
      });
    let aborts = 0;
    f.client.abortBash = async () => {
      aborts++;
      finish({ ...f.result, cancelled: true });
    };
    const execution = f.runtime.executeBash("printf harmless", false);
    await started;
    await f.runtime.abort();
    assert.equal((await execution)?.cancelled, true);
    assert.equal(aborts, 1);
    assert.ok(
      f.events.some((event: any) => event.warningCode === "cleanup-unverified" && /Windows/.test(event.message)),
    );
    started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    f.client.abortBash = async () => {
      throw new Error("fixture abort failure");
    };
    f.client.stop = async () => {
      if (!f.client.isRunning) return;
      f.client.isRunning = false;
      finish(Promise.reject(new Error("disconnected")));
    };
    const failed = f.runtime.executeBash("printf harmless", false);
    void failed.catch(() => {});
    await started;
    await assert.rejects(f.runtime.abort(), /fixture abort failure/);
    await assert.rejects(failed, /Do not repeat|disconnected/);
    assert.equal(f.client.isRunning, false);
    assert.equal(hasOperation(f.root), false);
  });
});

test("execution deadline requests abort, requires final settlement and never replays", async () => {
  await fixture(async (f) => {
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    let finish!: (value: unknown) => void;
    f.client.bash = () =>
      new Promise((resolve) => {
        finish = resolve;
        started();
      });
    let aborts = 0;
    f.client.abortBash = async () => {
      aborts++;
      finish({ ...f.result, cancelled: true });
    };
    vi.useFakeTimers();
    const execution = f.runtime.executeBash("printf harmless", false);
    void execution.catch(() => {});
    await ready;
    await vi.advanceTimersByTimeAsync(shellExecutionDeadlineMs + 1);
    await assert.rejects(execution, /execution deadline/);
    assert.equal(aborts, 1);
    assert.equal(hasOperation(f.root), false);
  });
});

test("Stop during final asynchronous validation keeps the submission unaccepted and runs no command", async () => {
  await fixture(async (f) => {
    let stopped = false;
    let accepted = false;
    f.client.getState = async () => {
      if (f.internal.shellActive) {
        await f.runtime.abort();
        stopped = true;
      }
      return { sessionId: "fixture-session" };
    };
    await assert.rejects(
      f.runtime.executeBash("printf harmless", false, () => {
        accepted = true;
      }),
      /origin|stale|cancel/i,
    );
    assert.equal(stopped, true);
    assert.equal(accepted, false);
    assert.equal(f.executions(), 0);
    assert.equal(hasOperation(f.root), false);
    assert.equal(f.internal.shellActive, undefined);
  });
});

test("abort acknowledgement without a final result disconnects with bounded cleanup uncertainty", async () => {
  await fixture(async (f) => {
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    let rejectExecution!: (reason: Error) => void;
    f.client.bash = () =>
      new Promise((_resolve, reject) => {
        rejectExecution = reject;
        ready();
      });
    f.client.stop = async () => {
      f.client.isRunning = false;
      rejectExecution(new Error("fixture disconnected"));
    };
    vi.useFakeTimers();
    const execution = f.runtime.executeBash("printf harmless", false);
    void execution.catch(() => {});
    await started;
    const stopping = f.runtime.abort();
    void stopping.catch(() => {});
    await vi.advanceTimersByTimeAsync(5_001);
    await assert.rejects(stopping, /did not settle/);
    await assert.rejects(execution, /Do not repeat|fixture disconnected/);
    assert.equal(f.client.isRunning, false);
    assert.ok(f.events.some((event: any) => event.warningCode === "cleanup-unverified"));
    assert.equal(hasOperation(f.root), false);
  });
});

test("history replacement stays inside the canonical owner and final session identity changes are rejected", async () => {
  await fixture(async (f) => {
    f.client.getMessages = async () => [];
    let delivered = false;
    await f.runtime.executeBash("printf harmless", false, undefined, async () => {
      assert.equal(hasOperation(f.root), true);
      assert.equal(f.runtime.currentState.busy, true);
      delivered = true;
    });
    assert.equal(delivered, true);
    const execute = f.client.bash;
    f.client.bash = async (...args: unknown[]) => {
      const result = await execute(...args);
      f.client.getState = async () => ({ sessionId: "replacement" });
      return result;
    };
    await assert.rejects(f.runtime.executeBash("printf harmless", false), /session changed|session is busy or changed/);
    assert.equal(hasOperation(f.root), false);
    assert.equal(f.events.at(-1).state, "uncertain");
    assert.equal(f.client.isRunning, false);
    assert.equal(f.internal.client, undefined, "uncertain actual session cannot receive another prompt");
    assert.equal(f.runtime.currentState.connected, false);
    f.internal.ensureStarted = async () => {};
    await assert.rejects(f.runtime.prompt("must not enter the replaced session"), /not running/);
  });
});

test("canonical workspace aliases retain their binding and replacement during discovery prevents dispatch", async () => {
  if (process.platform === "win32") return;
  await fixture(async (f) => {
    const alias = `${f.root}-alias`;
    await symlink(f.root, alias, "dir");
    try {
      f.folder.uri = MockUri.file(alias);
      f.internal.control.clientStarted();
      assert.deepEqual(await f.runtime.executeBash("printf harmless", false), f.result);
      f.client.getCommands = async () => {
        await rm(alias);
        await symlink(tmpdir(), alias, "dir");
        return f.descriptors;
      };
      await assert.rejects(f.runtime.executeBash("printf harmless", false), /origin|workspace|directory/i);
      assert.equal(f.executions(), 1);
    } finally {
      await rm(alias, { force: true });
    }
  });
});
