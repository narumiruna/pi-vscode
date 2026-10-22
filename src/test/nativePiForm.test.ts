import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { NativeScope } from "../nativePiFiles";
import {
  maxNativeProjectionBytes,
  type NativeFormEntry,
  type NativeFormSnapshot,
  type NativeFormValue,
  projectNativeMcp,
  projectNativeSettings,
} from "../nativePiFormModel";
import { mcpExposures, nativeSettingControls, nativeSettingValue } from "../nativePiModel";
import { maxSettingsMessage } from "../settingsModel";
import { installVscodeMock, MockUri } from "./vscodeMock";

const unavailable =
  "Native configuration could not be read or saved. Reload before retrying; inspect the file after a write error.";
const conflict = "Native configuration changed. Draft retained; reload this row before saving.";
const oversized = "Native configuration is unavailable or the request exceeds its limit. Reload before retrying.";
const busy = "Settings are busy. Try saving this row again.";
const canaries = [
  "CANARY_UNKNOWN_SETTING",
  "CANARY_URL_TOKEN",
  "CANARY_EXECUTABLE",
  "CANARY_ARGUMENT",
  "CANARY_ENVIRONMENT",
  "CANARY_HEADER",
  "CANARY_OAUTH",
  "CANARY_AUTH_FILE",
  "CANARY_MCP_AUTH_FILE",
  "CANARY_INVALID_VALUE",
];
const values: Record<string, NativeFormValue> = {
  defaultProvider: "offline-provider",
  defaultModel: "offline-model",
  defaultThinkingLevel: "max",
  enabledModels: ["provider/z*:high", "no-matches", "provider/a"],
  steeringMode: "all",
  followUpMode: "all",
  "compaction.enabled": false,
  "retry.enabled": false,
};
function settingObject(input: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const control of nativeSettingControls) {
    if (!(control.key in input)) continue;
    if (control.path.length === 1) result[control.path[0]!] = input[control.key];
    else result[control.path[0]!] = { [control.path[1]!]: input[control.key] };
  }
  return result;
}
function entry(snapshot: NativeFormSnapshot, key: string): NativeFormEntry {
  const result = snapshot.entries.find((item) => item.key === key);
  assert.ok(result, `Missing native field ${key}`);
  return result;
}
function assertSafe(value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const canary of canaries) assert.ok(!serialized.includes(canary), `Leaked ${canary}`);
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function eventually(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    assert.ok(Date.now() < deadline, `Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("native form projects all eight validated controls, ordered patterns, defaults and scoped inheritance", () => {
  assert.equal(nativeSettingControls.length, 8);
  const global = settingObject(values);
  global.unlisted = "CANARY_UNKNOWN_SETTING";
  const defaults = projectNativeSettings({}, {}, "global");
  assert.equal(defaults.length, 8);
  for (const control of nativeSettingControls) {
    const fallback = defaults.find((item) => item.key === control.key)!;
    assert.deepEqual(fallback, {
      key: control.key,
      inherited: control.defaultValue,
      value: control.defaultValue,
      source: "default",
      hasOverride: false,
      invalid: false,
      inheritedInvalid: false,
    });
    const own = projectNativeSettings(global, {}, "global").find((item) => item.key === control.key)!;
    assert.deepEqual(own, {
      ...fallback,
      own: values[control.key],
      value: values[control.key],
      source: "global",
      hasOverride: true,
    });
    const inherited = projectNativeSettings(global, {}, "project").find((item) => item.key === control.key)!;
    assert.deepEqual(inherited, {
      ...fallback,
      inherited: values[control.key],
      value: values[control.key],
      source: "global",
    });
    const project = settingObject({ [control.key]: control.defaultValue });
    const overridden = projectNativeSettings(global, project, "project").find((item) => item.key === control.key)!;
    assert.deepEqual(overridden, {
      ...inherited,
      own: control.defaultValue,
      value: control.defaultValue,
      source: "project",
      hasOverride: true,
    });
  }
  assertSafe(projectNativeSettings(global, {}, "project"));
});

test("native form never projects invalid existing values, including inherited and nested fields", () => {
  const invalid: Record<string, unknown[]> = {
    defaultProvider: [null, true, {}, [], "x".repeat(257), "CANARY_INVALID_VALUE\n", "a\u007fb"],
    defaultModel: [12, {}, ["CANARY_INVALID_VALUE"], "x".repeat(257), "a\0b"],
    defaultThinkingLevel: ["CANARY_INVALID_VALUE", false, 1],
    enabledModels: [null, {}, [1], [""], ["  "], ["a,b"], ["a\nb"], ["x".repeat(257)], Array(101).fill("a")],
    steeringMode: ["CANARY_INVALID_VALUE", true, []],
    followUpMode: ["CANARY_INVALID_VALUE", false, {}],
    "compaction.enabled": ["CANARY_INVALID_VALUE", null, 0, {}],
    "retry.enabled": ["CANARY_INVALID_VALUE", null, 1, []],
  };
  for (const control of nativeSettingControls) {
    for (const raw of invalid[control.key]!) {
      const broken = settingObject({ [control.key]: raw });
      const own = projectNativeSettings(broken, {}, "global").find((item) => item.key === control.key)!;
      assert.equal(own.invalid, true, `${control.key}: ${JSON.stringify(raw)}`);
      assert.equal(own.hasOverride, true);
      assert.equal("own" in own, false);
      assert.deepEqual(own.value, control.defaultValue);
      const inherited = projectNativeSettings(broken, {}, "project").find((item) => item.key === control.key)!;
      assert.equal(inherited.inheritedInvalid, true);
      assert.equal(inherited.invalid, false);
      assert.deepEqual(inherited.inherited, control.defaultValue);
      assertSafe([own, inherited]);
    }
  }
  for (const parent of [null, "CANARY_INVALID_VALUE", [], false, 0]) {
    for (const key of ["compaction", "retry"]) {
      const own = projectNativeSettings({ [key]: parent }, {}, "global").find((item) => item.key === `${key}.enabled`)!;
      assert.equal(own.invalid, true);
      assert.equal(own.hasOverride, true);
      assert.equal(own.source, "global");
      assert.equal("own" in own, false);
      assert.equal(own.value, true);
      const inherited = projectNativeSettings({ [key]: parent }, {}, "project").find(
        (item) => item.key === `${key}.enabled`,
      )!;
      assert.equal(inherited.inheritedInvalid, true);
      assert.equal(inherited.inherited, true);
      assertSafe([own, inherited]);
    }
  }
  for (const value of ["", "x".repeat(256)]) {
    const projected = projectNativeSettings({ defaultModel: value }, {}, "global")[1]!;
    assert.equal(projected.invalid, false);
    assert.equal(projected.own, value);
  }
  for (const patterns of [[], Array(100).fill("p".repeat(256))]) {
    const projected = projectNativeSettings({ enabledModels: patterns }, {}, "global")[3]!;
    assert.equal(projected.invalid, false);
    assert.deepEqual(projected.value, patterns);
  }
});

function mcpFixture() {
  return {
    unknown: "CANARY_UNKNOWN_SETTING",
    mcpServers: {
      docs: {
        url: "https://example.invalid/mcp?token=CANARY_URL_TOKEN",
        enabled: true,
        exposure: "deferred",
        headers: { Authorization: "CANARY_HEADER" },
        env: { TOKEN: "CANARY_ENVIRONMENT" },
        oauth: { clientSecret: "CANARY_OAUTH" },
        unknown: "CANARY_UNKNOWN_SETTING",
      },
      local: { command: "CANARY_EXECUTABLE", args: ["CANARY_ARGUMENT"] },
    },
  };
}

test("MCP form projects only safe metadata and enabled/exposure rows, with transport replacement inheritance", () => {
  const global = mcpFixture();
  const project = { mcpServers: { docs: { enabled: false }, projectOnly: { command: "CANARY_EXECUTABLE" } } };
  const servers = projectNativeMcp(global, project, "project");
  assert.equal(servers.length, 3);
  for (const server of servers) {
    assert.deepEqual(Object.keys(server).sort(), ["enabled", "exposure", "fields", "name", "source", "state", "type"]);
    assert.equal(server.state, "unknown");
    assert.deepEqual(
      server.fields.map((field) => field.key),
      ["enabled", "exposure"],
    );
  }
  const docs = servers.find((server) => server.name === "docs")!;
  assert.equal(docs.type, "http");
  assert.equal(docs.source, "project");
  assert.equal(docs.enabled, false);
  assert.equal(docs.exposure, "deferred");
  assert.deepEqual(docs.fields[0], {
    key: "enabled",
    own: false,
    inherited: true,
    value: false,
    source: "project",
    hasOverride: true,
    invalid: false,
    inheritedInvalid: false,
  });
  assert.deepEqual(docs.fields[1], {
    key: "exposure",
    inherited: "deferred",
    value: "deferred",
    source: "global",
    hasOverride: false,
    invalid: false,
    inheritedInvalid: false,
  });
  assert.equal(projectNativeMcp(global, project, "global").length, 2);
  const replacement = projectNativeMcp(global, { mcpServers: { docs: { command: "CANARY_EXECUTABLE" } } }, "project");
  assert.deepEqual(
    replacement[0]!.fields.map((field) => [field.inherited, field.source]),
    [
      [true, "default"],
      ["codemode", "default"],
    ],
  );
  assertSafe([servers, replacement]);
  for (const exposure of mcpExposures) {
    const projected = projectNativeMcp(global, { mcpServers: { docs: { exposure } } }, "project")[0]!;
    assert.equal(projected.fields[1]!.own, exposure);
  }
});

test("MCP form hides invalid names and raw invalid metadata; malformed and excessive server collections fail closed", () => {
  for (const [name, server] of [
    ["CANARY_INVALID_VALUE bad", { command: "CANARY_EXECUTABLE" }],
    ["constructor", { command: "CANARY_EXECUTABLE" }],
    ["docs", null],
    ["docs", { url: "CANARY_URL_TOKEN" }],
    ["docs", { command: "CANARY_EXECUTABLE", enabled: "CANARY_INVALID_VALUE" }],
    ["docs", { command: "CANARY_EXECUTABLE", exposure: "CANARY_INVALID_VALUE" }],
    ["docs", { type: "sse", url: "https://example.invalid/CANARY_URL_TOKEN" }],
  ] as const) {
    const projected = projectNativeMcp({ mcpServers: { [name]: server } }, {}, "global");
    assert.equal(projected[0]!.type, "invalid");
    assert.deepEqual(projected[0]!.fields, []);
    assertSafe(projected);
  }
  for (const mcpServers of [
    null,
    [],
    "CANARY_INVALID_VALUE",
    Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`s${i}`, {}])),
  ])
    assert.throws(() => projectNativeMcp({ mcpServers }, {}, "global"));
});

let vscode: ReturnType<typeof installVscodeMock> | undefined;
afterAll(() => vscode?.restore());

async function withHost(action: (host: Awaited<ReturnType<typeof createHost>>) => Promise<void>): Promise<void> {
  const host = await createHost();
  try {
    await action(host);
  } finally {
    await host.dispose();
  }
}
async function createHost() {
  vscode ??= installVscodeMock();
  const mock = vscode;
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-native-form-")));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  const agent = path.join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agent;
  const config = new Map<string, unknown>();
  const unexpected: string[] = [];
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [{ uri: MockUri.file(root) }];
  mock.workspace.textDocuments = [];
  mock.workspace.getConfiguration = (section: string) => {
    assert.equal(section, "pi");
    return {
      get: (key: string, fallback: unknown) => config.get(key) ?? fallback,
      inspect: (key: string) => ({ globalValue: config.get(key) }),
      update: async () => {
        unexpected.push("configuration.update");
      },
    };
  };
  mock.commands.executeCommand = async () => {
    unexpected.push("executeCommand");
  };
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const originalReadFile = fs.readFile;
  const openSpy = vi.spyOn(fs, "open");
  const readSpy = vi.spyOn(fs, "readFile");
  const childProcess = require("node:child_process") as typeof import("node:child_process");
  const preventProcess = () => {
    throw new Error("Offline fixture prohibits process launch");
  };
  const spawnSpy = vi.spyOn(childProcess, "spawn").mockImplementation(preventProcess);
  const execSpy = vi.spyOn(childProcess, "execFile").mockImplementation(preventProcess);
  const { registerSettingsPanel } = require("../settingsPanel") as typeof import("../settingsPanel");
  let held: { entered: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | undefined;
  let operationCount = 0;
  let guardCount = 0;
  let guardFailure = false;
  let guardHook: ((count: number) => Promise<void>) | undefined;
  const runtime = new Proxy(
    {
      currentCwd: root,
      withWorkspaceOperation: async (
        _label: string,
        operation: (assertCurrent: () => Promise<void>) => Promise<unknown>,
      ) => {
        operationCount++;
        const gate = held;
        held = undefined;
        if (gate) {
          gate.entered.resolve();
          await gate.release.promise;
        }
        return operation(async () => {
          guardCount++;
          if (guardHook) await guardHook(guardCount);
          if (guardFailure || !mock.workspace.isTrusted) throw new Error("CANARY_INVALID_VALUE runtime guard");
        });
      },
    },
    {
      get(target, property, receiver) {
        if (property in target) return Reflect.get(target, property, receiver);
        return () => {
          unexpected.push(`runtime.${String(property)}`);
          throw new Error("Unexpected runtime action");
        };
      },
    },
  );
  const context = { extensionUri: MockUri.file(process.cwd()), subscriptions: [] } as any;
  const controller = registerSettingsPanel(context, runtime as any);
  const panelIndex = mock.panels.length;
  controller.show();
  const panel = mock.panels.at(-1);
  let id = 0;
  const host = {
    root,
    agent,
    mock,
    panel,
    config,
    runtime,
    controller,
    readCanary(name: "auth.json" | "mcp-auth.json") {
      return originalReadFile(path.join(agent, name), "utf8");
    },
    get operations() {
      return operationCount;
    },
    get nativeReads() {
      return [...openSpy.mock.calls, ...readSpy.mock.calls].filter((call) =>
        /(?:^|[/\\])(?:settings|mcp)\.json$/.test(String(call[0])),
      ).length;
    },
    get guards() {
      return guardCount;
    },
    setGuardFailure(value: boolean) {
      guardFailure = value;
    },
    setGuardHook(hook?: (count: number) => Promise<void>) {
      guardHook = hook;
      guardCount = 0;
    },
    file(scope: NativeScope, kind: "settings" | "mcp") {
      return path.join(scope === "global" ? agent : path.join(root, ".pi"), `${kind}.json`);
    },
    async seed(scope: NativeScope, kind: "settings" | "mcp", value: unknown) {
      const file = this.file(scope, kind);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, typeof value === "string" ? value : JSON.stringify(value));
    },
    async send(message: Record<string, unknown>) {
      const request = { id: `request-${++id}`, ...message };
      panel.receive(request);
      await eventually(
        () => panel.webview.messages.some((reply: any) => reply.type === "nativeResult" && reply.id === request.id),
        `result ${request.id}`,
      );
      const result = panel.webview.messages.find(
        (reply: any) => reply.type === "nativeResult" && reply.id === request.id,
      );
      const snapshot = panel.webview.messages.find(
        (reply: any) => reply.type === "nativeSnapshot" && reply.id === request.id,
      ) as NativeFormSnapshot | undefined;
      return { result, snapshot };
    },
    async load(scope: NativeScope) {
      const response = await this.send({ type: "nativeLoad", scope });
      assert.deepEqual(response.result, { type: "nativeResult", id: response.result.id, ok: true });
      assert.ok(response.snapshot);
      assert.equal(response.snapshot.type, "nativeSnapshot");
      assert.equal(response.snapshot.scope, scope);
      assert.match(response.snapshot.revision, /^[a-f0-9]{64}$/);
      assert.match(response.snapshot.origin, /^[a-f0-9]{64}$/);
      return response.snapshot;
    },
    edit(snapshot: NativeFormSnapshot, key: string, value?: NativeFormValue, server?: string) {
      return this.send({
        type: value === undefined ? "nativeReset" : "nativeSave",
        scope: snapshot.scope,
        revision: snapshot.revision,
        key,
        ...(value !== undefined ? { value } : {}),
        ...(server ? { server } : {}),
      });
    },
    holdNext() {
      assert.equal(held, undefined);
      const gate = { entered: deferred(), release: deferred() };
      held = gate;
      return gate;
    },
    async dispose() {
      controller.dispose();
      for (const item of context.subscriptions) item.dispose();
      const filesRead = [...openSpy.mock.calls, ...readSpy.mock.calls].map((call) => String(call[0]));
      openSpy.mockRestore();
      readSpy.mockRestore();
      const spawned = spawnSpy.mock.calls.length + execSpy.mock.calls.length;
      spawnSpy.mockRestore();
      execSpy.mockRestore();
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      mock.workspace.workspaceFolders = [];
      mock.workspace.textDocuments = [];
      try {
        assert.deepEqual(
          unexpected,
          [],
          "Native form must not invoke commands, runtime controls, startup or VS Code writes",
        );
        assert.equal(spawned, 0, "Native form must not spawn Pi, discovery, authentication or MCP processes");
        assert.ok(
          !filesRead.some((file) => /(?:^|[/\\])(?:auth|mcp-auth)\.json$/.test(file)),
          "Authentication files must not be read",
        );
        for (const ownedPanel of mock.panels.slice(panelIndex)) {
          for (const message of ownedPanel.webview.messages) {
            assertSafe(message);
            if (String(message.type).startsWith("native"))
              assert.ok(
                Buffer.byteLength(JSON.stringify(message)) <= maxNativeProjectionBytes,
                "Native projection exceeds 512 KiB",
              );
          }
        }
        assertSafe(mock.outputChannels.flatMap((channel: any) => channel.records));
        assert.equal(mock.configurationEvents.listenerCount("change"), 0);
        assert.equal(mock.workspaceEvents.listenerCount("folders"), 0);
        assert.equal(mock.workspaceEvents.listenerCount("trust"), 0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  };
  return host;
}

test("native files are lazy and absent load/reset creates no directories; first saves create only their file", async () => {
  await withHost(async (host) => {
    assert.equal(host.operations, 0, "Opening Settings does not load native files");
    host.panel.receive({ type: "ready" });
    await eventually(
      () => host.panel.webview.messages.some((message: any) => message.type === "snapshot"),
      "General snapshot",
    );
    assert.equal(host.operations, 0);
    assert.equal(host.nativeReads, 0, "Unrelated categories never read native configuration files");
    for (const scope of ["global", "project"] as const) {
      let snapshot = await host.load(scope);
      assert.equal(snapshot.approved, false);
      assert.deepEqual(snapshot.servers, []);
      for (const control of nativeSettingControls) {
        assert.equal(entry(snapshot, control.key).source, "default");
        const response = await host.edit(snapshot, control.key);
        assert.equal(response.result.ok, true);
        snapshot = response.snapshot!;
      }
    }
    await assert.rejects(lstat(host.agent), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(host.root, ".pi")), { code: "ENOENT" });
    const saved = await host.edit(await host.load("project"), "defaultModel", "first-model");
    assert.equal(saved.result.ok, true);
    assert.deepEqual(JSON.parse(await readFile(host.file("project", "settings"), "utf8")), {
      defaultModel: "first-model",
    });
    await assert.rejects(lstat(host.file("project", "mcp")), { code: "ENOENT" });
    await assert.rejects(lstat(host.agent), { code: "ENOENT" });
    assert.ok(host.guards > 10);
  });
});

test("host saves and resets all eight controls at both native scopes, preserving unknown member bytes and inactive source", async () => {
  await withHost(async (host) => {
    const original =
      '{\r\n\t"unknown": { "secret": "CANARY_UNKNOWN_SETTING" },\r\n\t"compaction": { "reserveTokens": 123 },\r\n\t"retry": { "maxRetries": 7 }\r\n}\r\n';
    for (const scope of ["global", "project"] as const) await host.seed(scope, "settings", original);
    await writeFile(path.join(host.agent, "auth.json"), "CANARY_AUTH_FILE");
    await writeFile(path.join(host.agent, "mcp-auth.json"), "CANARY_MCP_AUTH_FILE");
    let global = await host.load("global");
    for (const control of nativeSettingControls) {
      const response = await host.edit(global, control.key, values[control.key]);
      assert.equal(response.result.ok, true, control.key);
      global = response.snapshot!;
      assert.deepEqual(entry(global, control.key).own, values[control.key]);
      assert.deepEqual(
        nativeSettingValue(JSON.parse(await readFile(host.file("global", "settings"), "utf8")), control),
        values[control.key],
      );
    }
    const globalBytes = await readFile(host.file("global", "settings"), "utf8");
    let project = await host.load("project");
    assert.equal(project.approved, false, "Editable project values remain inactive without approval");
    for (const control of nativeSettingControls) {
      assert.equal(entry(project, control.key).source, "global");
      assert.deepEqual(entry(project, control.key).inherited, values[control.key]);
      const response = await host.edit(project, control.key, control.defaultValue as NativeFormValue);
      assert.equal(response.result.ok, true, control.key);
      project = response.snapshot!;
      assert.equal(entry(project, control.key).source, "project");
      assert.deepEqual(entry(project, control.key).own, control.defaultValue);
      assert.equal(project.approved, false);
    }
    for (const control of nativeSettingControls) {
      const response = await host.edit(project, control.key);
      assert.equal(response.result.ok, true);
      project = response.snapshot!;
      assert.equal(entry(project, control.key).hasOverride, false);
      assert.equal(entry(project, control.key).source, "global");
      assert.deepEqual(entry(project, control.key).value, values[control.key]);
    }
    assert.equal(await readFile(host.file("global", "settings"), "utf8"), globalBytes);
    global = await host.load("global");
    for (const control of nativeSettingControls) {
      const response = await host.edit(global, control.key);
      assert.equal(response.result.ok, true);
      global = response.snapshot!;
      assert.equal(entry(global, control.key).source, "default");
    }
    for (const scope of ["global", "project"] as const) {
      const text = await readFile(host.file(scope, "settings"), "utf8");
      assert.ok(text.includes('"unknown": { "secret": "CANARY_UNKNOWN_SETTING" }'));
      assert.ok(text.includes('"reserveTokens": 123'));
      assert.ok(text.includes('"maxRetries": 7'));
      assert.ok(text.includes("\r\n"));
      await assert.rejects(lstat(host.file(scope, "mcp")), { code: "ENOENT" });
    }
    assert.equal(await host.readCanary("auth.json"), "CANARY_AUTH_FILE");
    assert.equal(await host.readCanary("mcp-auth.json"), "CANARY_MCP_AUTH_FILE");
  });
});

test("host MCP metadata edits preserve inherited transports and secrets; last reset removes a metadata-only server", async () => {
  await withHost(async (host) => {
    const globalBytes = `${JSON.stringify(mcpFixture(), null, 2)}\n`;
    await host.seed("global", "mcp", globalBytes);
    let snapshot = await host.load("project");
    assert.equal(snapshot.approved, false);
    assert.equal(snapshot.servers[0]!.type, "http");
    assert.equal((await host.edit(snapshot, "enabled", undefined, "docs")).result.ok, true);
    await assert.rejects(lstat(path.join(host.root, ".pi")), { code: "ENOENT" });
    const disabled = await host.edit(snapshot, "enabled", false, "docs");
    assert.equal(disabled.result.ok, true);
    snapshot = disabled.snapshot!;
    assert.deepEqual(JSON.parse(await readFile(host.file("project", "mcp"), "utf8")), {
      mcpServers: { docs: { enabled: false } },
    });
    await assert.rejects(lstat(host.file("project", "settings")), { code: "ENOENT" });
    assert.equal(snapshot.servers[0]!.type, "http");
    assert.equal(snapshot.servers[0]!.source, "project");
    for (const exposure of mcpExposures) {
      const saved = await host.edit(snapshot, "exposure", exposure, "docs");
      assert.equal(saved.result.ok, true);
      snapshot = saved.snapshot!;
      assert.equal(snapshot.servers[0]!.exposure, exposure);
    }
    snapshot = (await host.edit(snapshot, "enabled", undefined, "docs")).snapshot!;
    assert.deepEqual(JSON.parse(await readFile(host.file("project", "mcp"), "utf8")), {
      mcpServers: { docs: { exposure: "codemode-deferred" } },
    });
    snapshot = (await host.edit(snapshot, "exposure", undefined, "docs")).snapshot!;
    assert.deepEqual(JSON.parse(await readFile(host.file("project", "mcp"), "utf8")), { mcpServers: {} });
    assert.equal(snapshot.servers[0]!.source, "global");
    assert.equal(snapshot.servers[0]!.exposure, "deferred");
    assert.equal(await readFile(host.file("global", "mcp"), "utf8"), globalBytes);
    snapshot = await host.load("global");
    snapshot = (await host.edit(snapshot, "enabled", false, "docs")).snapshot!;
    snapshot = (await host.edit(snapshot, "exposure", "hidden", "docs")).snapshot!;
    snapshot = (await host.edit(snapshot, "enabled", undefined, "docs")).snapshot!;
    snapshot = (await host.edit(snapshot, "exposure", undefined, "docs")).snapshot!;
    assert.equal(snapshot.servers[0]!.enabled, true);
    const expected = mcpFixture();
    delete (expected.mcpServers.docs as any).enabled;
    delete (expected.mcpServers.docs as any).exposure;
    assert.deepEqual(JSON.parse(await readFile(host.file("global", "mcp"), "utf8")), expected);
    const finalBytes = await readFile(host.file("global", "mcp"), "utf8");
    for (const secret of canaries.slice(0, 7)) assert.ok(finalBytes.includes(secret));
  });
});

test("host projects invalid existing native rows without raw canaries and permits explicit repair", async () => {
  await withHost(async (host) => {
    const invalidValues = Object.fromEntries(
      nativeSettingControls.map((control) => [
        control.key,
        control.key === "defaultProvider" || control.key === "defaultModel"
          ? "CANARY_INVALID_VALUE\n"
          : "CANARY_INVALID_VALUE",
      ]),
    );
    for (const scope of ["global", "project"] as const)
      await host.seed(scope, "settings", { ...settingObject(invalidValues), unknown: "CANARY_UNKNOWN_SETTING" });
    for (const scope of ["global", "project"] as const) {
      let snapshot = await host.load(scope);
      for (const control of nativeSettingControls) {
        const projected = entry(snapshot, control.key);
        assert.equal(projected.invalid, true);
        assert.equal("own" in projected, false);
        assert.equal(projected.inheritedInvalid, scope === "project");
        assert.deepEqual(projected.value, control.defaultValue);
      }
      for (const control of nativeSettingControls) {
        const response = await host.edit(snapshot, control.key, values[control.key]);
        assert.equal(response.result.ok, true);
        snapshot = response.snapshot!;
        assert.equal(entry(snapshot, control.key).invalid, false);
      }
      // Retain invalid inheritance for the next scope without projecting its raw value.
      if (scope === "global") await host.seed("global", "settings", settingObject(invalidValues));
    }
  });
});

test("host rejects forged fields, scopes, revisions, values and server edits with fixed safe errors", async () => {
  await withHost(async (host) => {
    await host.seed("global", "settings", settingObject(values));
    await host.seed("global", "mcp", mcpFixture());
    const snapshot = await host.load("global");
    const before = await readFile(host.file("global", "settings"), "utf8");
    const mcpBefore = await readFile(host.file("global", "mcp"), "utf8");
    const base = {
      type: "nativeSave",
      scope: "global",
      revision: snapshot.revision,
      key: "defaultModel",
      value: "replacement",
    };
    for (const extra of [
      { scope: "workspace" },
      { scope: "user" },
      { scope: null },
      { key: "unknown" },
      { key: "compaction" },
      { key: "__proto__" },
      { key: ["defaultModel"] },
      { path: "/CANARY_INVALID_VALUE" },
      { command: "CANARY_EXECUTABLE" },
      { target: "user" },
      { fields: {} },
      { value: { defaultModel: "CANARY_INVALID_VALUE" } },
      { value: null },
      { value: 1 },
      { value: "a\0b" },
      { value: "a\nb" },
      { value: "x".repeat(257) },
      { key: "defaultThinkingLevel", value: "CANARY_INVALID_VALUE" },
      { key: "steeringMode", value: "off" },
      { key: "followUpMode", value: false },
      { key: "compaction.enabled", value: "false" },
      { key: "retry.enabled", value: 0 },
      { key: "enabledModels", value: ["a,b"] },
      { key: "enabledModels", value: Array(101).fill("a") },
      { key: "enabledModels", value: [""] },
      { key: "enabledModels", value: [1] },
      { value: undefined },
      { server: null },
      { server: {} },
      { server: "missing", key: "enabled", value: false },
      { server: "../docs", key: "enabled", value: false },
      { server: "docs", key: "url", value: "https://example.invalid/CANARY_URL_TOKEN" },
      { server: "docs", key: "enabled", value: "false" },
      { server: "docs", key: "exposure", value: "CANARY_INVALID_VALUE" },
      { type: "nativeReset", value: "unexpected" },
      { type: "nativeReset", server: "docs", key: "env", value: undefined },
    ]) {
      const response = await host.send({ ...base, ...extra });
      assert.equal(response.result.ok, false, JSON.stringify(extra));
      assert.equal(response.result.error, unavailable);
      assert.equal(response.snapshot, undefined);
    }
    await host.load("project");
    for (const extra of [{ revision: "forged" }, { revision: 1 }, { scope: "project" }]) {
      const response = await host.send({ ...base, ...extra });
      assert.equal(response.result.ok, false);
      assert.equal(response.result.error, conflict);
    }
    for (const extra of [{ scope: "user" }, { path: host.root }, { revision: snapshot.revision }])
      assert.equal((await host.send({ type: "nativeLoad", scope: "global", ...extra })).result.error, unavailable);
    for (const type of ["nativeLoad", "nativeSave", "nativeReset"]) {
      const operations = host.operations;
      const oversizedReply = await host.send({ ...base, type, value: "漢".repeat(12_000) });
      assert.equal(oversizedReply.result.error, oversized);
      assert.equal(host.operations, operations, "Messages above 32 KiB never enter the workspace operation gate");
    }
    assert.equal((await host.send({ type: "nativeLoad", scope: "global", id: "a".repeat(80) })).result.ok, true);
    assert.equal(await readFile(host.file("global", "settings"), "utf8"), before);
    assert.equal(await readFile(host.file("global", "mcp"), "utf8"), mcpBefore);
    const messages = host.panel.webview.messages.length;
    for (const invalid of [
      null,
      [],
      "bad",
      { type: "nativeLoad", id: "invalid!", scope: "global" },
      { type: "nativeSave", id: "a".repeat(81) },
    ])
      host.panel.receive(invalid);
    host.panel.receive({ type: "ready" });
    await eventually(() => host.panel.webview.messages.length > messages, "invalid message drain");
    assert.equal(
      host.panel.webview.messages.slice(messages).filter((reply: any) => String(reply.type).startsWith("native"))
        .length,
      0,
    );
  });
});

test("host rejects stale target and inheritance revisions across both scopes and native files", async () => {
  await withHost(async (host) => {
    for (const scope of ["global", "project"] as const) {
      for (const changedScope of ["global", "project"] as const) {
        for (const kind of ["settings", "mcp"] as const) {
          for (const target of ["global", "project"] as const) {
            await host.seed(target, "settings", { defaultModel: "baseline" });
            await host.seed(target, "mcp", mcpFixture());
          }
          const snapshot = await host.load(scope);
          const changed = kind === "settings" ? { defaultModel: "external" } : { mcpServers: {} };
          await host.seed(changedScope, kind, changed);
          const response = await host.edit(snapshot, "defaultModel", "must-not-write");
          assert.equal(response.result.ok, false);
          assert.equal(response.result.error, conflict);
          assert.deepEqual(JSON.parse(await readFile(host.file(changedScope, kind), "utf8")), changed);
        }
      }
    }
  });
});

test("host binds snapshots to agent environment, canonical directory, workspace, approval and runtime origin", async () => {
  await withHost(async (host) => {
    await host.seed("global", "settings", { defaultModel: "baseline" });
    const original = await readFile(host.file("global", "settings"), "utf8");
    const other = path.join(host.root, "other");
    await mkdir(other);
    for (const change of ["environment", "workspace", "approval", "runtime", "trust", "virtual", "missing"] as const) {
      process.env.PI_CODING_AGENT_DIR = host.agent;
      host.mock.workspace.isTrusted = true;
      host.mock.workspace.workspaceFolders = [{ uri: MockUri.file(host.root) }];
      host.config.set("approveProjectResources", false);
      host.runtime.currentCwd = host.root;
      const snapshot = await host.load("global");
      if (change === "environment") process.env.PI_CODING_AGENT_DIR = other;
      if (change === "workspace") host.mock.workspace.workspaceFolders = [{ uri: MockUri.file(other) }];
      if (change === "approval") host.config.set("approveProjectResources", true);
      if (change === "runtime") host.runtime.currentCwd = other;
      if (change === "trust") host.mock.workspace.isTrusted = false;
      if (change === "virtual")
        host.mock.workspace.workspaceFolders = [{ uri: MockUri.from({ scheme: "virtual", path: host.root }) }];
      if (change === "missing") host.mock.workspace.workspaceFolders = [];
      const response = await host.edit(snapshot, "defaultModel", "must-not-write");
      assert.equal(response.result.ok, false, change);
      assert.ok([conflict, unavailable].includes(response.result.error));
      assert.equal(await readFile(host.file("global", "settings"), "utf8"), original);
    }
    host.mock.workspace.workspaceFolders = [{ uri: MockUri.file(host.root) }];
    host.mock.workspace.isTrusted = true;
    host.runtime.currentCwd = host.root;
    const snapshot = await host.load("global");
    host.mock.configurationEvents.emit("change", { affectsConfiguration: () => true });
    assert.equal(
      host.panel.webview.messages.some((reply: any) => reply.type === "nativeInvalidated"),
      true,
    );
    assert.equal((await host.edit(snapshot, "defaultModel", "must-not-write")).result.error, conflict);
    const refreshed = await host.load("global");
    host.mock.workspaceEvents.emit("folders");
    assert.equal((await host.edit(refreshed, "defaultModel", "must-not-write")).result.error, conflict);
  });
});

test("host refuses dirty, version-changed and missing target buffers without shadow writes", async () => {
  await withHost(async (host) => {
    for (const kind of ["settings", "mcp"] as const) {
      await host.seed("global", "settings", { defaultModel: "baseline" });
      await host.seed("global", "mcp", mcpFixture());
      const file = host.file("global", kind);
      const original = await readFile(file, "utf8");
      const document = { uri: MockUri.file(file), version: 1, isDirty: true };
      host.mock.workspace.textDocuments = [document];
      assert.equal((await host.send({ type: "nativeLoad", scope: "global" })).result.error, unavailable);
      document.isDirty = false;
      const snapshot = await host.load("global");
      document.version++;
      const response = await host.edit(snapshot, "defaultModel", "must-not-write");
      assert.equal(response.result.error, unavailable);
      host.mock.workspace.textDocuments = [];
      assert.equal(
        (await host.edit(snapshot, "defaultModel", "must-not-write")).result.error,
        unavailable,
        "Closing a changed captured editor does not bypass its version guard",
      );
      assert.equal(await readFile(file, "utf8"), original);
    }
    host.mock.workspace.textDocuments = [
      { uri: MockUri.file(host.file("project", "settings")), version: 1, isDirty: true },
    ];
    assert.equal((await host.send({ type: "nativeLoad", scope: "project" })).result.error, unavailable);
    await assert.rejects(lstat(path.join(host.root, ".pi")), { code: "ENOENT" });
    host.mock.workspace.textDocuments = [
      { uri: MockUri.file(path.join(host.root, "unrelated/missing.txt")), version: 1, isDirty: true },
    ];
    assert.equal((await host.edit(await host.load("project"), "defaultModel", "safe")).result.ok, true);
  });
});

test("host keeps parser, link, permissions and unsafe-file errors fixed and secret-free", async () => {
  await withHost(async (host) => {
    for (const raw of ['{"defaultModel":"CANARY_INVALID_VALUE",', '{"x":1,"x":2}', "[]", "x".repeat(128 * 1024 + 1)]) {
      await host.seed("global", "settings", raw);
      const response = await host.send({ type: "nativeLoad", scope: "global" });
      assert.equal(response.result.error, unavailable);
      assert.equal(response.snapshot, undefined);
    }
    await host.seed("global", "settings", { defaultModel: "baseline" });
    const snapshot = await host.load("global");
    await chmod(host.file("global", "settings"), 0o444);
    try {
      assert.equal((await host.edit(snapshot, "defaultModel", "must-not-write")).result.error, unavailable);
      assert.equal(JSON.parse(await readFile(host.file("global", "settings"), "utf8")).defaultModel, "baseline");
    } finally {
      await chmod(host.file("global", "settings"), 0o600);
    }
    await rm(host.file("global", "settings"));
    await writeFile(path.join(host.root, "outside.json"), '{"secret":"CANARY_UNKNOWN_SETTING"}');
    await symlink(path.join(host.root, "outside.json"), host.file("global", "settings"));
    assert.equal((await host.send({ type: "nativeLoad", scope: "global" })).result.error, unavailable);
  });
});

test("bounded native projections retain valid large ordered patterns and MCP collections", async () => {
  await withHost(async (host) => {
    assert.equal(maxNativeProjectionBytes, 512 * 1024);
    assert.equal(maxSettingsMessage, 32 * 1024);
    const patterns = Array(100).fill("漢".repeat(256));
    for (const scope of ["global", "project"] as const) {
      await host.seed(scope, "settings", { enabledModels: patterns });
      await host.seed(scope, "mcp", {
        mcpServers: Object.fromEntries(
          Array.from({ length: 100 }, (_, i) => [`${scope}-${i}-${"a".repeat(100)}`, { command: "CANARY_EXECUTABLE" }]),
        ),
      });
    }
    for (const scope of ["global", "project"] as const) {
      const snapshot = await host.load(scope);
      assert.deepEqual(entry(snapshot, "enabledModels").own, patterns);
      assert.equal(snapshot.servers.length, scope === "global" ? 100 : 200);
      assert.ok(Buffer.byteLength(JSON.stringify(snapshot)) <= maxNativeProjectionBytes);
    }
    const project = await host.load("project");
    assert.deepEqual(entry(project, "enabledModels").inherited, patterns);
    assert.equal(
      (await host.edit(project, "enabledModels", patterns)).result.error,
      oversized,
      "A valid existing large value can be read without bypassing the inbound message limit",
    );
  });
});

test("host queue overflow returns bounded native write results and recovers after a held operation", async () => {
  await withHost(async (host) => {
    const snapshot = await host.load("global");
    const gate = host.holdNext();
    const held = host.edit(snapshot, "defaultModel", "accepted");
    await gate.entered.promise;
    for (let i = 0; i < 15; i++) host.panel.receive({ type: "ready" });
    const operations = host.operations;
    for (const type of ["nativeSave", "nativeReset", "nativeLoad"]) {
      const response = await host.send({
        type,
        scope: "global",
        revision: snapshot.revision,
        key: "defaultModel",
        value: "not-written",
        payload: "CANARY_INVALID_VALUE",
      });
      assert.equal(response.result.ok, false);
      assert.equal(response.result.error, busy);
      assert.equal(response.snapshot, undefined);
      assert.deepEqual(Object.keys(response.result).sort(), ["error", "id", "ok", "type"]);
    }
    assert.equal(host.operations, operations, "Overflow never reaches the runtime gate");
    gate.release.resolve();
    assert.equal((await held).result.ok, true);
    assert.equal((await host.edit(await host.load("global"), "defaultModel", "after-overflow")).result.ok, true);
  });
});

test("superseded native loads, invalidated origins and disposed panels never post late snapshots or write", async () => {
  await withHost(async (host) => {
    const gate = host.holdNext();
    host.panel.receive({ type: "nativeLoad", id: "old-load", scope: "global" });
    await gate.entered.promise;
    host.panel.receive({ type: "nativeLoad", id: "new-load", scope: "project" });
    gate.release.resolve();
    await eventually(
      () => host.panel.webview.messages.some((reply: any) => reply.id === "new-load" && reply.type === "nativeResult"),
      "replacement load",
    );
    assert.equal(
      host.panel.webview.messages.some((reply: any) => reply.id === "old-load"),
      false,
    );
    const snapshot = await host.load("global");
    host.setGuardFailure(true);
    assert.equal((await host.edit(snapshot, "defaultModel", "must-not-write")).result.error, unavailable);
    host.setGuardFailure(false);
    const saving = host.holdNext();
    host.panel.receive({
      type: "nativeSave",
      id: "disposed-save",
      scope: "global",
      revision: snapshot.revision,
      key: "defaultModel",
      value: "must-not-write",
    });
    await saving.entered.promise;
    host.controller.dispose();
    const messages = host.panel.webview.messages.length;
    saving.release.resolve();
    // The queue is host-owned, so its completion is deterministic without a timing sleep.
    await (host.controller as any).queue;
    assert.equal(host.panel.webview.messages.length, messages);
    await assert.rejects(lstat(host.agent), { code: "ENOENT" });
    host.controller.show();
    assert.equal(host.mock.panels.at(-1), host.panel, "Disposed controller cannot reopen its panel");
  });
});

test("canonical agent and workspace alias changes cannot redirect a captured native edit", async () => {
  await withHost(async (host) => {
    await host.seed("global", "settings", { defaultModel: "baseline" });
    const snapshot = await host.load("global");
    const moved = path.join(host.root, "original-agent");
    const replacement = path.join(host.root, "replacement");
    await rename(host.agent, moved);
    await mkdir(replacement);
    await writeFile(path.join(replacement, "settings.json"), '{"defaultModel":"external"}');
    await symlink(replacement, host.agent, "junction");
    assert.equal((await host.edit(snapshot, "defaultModel", "must-not-write")).result.error, unavailable);
    assert.equal(JSON.parse(await readFile(path.join(replacement, "settings.json"), "utf8")).defaultModel, "external");
    assert.equal(JSON.parse(await readFile(path.join(moved, "settings.json"), "utf8")).defaultModel, "baseline");
    await rm(host.agent);
    await rename(moved, host.agent);
    const alias = path.join(host.root, "workspace-alias");
    await symlink(host.root, alias, "junction");
    host.mock.workspace.workspaceFolders = [{ uri: MockUri.file(alias) }];
    const aliased = await host.load("global");
    await rm(alias);
    await symlink(replacement, alias, "junction");
    assert.equal((await host.edit(aliased, "defaultModel", "must-not-write")).result.error, unavailable);
    assert.equal(JSON.parse(await readFile(host.file("global", "settings"), "utf8")).defaultModel, "baseline");
  });
});

test("a disposed panel cannot publish a held load into its replacement panel", async () => {
  await withHost(async (host) => {
    const gate = host.holdNext();
    host.panel.receive({ type: "nativeLoad", id: "closed-load", scope: "global" });
    await gate.entered.promise;
    host.panel.dispose();
    const previousMessages = host.panel.webview.messages.length;
    host.controller.show();
    const replacement = host.mock.panels.at(-1);
    assert.notEqual(replacement, host.panel);
    replacement.receive({ type: "nativeLoad", id: "replacement-load", scope: "project" });
    gate.release.resolve();
    await (host.controller as any).queue;
    assert.equal(host.panel.webview.messages.length, previousMessages);
    assert.equal(
      replacement.webview.messages.some((message: any) => message.id === "closed-load"),
      false,
    );
    assert.equal(
      replacement.webview.messages.some(
        (message: any) => message.type === "nativeSnapshot" && message.id === "replacement-load",
      ),
      true,
    );
    await assert.rejects(lstat(host.agent), { code: "ENOENT" });
    await assert.rejects(lstat(path.join(host.root, ".pi")), { code: "ENOENT" });
  });
});

test("guards repeat after asynchronous work and reject an environment change before persistence", async () => {
  await withHost(async (host) => {
    await host.seed("global", "settings", { defaultModel: "baseline" });
    const snapshot = await host.load("global");
    host.setGuardHook(async (count) => {
      if (count === 3) process.env.PI_CODING_AGENT_DIR = path.join(host.root, "replacement-agent");
    });
    const response = await host.edit(snapshot, "defaultModel", "must-not-write");
    assert.equal(response.result.error, unavailable);
    assert.ok(host.guards >= 3);
    assert.equal(JSON.parse(await readFile(host.file("global", "settings"), "utf8")).defaultModel, "baseline");
    await assert.rejects(lstat(path.join(host.root, "replacement-agent")), { code: "ENOENT" });
  });
});
