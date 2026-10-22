import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

async function flush(): Promise<void> {
  for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture(withRuntime = true) {
  const vscode = installVscodeMock();
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/tmp/settings-actions") }];
  vscode.workspace.getConfiguration = () => {
    throw new Error("Settings actions must not read or write configuration values");
  };
  const runtime = {
    currentCwd: "/tmp/settings-actions",
    clientGeneration: 1,
    currentState: { connected: true, sessionId: "session-one", sessionFile: "/private/session-one.jsonl" },
    withWorkspaceOperation: async () => {
      throw new Error("Fixture rejects native operations before reading files");
    },
    restartSessionProcess: async () => {
      throw new Error("The panel must use the guarded Sidebar command, not restart the runtime directly");
    },
  };
  const commands: unknown[][] = [];
  let execute: (...args: unknown[]) => Promise<unknown> = async () => true;
  vscode.commands.executeCommand = async (...args: unknown[]) => {
    commands.push(args);
    return execute(...args);
  };
  delete require.cache[require.resolve("../settingsPanel")];
  const { SettingsPanelController } = require("../settingsPanel") as typeof import("../settingsPanel");
  const controller = new SettingsPanelController(
    MockUri.file(process.cwd()) as unknown as import("vscode").Uri,
    withRuntime ? (runtime as unknown as import("../piRuntime").PiRuntimeManager) : undefined,
  );
  controller.show();
  const panel = vscode.panels.at(-1);
  const snapshot = () =>
    panel.webview.messages.filter((message: { type: string }) => message.type === "snapshot").at(-1);
  const result = (id: string) =>
    panel.webview.messages.find(
      (message: { type: string; id: string }) => message.type === "restartResult" && message.id === id,
    );
  return {
    vscode,
    runtime,
    controller,
    panel,
    commands,
    snapshot,
    result,
    setExecute(next: typeof execute) {
      execute = next;
    },
    async ready() {
      panel.receive({ type: "ready" });
      await flush();
      return snapshot().restartActionToken as string | undefined;
    },
    async restart(id: string, actionToken = snapshot()?.restartActionToken, extra = {}) {
      panel.receive({ type: "restartPi", id, actionToken, ...extra });
      await flush();
      return result(id);
    },
    dispose() {
      controller.dispose();
      vscode.restore();
    },
  };
}

test("configuration actions use only fixed commands and report bounded restart outcomes without applying defaults", async () => {
  const f = fixture();
  try {
    const token = await f.ready();
    assert.ok(token);
    assert.match(token, /^[a-f0-9-]{36}$/);
    assert.doesNotMatch(JSON.stringify(f.snapshot()), /session-one|private/);
    f.panel.receive({ type: "openProjectApproval" });
    await flush();
    assert.deepEqual(f.commands, [["workbench.action.openSettings", "pi.approveProjectResources"]]);
    for (const [id, outcome, status] of [
      ["cancel", false, "cancelled"],
      ["complete", true, "completed"],
      ["void", undefined, "failed"],
      ["failure", new Error("PRIVATE_ERROR /credential/path"), "failed"],
    ] as const) {
      const before = f.snapshot().restartActionToken;
      f.setExecute(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      assert.deepEqual(await f.restart(id), { type: "restartResult", id, status });
      assert.notEqual(f.snapshot().restartActionToken, before, "Each outcome renews the single-use token");
      assert.deepEqual(f.commands.at(-1), ["pi.restartResources"]);
      assert.equal(f.panel.disposed, false, "Cancellation and failure do not discard the panel");
    }
    assert.doesNotMatch(JSON.stringify(f.panel.webview.messages), /PRIVATE_ERROR|credential|applied/);
    const count = f.commands.length;
    assert.equal((await f.restart("duplicate", token)).status, "rejected");
    assert.equal(f.commands.length, count);
    // Neither passive requests nor file-save routes can dispatch restart or approval.
    for (const type of ["ready", "nativeLoad", "nativeSave", "nativeReset"])
      f.panel.receive({ type, id: `passive-${type}`, scope: "global", key: "defaultModel", value: "manual-model" });
    await flush();
    assert.equal(f.commands.length, count);
  } finally {
    f.dispose();
  }
});

test("manual provider/model fallback never projects or reads runtime model catalogs", async () => {
  const f = fixture();
  try {
    for (const availableModels of [
      [],
      [{ provider: "PRIVATE_PROVIDER", id: "PRIVATE_MODEL", apiKey: "PRIVATE_SECRET" }],
    ]) {
      Object.defineProperty(f.runtime.currentState, "availableModels", { configurable: true, value: availableModels });
      await f.ready();
      assert.deepEqual(Object.keys(f.snapshot()).sort(), ["nativeFilesAvailable", "restartActionToken", "type"]);
      assert.doesNotMatch(JSON.stringify(f.panel.webview.messages), /PRIVATE_PROVIDER|PRIVATE_MODEL|PRIVATE_SECRET/);
    }
    Object.defineProperty(f.runtime.currentState, "availableModels", {
      get() {
        throw new Error("Passive configuration must not inspect the catalog");
      },
    });
    await f.ready();
    assert.ok(f.snapshot().restartActionToken);
    assert.deepEqual(f.commands, []);
  } finally {
    f.dispose();
  }
});

test("restart outcomes replay on webview readiness without repeating the action or surviving panel disposal", async () => {
  const f = fixture();
  const held = deferred();
  try {
    await f.ready();
    f.setExecute(async () => {
      await held.promise;
      return false;
    });
    f.panel.receive({ type: "restartPi", id: "recovered-pending", actionToken: f.snapshot().restartActionToken });
    await flush();
    f.panel.receive({ type: "ready" });
    held.resolve();
    await flush();
    assert.equal(f.result("recovered-pending").status, "cancelled");
    assert.deepEqual(f.commands, [["pi.restartResources"]]);
    for (const [id, outcome, status] of [
      ["hidden-failure", new Error("PRIVATE_HIDDEN_ERROR"), "failed"],
      ["hidden-completion", true, "completed"],
    ] as const) {
      f.setExecute(async () => {
        if (outcome instanceof Error) throw outcome;
        return outcome;
      });
      assert.equal((await f.restart(id)).status, status);
      // A hidden document can miss the original post; readiness must reconcile the latest fixed result.
      f.panel.webview.messages.length = 0;
      f.panel.receive({ type: "ready" });
      await flush();
      assert.deepEqual(f.result(id), { type: "restartResult", id, status });
      assert.equal(
        f.panel.webview.messages.filter((message: { type: string }) => message.type === "restartResult").length,
        1,
      );
      assert.doesNotMatch(JSON.stringify(f.panel.webview.messages), /PRIVATE_HIDDEN_ERROR/);
    }
    assert.equal(f.commands.length, 3);
    f.panel.dispose();
    f.controller.show();
    const replacement = f.vscode.panels.at(-1);
    replacement.receive({ type: "ready" });
    await flush();
    assert.equal(
      replacement.webview.messages.some((message: { type: string }) => message.type === "restartResult"),
      false,
    );
    assert.equal(f.commands.length, 3);
  } finally {
    held.resolve();
    f.dispose();
  }
});

test("new configuration actions reject extra fields, invalid IDs, missing tokens, and unavailable workspaces", async () => {
  const f = fixture();
  try {
    const token = await f.ready();
    for (const extra of [{ command: "malicious" }, { path: "/untrusted" }, { scope: "project" }, { value: true }]) {
      f.panel.receive({ type: "openProjectApproval", ...extra });
      assert.equal((await f.restart(`invalid-${f.panel.webview.messages.length}`, token, extra)).status, "rejected");
    }
    for (const [id, actionToken] of [
      ["no-token", undefined],
      ["bad-token", 1],
      ["wrong-token", "not-host-owned"],
      ["large-token", "x".repeat(32769)],
      ["", token],
      ["a".repeat(81), token],
      ["not valid", token],
      [42, token],
    ])
      f.panel.receive({ type: "restartPi", id, actionToken });
    await flush();
    assert.equal(f.commands.length, 0);
    assert.ok(
      f.panel.webview.messages
        .filter((message: { type: string }) => message.type === "restartResult")
        .every((message: { id: string }) => message.id.length <= 80),
    );
    for (const kind of ["untrusted", "virtual", "missing"]) {
      f.vscode.workspace.isTrusted = kind !== "untrusted";
      f.vscode.workspace.workspaceFolders =
        kind === "missing"
          ? []
          : [{ uri: MockUri.from({ scheme: kind === "virtual" ? "virtual" : "file", path: "/workspace" }) }];
      f.vscode.workspaceEvents.emit("folders");
      f.panel.receive({ type: "openProjectApproval" });
      assert.equal((await f.restart(`unavailable-${kind}`, token)).status, "rejected");
      assert.equal(f.snapshot().restartActionToken, undefined);
      assert.equal(f.commands.length, 0);
    }
  } finally {
    f.dispose();
  }
  const absent = fixture(false);
  try {
    assert.equal(await absent.ready(), undefined);
    assert.equal((await absent.restart("no-runtime", "forged")).status, "rejected");
    assert.equal(absent.commands.length, 0);
  } finally {
    absent.dispose();
  }
});

test("invalid launch settings disable restart without blocking native Settings navigation or later actions", async () => {
  const f = fixture();
  try {
    const token = await f.ready();
    Object.defineProperty(f.runtime, "currentCwd", {
      configurable: true,
      get() {
        throw new Error("PRIVATE_INVALID_LAUNCH_CONFIGURATION");
      },
    });
    f.vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    assert.equal(await f.ready(), undefined);
    assert.equal((await f.restart("invalid-launch", token)).status, "rejected");
    f.panel.receive({ type: "openNative" });
    f.panel.receive({ type: "openProjectApproval" });
    await flush();
    assert.deepEqual(f.commands, [
      ["workbench.action.openSettings", "@ext:narumi.narumi-pi"],
      ["workbench.action.openSettings", "pi.approveProjectResources"],
    ]);
    assert.doesNotMatch(JSON.stringify(f.panel.webview.messages), /PRIVATE_INVALID_LAUNCH_CONFIGURATION/);
    Object.defineProperty(f.runtime, "currentCwd", { value: "/tmp/settings-actions", configurable: true });
    assert.ok(await f.ready());
    assert.equal((await f.restart("recovered-launch")).status, "completed");
  } finally {
    f.dispose();
  }
});

test("restart tokens reject observed workspace, launch configuration, environment and session replacement", async () => {
  const f = fixture();
  const oldAgent = process.env.PI_CODING_AGENT_DIR;
  try {
    await f.ready();
    const changes = [
      () => f.vscode.configurationEvents.emit("change", { affectsConfiguration: () => true }),
      () => f.vscode.workspaceEvents.emit("folders"),
      () => f.vscode.workspaceEvents.emit("trust"),
      () => {
        process.env.PI_CODING_AGENT_DIR = "/different/agent";
      },
      () => {
        f.runtime.clientGeneration++;
      },
      () => {
        f.runtime.currentState.sessionId = "session-two";
      },
      () => {
        f.runtime.currentState.sessionFile = "/different/session.jsonl";
      },
      () => {
        f.runtime.currentState.connected = false;
      },
      () => {
        f.runtime.currentCwd = "/different/workspace";
      },
      () => {
        f.vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/different/workspace") }];
      },
    ];
    for (const [index, change] of changes.entries()) {
      const token = f.snapshot().restartActionToken;
      change();
      assert.equal((await f.restart(`stale-${index}`, token)).status, "rejected");
      assert.notEqual(f.snapshot().restartActionToken, token);
    }
    assert.equal(f.commands.length, 0);
  } finally {
    if (oldAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgent;
    f.dispose();
  }
});

test("queued actions are bounded and cannot authorize after invalidation, panel replacement or disposal", async () => {
  const f = fixture();
  let held = deferred();
  try {
    const token = await f.ready();
    f.setExecute(async () => {
      await held.promise;
    });
    f.panel.receive({ type: "openNative" });
    await flush();
    f.panel.receive({ type: "openProjectApproval" });
    f.panel.receive({ type: "restartPi", id: "queued-stale", actionToken: token });
    f.vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    held.resolve();
    await flush();
    assert.equal(f.result("queued-stale").status, "rejected");
    assert.deepEqual(f.commands, [["workbench.action.openSettings", "@ext:narumi.narumi-pi"]]);

    held = deferred();
    f.panel.receive({ type: "openNative" });
    await flush();
    for (let i = 0; i < 15; i++) f.panel.receive({ type: "ready" });
    f.panel.receive({ type: "restartPi", id: "overflow", actionToken: f.snapshot().restartActionToken });
    assert.equal(f.result("overflow").status, "rejected");
    f.panel.receive({ type: "openProjectApproval" });
    held.resolve();
    await flush();
    assert.equal(f.commands.length, 2);

    held = deferred();
    f.panel.receive({ type: "openNative" });
    await flush();
    const oldToken = f.snapshot().restartActionToken;
    f.panel.receive({ type: "restartPi", id: "replaced-queue", actionToken: oldToken });
    f.panel.receive({ type: "openProjectApproval" });
    f.panel.dispose();
    const oldPosts = f.panel.webview.messages.length;
    f.controller.show();
    const second = f.vscode.panels.at(-1);
    second.receive({ type: "ready" });
    second.receive({ type: "restartPi", id: "replaced-token", actionToken: oldToken });
    held.resolve();
    await flush();
    assert.equal(f.panel.webview.messages.length, oldPosts);
    assert.equal(
      second.webview.messages.find((message: { id: string }) => message.id === "replaced-token").status,
      "rejected",
    );
    assert.equal(f.commands.length, 3);
    f.controller.dispose();
    second.receive({ type: "openProjectApproval" });
    second.receive({ type: "restartPi", id: "disposed", actionToken: oldToken });
    await flush();
    assert.equal(f.commands.length, 3);
  } finally {
    held.resolve();
    f.dispose();
  }
});

test("restart cancellation and failure retain the panel, and late results cannot reach replacement panels", async () => {
  const f = fixture();
  const held = deferred();
  try {
    await f.ready();
    f.setExecute(async () => {
      await held.promise;
      throw new Error("PRIVATE_LATE_ERROR");
    });
    f.panel.receive({ type: "restartPi", id: "late-failure", actionToken: f.snapshot().restartActionToken });
    f.panel.receive({ type: "restartPi", id: "late-duplicate", actionToken: f.snapshot().restartActionToken });
    await flush();
    assert.deepEqual(f.commands, [["pi.restartResources"]]);
    f.panel.dispose();
    const posted = f.panel.webview.messages.length;
    f.controller.show();
    const second = f.vscode.panels.at(-1);
    held.resolve();
    await flush();
    assert.equal(f.panel.webview.messages.length, posted);
    assert.deepEqual(second.webview.messages, []);
    assert.equal(f.commands.length, 1);
  } finally {
    held.resolve();
    f.dispose();
  }
});
