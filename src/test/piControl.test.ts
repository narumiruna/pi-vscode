import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import type * as vscode from "vscode";
import { hasOperation } from "../operationLocks";
import { controlResultPrefix, packagedCommands, parseSessionTree, verifyPackagedCommands } from "../piControl";
import type { PiRpcClient, PiRpcEvent } from "../piRpcClient";
import type { PiRuntimeState } from "../piRuntime";
import type { PiRuntimeControl, RuntimeControlHost } from "../piRuntimeControl";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
afterAll(() => mock.restore());
const root = path.resolve(__dirname, "../..");
const resources = path.join(root, "resources");
function commands() {
  return packagedCommands.map(([name, file]) => ({
    name,
    source: "extension",
    sourceInfo: { path: path.join(resources, file) },
  }));
}
function rawTree() {
  return {
    tree: [
      {
        entry: { id: "first", parentId: null, type: "message", message: { role: "user", content: "First prompt" } },
        children: [
          {
            entry: {
              id: "answer",
              parentId: "first",
              type: "message",
              message: { role: "assistant", content: [{ type: "text", text: "Answer" }] },
            },
            children: [],
          },
          {
            entry: {
              id: "abandoned",
              parentId: "first",
              type: "message",
              message: {
                role: "user",
                content: [
                  { type: "image", data: "secret" },
                  { type: "text", text: "Alternative" },
                ],
              },
            },
            label: "Duplicate label",
            children: [],
          },
        ],
      },
    ],
    leafId: "answer" as string | null,
  };
}

async function fixture(storage = new Map<string, unknown>()) {
  const { PiRuntimeControl } = require("../piRuntimeControl") as typeof import("../piRuntimeControl");
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [{ uri: MockUri.file(root) }];
  mock.workspace.getWorkspaceFolder = () => mock.workspace.workspaceFolders[0];
  let policyChanged = false;
  mock.workspace.getConfiguration = () => ({
    get: (key: string, fallback: unknown) => (key === "approveProjectResources" ? policyChanged : fallback),
  });
  mock.window.showWarningMessage = async (_text: unknown, _options: unknown, action: string) => action;
  const events: PiRpcEvent[] = [];
  const calls: string[] = [];
  const listeners = new Set<(event: PiRpcEvent) => void>();
  const emit = (event: PiRpcEvent) => {
    for (const listener of listeners) listener(event);
  };
  let tree = parseSessionTree(rawTree());
  let catalog: unknown[] = commands();
  let disposition = "handled";
  let extensionError = false;
  let stopWarning = false;
  let pending = false;
  let refreshError = false;
  let actionCallback: (() => void) | undefined;
  let state: PiRuntimeState = {
    connected: true,
    busy: false,
    sessionId: "fixture",
    availableModels: [],
    availableThinkingLevels: [],
    commands: [],
  };
  const client = {
    isRunning: true,
    getState: async () => ({ sessionId: state.sessionId, sessionFile: state.sessionFile, isStreaming: state.busy }),
    getTree: async () => tree,
    getCommands: async () => catalog,
    onEvent: (listener: (event: PiRpcEvent) => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    prompt: async (message: string) => {
      calls.push(message);
      const payload = JSON.parse(message.slice(message.indexOf(" ") + 1));
      actionCallback?.();
      if (extensionError) emit({ type: "extension_error", error: "fixture invalid extension" });
      if (payload.action === "navigate") {
        tree = {
          ...tree,
          leafId: payload.targetId === "first" ? null : payload.targetId === "abandoned" ? "first" : payload.targetId,
        };
        emit({
          type: "extension_ui_request",
          method: "notify",
          message: `${controlResultPrefix}${JSON.stringify({ token: payload.token, cancelled: false })}`,
        });
      }
      return disposition;
    },
    fork: async (id: string) => {
      calls.push(`fork:${id}`);
      state = { ...state, sessionId: "forked" };
      return { cancelled: false, text: "Full original prompt" };
    },
    clone: async () => {
      calls.push("clone");
      state = { ...state, sessionId: "cloned" };
      return { cancelled: false };
    },
    stop: async () => {
      calls.push("stop");
      client.isRunning = false;
      if (stopWarning) emit({ type: "runtime_warning", warningCode: "cleanup-unverified" });
    },
  };
  let owned = false;
  const host: RuntimeControlHost = {
    context: {
      extensionUri: MockUri.file(root),
      workspaceState: {
        get: (key: string) => storage.get(key),
        update: async (key: string, value: unknown) => {
          if (value === undefined) storage.delete(key);
          else storage.set(key, value);
        },
      },
    } as unknown as vscode.ExtensionContext,
    get cwd() {
      return root;
    },
    resource: undefined,
    get state() {
      return state;
    },
    client: client as unknown as PiRpcClient,
    get hasPendingDialogs() {
      return pending;
    },
    queuePending: false,
    owned: async (action) => {
      if (owned) throw new Error("owned");
      owned = true;
      try {
        return await action();
      } finally {
        owned = false;
      }
    },
    start: async () => {
      calls.push("start");
    },
    startSession: async () => {
      calls.push("start-session");
      client.isRunning = true;
      (host as { client: PiRpcClient }).client = client as unknown as PiRpcClient;
    },
    stop: async () => {
      await client.stop();
      (host as { client: undefined }).client = undefined;
    },
    refresh: async () => {
      if (refreshError) throw new Error("refresh failed");
      calls.push("refresh");
    },
    emit: (event) => events.push(event),
    resetUi: () => events.push({ type: "extension_ui_reset" }),
    terminalOptions: async () => ({
      executablePath: "/pi path/pi",
      cwd: root,
      extensions: packagedCommands.map(([, file]) => path.join(resources, file)),
      approveProjectResources: false,
      sessionPath: "/session path/session.jsonl",
      env: { PI_VSCODE_PERMISSION_MODE: "all", PI_VSCODE_BRIDGE_TOKEN: "fixture-token" },
    }),
  };
  const control: PiRuntimeControl = new PiRuntimeControl(host);
  control.clientStarted();
  return {
    control,
    storage,
    host,
    client,
    calls,
    events,
    listeners,
    setPolicyChanged: () => {
      policyChanged = true;
    },
    setPending: () => {
      pending = true;
    },
    setBusy: () => {
      state = { ...state, busy: true };
    },
    setCatalog: (value: unknown[]) => {
      catalog = value;
    },
    setTree: (value: unknown) => {
      tree = parseSessionTree(value);
    },
    setDisposition: (value: string) => {
      disposition = value;
    },
    failExtension: () => {
      extensionError = true;
    },
    failRefresh: () => {
      refreshError = true;
    },
    warnOnStop: () => {
      stopWarning = true;
    },
    duringCommand: (action: () => void) => {
      actionCallback = action;
    },
  };
}

test("ordinary runtime prompts cannot invoke the reserved control namespace", async () => {
  const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
  const runtime = new PiRuntimeManager({
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
  try {
    for (const text of ["/vscode-pi-control {}", "/vscode-pi-permission-ready", " /VSCODE-PI-control {}"])
      await assert.rejects(runtime.prompt(text), /reserved/);
    assert.equal(runtime.currentState.connected, false);
  } finally {
    runtime.dispose();
  }
});

test("packaged control discovery rejects absent, duplicated, and shadowed metadata without dispatch", async () => {
  await verifyPackagedCommands(commands(), resources);
  await assert.rejects(verifyPackagedCommands([], resources), /Unsupported/);
  await assert.rejects(verifyPackagedCommands([...commands(), commands()[0]], resources), /conflicting/);
  await assert.rejects(
    verifyPackagedCommands(
      commands().map((command) => ({ ...command, source: "prompt" })),
      resources,
    ),
    /Unsupported/,
  );
  await assert.rejects(
    verifyPackagedCommands(
      commands().map((command) => ({ ...command, sourceInfo: { path: __filename } })),
      resources,
    ),
    /not owned/,
  );
});

test("bounded tree preserves entry identity, labels, images without payload retention, compaction and abandoned branches", () => {
  const parsed = parseSessionTree(rawTree());
  assert.deepEqual(
    parsed.entries.map((entry) => entry.id),
    ["first", "answer", "abandoned"],
  );
  assert.equal(parsed.entries[2]?.text, "Alternative");
  assert.equal(JSON.stringify(parsed).includes("secret"), false);
  assert.throws(() => parseSessionTree({ tree: [], leafId: "missing" }), /leaf/);
  const cycle: any = { entry: { id: "c", parentId: null, type: "compaction" }, children: [] };
  cycle.children.push(cycle);
  assert.throws(() => parseSessionTree({ tree: [cycle], leafId: "c" }), /cycle/);
  assert.throws(() => parseSessionTree({ tree: Array.from({ length: 2_001 }, () => cycle), leafId: null }), /2,000/);
  let deep: any = { entry: { id: "last", parentId: "n100", type: "compaction" }, children: [] };
  for (let i = 100; i >= 0; i--)
    deep = { entry: { id: `n${i}`, parentId: i ? `n${i - 1}` : null, type: "label" }, children: [deep] };
  assert.throws(() => parseSessionTree({ tree: [deep], leafId: "last" }), /100 levels/);
});

test("repeated reload is handled without settlement, refreshes once and releases listeners/locks", async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 3; i++) assert.equal(await f.control.reloadResources(), true);
    assert.equal(f.calls.filter((call) => call.startsWith("/vscode-pi-control ")).length, 3);
    assert.equal(f.calls.filter((call) => call === "refresh").length, 3);
    assert.equal(f.calls.includes("stop"), false);
    assert.equal(f.listeners.size, 0);
    assert.equal(hasOperation(await realpath(root)), false);
    assert.deepEqual(
      f.events.map((event) => event.type),
      Array(3).fill(["extension_ui_reset", "resources_reloaded"]).flat(),
    );
  } finally {
    f.control.dispose();
  }
});

for (const failure of ["error", "started", "refresh", "missing-policy", "timeout", "disconnect"] as const) {
  test(`reload ${failure} disconnects without replay`, async () => {
    const f = await fixture();
    if (failure === "error") f.failExtension();
    if (failure === "started") f.setDisposition("started");
    if (failure === "refresh") f.failRefresh();
    if (failure === "missing-policy") f.duringCommand(() => f.setCatalog(commands().slice(0, 1)));
    if (failure === "timeout")
      f.client.prompt = async () => {
        throw new Error("timeout");
      };
    if (failure === "disconnect")
      f.duringCommand(() => {
        (f.host as { client: undefined }).client = undefined;
      });
    try {
      await assert.rejects(f.control.reloadResources(), /uncertain.*without replay/);
      assert.equal(f.calls.filter((call) => call === "stop").length, 1);
      assert.equal(f.listeners.size, 0);
      assert.equal(hasOperation(root), false);
    } finally {
      f.control.dispose();
    }
  });
}

for (const rejection of [
  "busy",
  "dialog",
  "untrusted",
  "virtual",
  "changed-policy",
  "stale-confirmation",
  "conflict",
] as const) {
  test(`reload rejects ${rejection} before control dispatch`, async () => {
    const f = await fixture();
    if (rejection === "busy") f.setBusy();
    if (rejection === "dialog") f.setPending();
    if (rejection === "untrusted") mock.workspace.isTrusted = false;
    if (rejection === "virtual") mock.workspace.workspaceFolders = [{ uri: new MockUri("virtual", "/workspace") }];
    if (rejection === "changed-policy") f.setPolicyChanged();
    if (rejection === "stale-confirmation")
      mock.window.showWarningMessage = async () => {
        f.setPolicyChanged();
        return "Reload Resources";
      };
    if (rejection === "conflict") f.setCatalog([]);
    try {
      await assert.rejects(f.control.reloadResources());
      assert.equal(
        f.calls.some((call) => call.startsWith("/")),
        false,
      );
    } finally {
      f.control.dispose();
    }
  });
}

test("cold workspace operation does not start Pi and revalidates approval origin", async () => {
  const f = await fixture();
  await assert.rejects(
    f.control.withWorkspaceOperation("fixture", async (assertCurrent) => {
      assert.equal(hasOperation(root), true);
      f.setPolicyChanged();
      await assertCurrent();
    }),
    /origin changed/,
  );
  assert.equal(f.calls.includes("start"), false);
  assert.equal(hasOperation(root), false);
  f.control.dispose();
});

test("fork supports abandoned user entry; stale tree rejected; clone and navigation use exact IDs", async () => {
  const f = await fixture();
  try {
    const tree = await f.control.getSessionTree();
    const result = await f.control.branchSession("fork", tree.origin, "abandoned");
    assert.equal(result.text, "Full original prompt");
    await assert.rejects(f.control.branchSession("clone", tree.origin), /tree changed/);
    const next = await f.control.getSessionTree();
    await f.control.branchSession("clone", next.origin);
    const current = await f.control.getSessionTree();
    const navigated = await f.control.branchSession("navigate", current.origin, "first");
    assert.equal(navigated.text, "First prompt");
    const payload = JSON.parse(
      f.calls
        .find((call) => call.startsWith("/"))!
        .split(" ")
        .slice(1)
        .join(" "),
    );
    assert.equal(payload.action, "navigate");
    assert.equal("summarize" in payload, false);
  } finally {
    f.control.dispose();
  }
});

test("native branch selection retains ownership across dialogs and rejects changed approval", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.control.chooseSessionBranch(async () => {
        assert.equal(hasOperation(root), true);
        await assert.rejects(f.control.reloadResources(), /owned/);
        f.setPolicyChanged();
        return { action: "clone" };
      }),
      /origin changed/,
    );
    assert.equal(f.calls.includes("clone"), false);
  } finally {
    f.control.dispose();
  }
});

test("empty active branch clone is rejected before mutation without disconnect", async () => {
  const f = await fixture();
  f.setTree({ tree: [], leafId: null });
  try {
    const tree = await f.control.getSessionTree();
    await assert.rejects(f.control.branchSession("clone", tree.origin), /empty active branch/);
    assert.equal(f.calls.includes("clone"), false);
    assert.equal(f.calls.includes("stop"), false);
  } finally {
    f.control.dispose();
  }
});

test("cancelled navigation is handled without requiring a changed leaf or restoring text", async () => {
  const f = await fixture();
  f.client.prompt = async (text) => {
    const payload = JSON.parse(text.slice(text.indexOf(" ") + 1));
    for (const listener of f.listeners)
      listener({
        type: "extension_ui_request",
        method: "notify",
        message: `${controlResultPrefix}${JSON.stringify({ token: payload.token, cancelled: true })}`,
      });
    return "handled";
  };
  try {
    const tree = await f.control.getSessionTree();
    const result = await f.control.branchSession("navigate", tree.origin, "first");
    assert.equal(result.cancelled, true);
    assert.equal(result.text, undefined);
    assert.equal(f.calls.includes("stop"), false);
  } finally {
    f.control.dispose();
  }
});

test("terminal expected-origin hook rejects stale native approval before stop", async () => {
  const f = await fixture();
  let launches = 0;
  mock.window.createTerminal = () => {
    launches++;
    return { show() {} };
  };
  try {
    await assert.rejects(
      f.control.openInTerminal(async () => {
        throw new Error("native origin stale");
      }),
      /native origin stale/,
    );
    assert.equal(launches, 0);
    assert.equal(f.calls.includes("stop"), false);
  } finally {
    f.control.dispose();
  }
});

test("terminal handoff stops writer, retains canonical ownership, forwards policies and requires explicit return", async () => {
  const f = await fixture();
  let options: any;
  mock.window.createTerminal = (value: unknown) => {
    assert.equal(f.client.isRunning, false);
    options = value;
    return { show() {} };
  };
  try {
    await f.control.openInTerminal();
    assert.equal(hasOperation(root), true);
    assert.ok(options.shellArgs.includes("--no-approve"));
    assert.ok(options.shellArgs.includes("/session path/session.jsonl"));
    assert.equal(options.env.PI_VSCODE_PERMISSION_MODE, "all");
    assert.equal(options.env.PI_VSCODE_BRIDGE_TOKEN, "fixture-token");
    assert.ok(options.shellArgs.some((arg: string) => arg.endsWith("pi-read-only-gate.ts")));
    assert.throws(() => f.control.assertSidebarOwnership(), /owned by the terminal/);
    mock.window.showWarningMessage = async () => undefined;
    assert.equal(await f.control.returnFromTerminal(), false);
    assert.equal(hasOperation(root), true);
    mock.window.showWarningMessage = async () => "Return Ownership";
    assert.equal(await f.control.returnFromTerminal(), true);
    assert.equal(hasOperation(root), false);
  } finally {
    f.control.dispose();
  }
});

test("terminal ownership survives runtime disposal and blocks a reconstructed sidebar until explicit return", async () => {
  const storage = new Map<string, unknown>();
  const first = await fixture(storage);
  mock.window.createTerminal = () => ({ show() {} });
  await first.control.openInTerminal();
  assert.ok(storage.has("pi.control.externalOwnership.v1"));
  first.control.dispose();
  assert.equal(hasOperation(root), false);
  const resumed = await fixture(storage);
  try {
    await resumed.control.initializeOwnership();
    assert.equal(hasOperation(root), true);
    await assert.rejects(resumed.control.getSessionTree(), /owned by the terminal/);
    assert.equal(resumed.calls.includes("start"), false);
    mock.window.showWarningMessage = async () => "Return Ownership";
    assert.equal(await resumed.control.returnFromTerminal(), true);
    assert.equal(storage.has("pi.control.externalOwnership.v1"), false);
    assert.equal(hasOperation(root), false);
  } finally {
    resumed.control.dispose();
  }
});

test("corrupt persisted ownership fails closed and explicit clearing does not resume a guessed session", async () => {
  const storage = new Map<string, unknown>([
    ["pi.control.externalOwnership.v1", { version: 1, root: "relative", secret: "must-not-read" }],
  ]);
  const f = await fixture(storage);
  try {
    await assert.rejects(f.control.getSessionTree(), /owned by the terminal/);
    assert.equal(f.calls.includes("start"), false);
    mock.window.showWarningMessage = async () => "Return Ownership";
    assert.equal(await f.control.returnFromTerminal(), false);
    assert.equal(f.calls.includes("start-session"), false);
    assert.equal(storage.size, 0);
  } finally {
    f.control.dispose();
  }
});

test("ownership clear failure stops the replacement writer and retains the durable blocked owner", async () => {
  const storage = new Map<string, unknown>();
  const first = await fixture(storage);
  mock.window.createTerminal = () => ({ show() {} });
  await first.control.openInTerminal();
  first.control.dispose();
  const resumed = await fixture(storage);
  resumed.host.context.workspaceState.update = async (_key, value) => {
    if (value === undefined) throw new Error("clear failed");
  };
  try {
    await resumed.control.initializeOwnership();
    mock.window.showWarningMessage = async () => "Return Ownership";
    await assert.rejects(resumed.control.returnFromTerminal(), /clear failed/);
    assert.equal(resumed.client.isRunning, false);
    assert.equal(hasOperation(root), true);
    assert.ok(storage.has("pi.control.externalOwnership.v1"));
  } finally {
    resumed.control.dispose();
  }
});

test("ownership storage failure cannot stop or launch another writer", async () => {
  const f = await fixture();
  let launches = 0;
  mock.window.createTerminal = () => {
    launches++;
    return { show() {} };
  };
  f.host.context.workspaceState.update = async () => {
    throw new Error("storage unavailable");
  };
  try {
    await assert.rejects(f.control.openInTerminal(), /storage unavailable/);
    assert.equal(launches, 0);
    assert.equal(f.calls.includes("stop"), false);
    assert.equal(f.listeners.size, 0);
  } finally {
    f.control.dispose();
  }
});

test("unverified stop cannot launch terminal without separate inspection approval; retained lock survives launch failure", async () => {
  const f = await fixture();
  f.warnOnStop();
  let launches = 0;
  mock.window.createTerminal = () => {
    launches++;
    throw new Error("fixture launch failed");
  };
  mock.window.showWarningMessage = async (_text: string, _options: unknown, action: string) =>
    action === "Hand Off to Terminal" ? action : undefined;
  try {
    await f.control.openInTerminal();
    assert.equal(launches, 0);
    assert.equal(hasOperation(root), true);
  } finally {
    f.control.dispose();
  }
  const next = await fixture();
  try {
    await assert.rejects(next.control.openInTerminal(), /fixture launch failed/);
    assert.equal(hasOperation(root), true);
  } finally {
    next.control.dispose();
  }
});

test("restart rejects a stale cached session before stopping the actual writer", async () => {
  const f = await fixture();
  f.client.getState = async () => ({
    sessionId: "different",
    sessionFile: f.host.state.sessionFile,
    isStreaming: false,
  });
  try {
    await assert.rejects(f.control.restartSessionProcess(), /session changed before restart/);
    assert.equal(f.calls.includes("stop"), false);
    assert.equal(f.calls.includes("start-session"), false);
    assert.equal(hasOperation(root), false);
  } finally {
    f.control.dispose();
  }
});

test("restart explicitly accepts changed launch policy without replay and cancellation retains ownership", async () => {
  const f = await fixture();
  f.setPolicyChanged();
  try {
    assert.equal(await f.control.restartSessionProcess(), true);
    assert.deepEqual(
      f.calls.filter((call) => ["stop", "start-session", "refresh"].includes(call)),
      ["stop", "start-session", "refresh"],
    );
    assert.equal(
      f.calls.some((call) => call.startsWith("/")),
      false,
    );
    assert.equal(hasOperation(root), false);
  } finally {
    f.control.dispose();
  }
  const uncertain = await fixture();
  uncertain.warnOnStop();
  mock.window.showWarningMessage = async (_text: string, _options: unknown, action: string) =>
    action === "Restart Pi" ? action : undefined;
  try {
    assert.equal(await uncertain.control.restartSessionProcess(), false);
    assert.equal(uncertain.calls.includes("start-session"), false);
    assert.equal(hasOperation(root), true);
  } finally {
    uncertain.control.dispose();
  }
});

test("missing-control catalog race is consumed by independent input policy without model fallback", async () => {
  const source = stripTypeScriptTypes(readFileSync(path.join(resources, "pi-read-only-gate.ts"), "utf8"));
  const { default: policy } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  policy({
    registerCommand() {},
    on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(event, handler),
  });
  const f = await fixture();
  let modelCalls = 0;
  f.client.prompt = async (text) => {
    const result = handlers.get("input")!(
      { text },
      {
        ui: {
          notify: (_message: string, notifyType: string) => {
            for (const listener of f.listeners)
              listener({ type: "extension_ui_request", method: "notify", notifyType });
          },
        },
      },
    ) as { action: string } | undefined;
    if (result?.action === "handled") return "handled";
    modelCalls++;
    return "started";
  };
  try {
    await assert.rejects(f.control.reloadResources(), /uncertain/);
    assert.equal(modelCalls, 0);
    assert.ok(f.calls.includes("stop"));
  } finally {
    f.control.dispose();
  }
});

test("cancelled fork retains source identity and navigation cancellation has a handled acknowledgement", async () => {
  const f = await fixture();
  f.client.fork = async () => ({ cancelled: true, text: undefined as unknown as string });
  try {
    const tree = await f.control.getSessionTree();
    assert.equal((await f.control.branchSession("fork", tree.origin, "first")).cancelled, true);
    assert.equal(f.calls.includes("refresh"), false);
    assert.equal(f.host.state.sessionId, "fixture");
  } finally {
    f.control.dispose();
  }
});

test("packaged public command validates origin, uses no-summary navigation, and stops using reloaded context", async () => {
  const source = stripTypeScriptTypes(readFileSync(path.join(resources, "pi-control.ts"), "utf8"));
  const { default: extension } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  let handler: (args: string, ctx: any) => Promise<void> = async () => {};
  extension({
    registerCommand: (_name: string, command: any) => {
      handler = command.handler;
    },
  });
  let reloads = 0;
  let navigations = 0;
  const ctx = {
    cwd: root,
    isIdle: () => true,
    sessionManager: { getSessionId: () => "s", getLeafId: () => "leaf", getEntry: () => ({ id: "target" }) },
    reload: async () => {
      reloads++;
    },
    navigateTree: async (_target: string, options: unknown) => {
      assert.deepEqual(options, { summarize: false });
      navigations++;
      return { cancelled: true };
    },
    ui: { notify: (message: string) => assert.match(message, /"cancelled":true/) },
  };
  const payload = { action: "reload", token: "fixture", sessionId: "s", leafId: "leaf", cwd: await realpath(root) };
  await handler(JSON.stringify(payload), ctx);
  assert.equal(reloads, 1);
  await handler(JSON.stringify({ ...payload, action: "navigate", targetId: "target" }), ctx);
  assert.equal(navigations, 1);
  await assert.rejects(handler(JSON.stringify({ ...payload, sessionId: "stale" }), ctx), /Stale/);
  await assert.rejects(handler(JSON.stringify(payload), { ...ctx, reload: undefined }), /not support/);
});
