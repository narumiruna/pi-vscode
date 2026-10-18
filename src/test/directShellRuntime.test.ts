import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { shellExecutionDeadlineMs, shellPolicyTitle } from "../directShell";
import { acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-shell-runtime-"));
  const extensionRoot = path.join(root, "extension");
  await mkdir(path.join(extensionRoot, "resources"), { recursive: true });
  await Promise.all(
    ["pi-permission-gate.ts", "pi-read-only-gate.ts"].map((name) =>
      writeFile(path.join(extensionRoot, "resources", name), "// fixture policy identity"),
    ),
  );
  const folder = { uri: MockUri.file(root) };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.isTrusted = true;
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.window.showWarningMessage = async () => "Run Shell";
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
      name: "vscode-pi-permission-ready",
      description: "VS Code direct-shell policy; Pi 1.3.0",
      source: "extension",
      sourceInfo: { path: path.join(extensionRoot, "resources", "pi-permission-gate.ts") },
    },
    {
      name: "vscode-pi-read-only-ready",
      description: "VS Code read-only direct-shell policy v1",
      source: "extension",
      sourceInfo: { path: path.join(extensionRoot, "resources", "pi-read-only-gate.ts") },
    },
  ];
  let executions = 0;
  const client: any = {
    isRunning: true,
    getCommands: async () => descriptors,
    getState: async () => ({ sessionId: "fixture-session" }),
    sendExtensionUiResponse: (id: string, fields: any) => responses.push({ id, ...fields }),
    bash: async (command: string, excludeFromContext: boolean, update: (value: unknown) => void) => {
      await internal.authorizeShellPolicy(
        {
          type: "extension_ui_request",
          id: "policy",
          method: "confirm",
          message: JSON.stringify({ command, cwd: root, excludeFromContext, sessionId: "fixture-session" }),
        },
        client,
      );
      if (!responses.at(-1)?.confirmed) throw new Error("Fixture policy denied");
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

test("every direct shell has full host approval independent of tool mode, with canonical operation and foreground ownership", async () => {
  await fixture(async (f) => {
    let approvals = 0;
    vscode.window.showWarningMessage = async (message: string, options: any, label: string) => {
      approvals++;
      assert.match(message, /printf harmless/);
      assert.ok(message.includes(f.root));
      assert.match(message, /remain in Pi history/);
      assert.equal(options.modal, true);
      assert.equal(label, "Run Shell");
      assert.equal(f.runtime.currentState.busy, true);
      assert.equal(f.runtime.currentState.queueable, false);
      assert.equal(hasOperation(f.root), true);
      await assert.rejects(f.runtime.prompt("conflict"), /current Pi request|session operation/);
      await assert.rejects(f.runtime.newSession(), /current Pi request|session operation/);
      assert.throws(() => acquireOperation(f.root, "Apply/import/restore"), /direct shell/);
      await assert.rejects(f.runtime.queueInstruction("steer", "conflict"), /Only an active ordinary/);
      return "Run Shell";
    };
    for (const exclude of [false, true])
      assert.deepEqual(await f.runtime.executeShell("printf harmless", exclude), f.result);
    assert.equal(approvals, 2);
    assert.equal(f.executions(), 2);
    assert.equal(hasOperation(f.root), false);
    assert.equal(f.runtime.currentState.busy, false);
    assert.equal(f.internal.shellActive, undefined);
  });
});

test("rejected/stale approval and unsupported policy discovery run no shell", async () => {
  await fixture(async (f) => {
    vscode.window.showWarningMessage = async () => undefined;
    assert.equal(await f.runtime.executeShell("printf harmless", false), undefined);
    assert.equal(f.executions(), 0);
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
      vscode.window.showWarningMessage = async () => {
        mutate();
        return "Run Shell";
      };
      await assert.rejects(f.runtime.executeShell("printf harmless", false), /origin|trusted|policy|workspace/i);
      assert.equal(f.executions(), 0);
      assert.equal(hasOperation(f.root), false);
    }
    vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
    f.internal.client = f.client;
    f.internal.state.sessionId = "fixture-session";
    vscode.window.showWarningMessage = async () => assert.fail("Unsupported runtime must not offer execution");
    f.descriptors[0].description = "VS Code direct-shell policy; Pi 1.2.0";
    await assert.rejects(f.runtime.executeShell("printf harmless", false), /verified Pi 1.3.0/);
    assert.equal(f.executions(), 0);
  });
});

test("policy discovery rejects duplicates and foreign sources, but accepts canonical packaged aliases", async () => {
  await fixture(async (f) => {
    f.descriptors.push({ ...f.descriptors[0] });
    await assert.rejects(f.runtime.executeShell("printf harmless", false), /verified Pi 1.3.0/);
    f.descriptors.pop();
    const original = f.descriptors[0].sourceInfo.path;
    f.descriptors[0].sourceInfo.path = f.descriptors[1].sourceInfo.path;
    await assert.rejects(f.runtime.executeShell("printf harmless", false), /verified Pi 1.3.0/);
    f.descriptors[0].sourceInfo.path = original;
    if (process.platform !== "win32") {
      const alias = path.join(f.root, "permission-alias.ts");
      await symlink(original, alias);
      f.descriptors[0].sourceInfo.path = alias;
      assert.deepEqual(await f.runtime.executeShell("printf harmless", false), f.result);
    }
  });
});

test("wrong origin and replayed user_bash approval requests fail closed", async () => {
  await fixture(async (f) => {
    const event = {
      type: "extension_ui_request",
      id: "wrong-origin",
      method: "confirm",
      message: JSON.stringify({
        command: "printf harmless",
        cwd: f.root,
        excludeFromContext: false,
        sessionId: "fixture-session",
      }),
    };
    await f.internal.authorizeShellPolicy(event, f.client);
    assert.equal(f.responses.at(-1).confirmed, false, "no active command");
    f.client.bash = async () => {
      for (const message of [
        "x".repeat(40_001),
        JSON.stringify({
          command: "printf harmless",
          cwd: f.root,
          excludeFromContext: false,
          sessionId: "fixture-session",
          extra: "rejected",
        }),
      ]) {
        await f.internal.authorizeShellPolicy({ ...event, message }, f.client);
        assert.equal(f.responses.at(-1).confirmed, false);
      }
      for (const [key, value] of [
        ["command", "wrong"],
        ["sessionId", "wrong"],
        ["cwd", tmpdir()],
        ["excludeFromContext", true],
      ]) {
        const payload = {
          command: "printf harmless",
          cwd: f.root,
          excludeFromContext: false,
          sessionId: "fixture-session",
          [key as string]: value,
        };
        await f.internal.authorizeShellPolicy({ ...event, message: JSON.stringify(payload) }, f.client);
        assert.equal(f.responses.at(-1).confirmed, false);
        f.internal.shellActive.consumed = false;
      }
      await f.internal.authorizeShellPolicy(event, { ...f.client });
      assert.equal(f.responses.at(-1).confirmed, false);
      await f.internal.authorizeShellPolicy(event, f.client);
      assert.equal(f.responses.at(-1).confirmed, true);
      await f.internal.authorizeShellPolicy(event, f.client);
      assert.equal(f.responses.at(-1).confirmed, false, "approval is one-shot");
      return f.result;
    };
    await f.runtime.executeShell("printf harmless", false);
    assert.equal(shellPolicyTitle, "PI_VSCODE_DIRECT_SHELL_V1");
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
      await assert.rejects(f.runtime.executeShell("printf harmless", false));
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
    const execution = f.runtime.executeShell("printf harmless", false);
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
      f.client.isRunning = false;
      finish(Promise.reject(new Error("disconnected")));
    };
    const failed = f.runtime.executeShell("printf harmless", false);
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
    const execution = f.runtime.executeShell("printf harmless", false);
    void execution.catch(() => {});
    await ready;
    await vi.advanceTimersByTimeAsync(shellExecutionDeadlineMs + 1);
    await assert.rejects(execution, /execution deadline/);
    assert.equal(aborts, 1);
    assert.equal(hasOperation(f.root), false);
  });
});

test("Stop during modal approval preserves the draft and executes no command", async () => {
  await fixture(async (f) => {
    vscode.window.showWarningMessage = async () => {
      await f.runtime.abort();
      return "Run Shell";
    };
    assert.equal(await f.runtime.executeShell("printf harmless", false), undefined);
    assert.equal(f.executions(), 0);
    assert.equal(hasOperation(f.root), false);
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
    const execution = f.runtime.executeShell("printf harmless", false);
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
    await f.runtime.executeShell("printf harmless", false, undefined, async () => {
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
    await assert.rejects(f.runtime.executeShell("printf harmless", false), /session changed|session is busy or changed/);
    assert.equal(hasOperation(f.root), false);
    assert.equal(f.events.at(-1).state, "uncertain");
  });
});

test("canonical workspace aliases retain their binding and a replaced alias rejects approval", async () => {
  if (process.platform === "win32") return;
  await fixture(async (f) => {
    const alias = `${f.root}-alias`;
    await symlink(f.root, alias, "dir");
    try {
      f.folder.uri = MockUri.file(alias);
      f.internal.control.clientStarted();
      assert.deepEqual(await f.runtime.executeShell("printf harmless", false), f.result);
      vscode.window.showWarningMessage = async () => {
        await rm(alias);
        await symlink(tmpdir(), alias, "dir");
        return "Run Shell";
      };
      await assert.rejects(f.runtime.executeShell("printf harmless", false), /origin|workspace|directory/i);
      assert.equal(f.executions(), 1);
    } finally {
      await rm(alias, { force: true });
    }
  });
});
