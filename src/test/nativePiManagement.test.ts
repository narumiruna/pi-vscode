import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { checkNativeMcp, projectMcpDiagnostic } from "../nativeMcpDiagnostics";
import {
  nativeFileByteLimit,
  nativeFileTarget,
  readNativeFile,
  resolveNativeAgentDirectory,
  saveNativeFile,
} from "../nativePiFiles";
import { parseNativeJson, patchNativeJson } from "../nativePiJson";
import {
  effectiveMcpMetadata,
  mcpMetadata,
  nativeMcpCommandOwner,
  nativeSettingControls,
  validateMcpEntry,
  validateNativeSetting,
} from "../nativePiModel";
import { installVscodeMock, MockUri } from "./vscodeMock";

const guard = async () => {};
let nativeManagementVscode: ReturnType<typeof installVscodeMock> | undefined;
test("native JSON patch keeps unrelated formatting, ordered patterns, nested keys and scoped resets", () => {
  const source =
    '{\r\n\t"unknown": { "credentials": "do-not-project" },\r\n\t"compaction": { "enabled": true, "reserveTokens": 123 },\r\n\t"defaultModel": "old"\r\n}\r\n';
  const changed = patchNativeJson(source, ["compaction", "enabled"], false);
  assert.equal(changed, source.replace('"enabled": true', '"enabled": false'));
  const reset = patchNativeJson(changed, ["compaction", "enabled"], undefined);
  assert.deepEqual(parseNativeJson(reset).compaction, { reserveTokens: 123 });
  const models = patchNativeJson(reset, ["enabledModels"], ["provider/z*:high", "zero-match", "provider/a"]);
  assert.deepEqual(parseNativeJson(models).enabledModels, ["provider/z*:high", "zero-match", "provider/a"]);
  assert.ok(models.includes('"unknown": { "credentials": "do-not-project" }'));
  assert.ok(models.includes("\r\n"));
  for (const text of [
    '{"x":1,"x":2}',
    '{"x":{"y":1,"y":2}}',
    "{ //comment\n}",
    "[]",
    '{"__proto__":{}}',
    "{".repeat(33),
  ])
    assert.throws(() => parseNativeJson(text));
  for (const source of ['{"a":1,"b":2,"c":3}', '{"a":1}', "{}"]) {
    for (const key of ["a", "b", "c", "missing"]) {
      const expected = JSON.parse(source);
      delete expected[key];
      assert.deepEqual(JSON.parse(patchNativeJson(source, [key], undefined)), expected);
    }
  }
});

test("native setting labels use the Pi core settings terms", () => {
  for (const [key, label] of [
    ["steeringMode", "Steering mode"],
    ["followUpMode", "Follow-up mode"],
    ["defaultThinkingLevel", "Startup thinking level"],
    ["enabledModels", "Scoped model patterns (ordered; not access control)"],
  ])
    assert.equal(nativeSettingControls.find((control) => control.key === key)?.label, label);
});

test("native resolution uses host paths and custom agent directory; controls reject invalid types without discovery", () => {
  assert.equal(resolveNativeAgentDirectory("/host/project", {}, "/host/home"), "/host/home/.pi/agent");
  assert.equal(
    resolveNativeAgentDirectory("/host/project", { PI_CODING_AGENT_DIR: "~/custom" }, "/host/home"),
    "/host/home/custom",
  );
  assert.equal(resolveNativeAgentDirectory("/host/project", { PI_CODING_AGENT_DIR: "../agent" }), "/host/agent");
  for (const control of nativeSettingControls) {
    assert.doesNotThrow(() => validateNativeSetting(control, control.defaultValue));
    assert.doesNotThrow(() => validateNativeSetting(control, undefined));
    assert.throws(() => validateNativeSetting(control, {}));
  }
  const patterns = nativeSettingControls.find((control) => control.key === "enabledModels")!;
  assert.doesNotThrow(() => validateNativeSetting(patterns, ["anthropic/*:high", "no-matches", "gpt"]));
  for (const value of [["bad,entry"], Array(101).fill("x"), [""], [1]])
    assert.throws(() => validateNativeSetting(patterns, value));
});

test("native bounded file writes preserve bytes and reject conflicts, links, invalid text, read-only and changed origin", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-files-"));
  try {
    const target = await nativeFileTarget(path.join(root, "agent"), "global", "settings");
    const missing = await readNativeFile(target);
    assert.equal(missing.exists, false);
    const resetMissing = await saveNativeFile(missing, ["defaultModel"], undefined, guard);
    assert.equal(resetMissing.exists, false, "Reset must not create a missing native file");
    await assert.rejects(readFile(path.join(root, "agent/settings.json")), { code: "ENOENT" });
    const first = await saveNativeFile(missing, ["defaultModel"], "model", guard);
    assert.equal(first.value.defaultModel, "model");
    assert.equal(first.exists, true);
    await assert.rejects(saveNativeFile(missing, ["defaultModel"], "stale", guard), /changed/);
    await writeFile(path.join(root, "agent/settings.json"), '{ "external": 1, "defaultModel": "external" }\n');
    await assert.rejects(saveNativeFile(first, ["defaultModel"], "stale", guard), /changed/);
    let snapshot = await readNativeFile(target);
    await assert.rejects(
      saveNativeFile(snapshot, ["defaultModel"], "wrong", async () => {
        throw new Error("origin generation changed");
      }),
      /origin/,
    );
    assert.equal((await readNativeFile(target)).revision, snapshot.revision);
    await chmod(path.join(root, "agent/settings.json"), 0o444);
    await assert.rejects(saveNativeFile(snapshot, ["defaultModel"], "wrong", guard), /read-only|EACCES/);
    await chmod(path.join(root, "agent/settings.json"), 0o600);
    snapshot = await saveNativeFile(snapshot, ["defaultModel"], undefined, guard);
    assert.deepEqual(snapshot.value, { external: 1 });
    assert.ok(snapshot.text.includes('"external": 1'));
    await writeFile(path.join(root, "agent/settings.json"), "x".repeat(nativeFileByteLimit + 1));
    await assert.rejects(readNativeFile(target), /Oversized/);
    await writeFile(path.join(root, "agent/settings.json"), Buffer.from([0xff]));
    await assert.rejects(readNativeFile(target), /UTF-8/);
    await rm(path.join(root, "agent/settings.json"));
    await writeFile(path.join(root, "outside"), "{}");
    await symlink(path.join(root, "outside"), path.join(root, "agent/settings.json"));
    await assert.rejects(readNativeFile(target), /unsupported/i);
    await symlink(path.join(root, "agent"), path.join(root, "alias"));
    await assert.rejects(nativeFileTarget(path.join(root, "alias"), "global", "settings"), /symlink/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP projection hides executable/secret fields; approved metadata-only project override inherits transport", () => {
  const global = {
    mcpServers: {
      docs: {
        url: "https://secret@example.test/mcp?token=secret",
        enabled: true,
        exposure: "deferred",
        headers: { Authorization: "Bearer secret" },
        env: { KEY: "!credential-command" },
        oauth: { clientSecret: "secret" },
      },
    },
  };
  const project = { mcpServers: { docs: { enabled: false }, local: { command: "fixture", args: ["secret"] } } };
  const ignored = effectiveMcpMetadata(global, project, false);
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0].enabled, true);
  const active = effectiveMcpMetadata(global, project, true);
  assert.deepEqual(active[0], {
    name: "docs",
    type: "http",
    enabled: false,
    exposure: "deferred",
    source: "project",
    state: "unknown",
  });
  const text = JSON.stringify(active);
  for (const secret of ["secret", "credential-command", "Authorization", "oauth", "https:", "fixture"])
    assert.ok(!text.includes(secret));
  assert.equal(
    mcpMetadata({ mcpServers: { bad: { type: "sse", url: "https://example.test" } } }, "global")[0].type,
    "invalid",
  );
  assert.throws(() => validateMcpEntry("bad name", {}, "project"));
  assert.throws(() => validateMcpEntry("docs", { enabled: false }, "global"));
  assert.doesNotThrow(() =>
    validateMcpEntry("docs", { toolExposure: { "read_*": "direct", "delete_*": "hidden" } }, "project"),
  );
  assert.equal(nativeMcpCommandOwner([]), "absent");
  assert.equal(
    nativeMcpCommandOwner([{ name: "mcp", source: "extension", sourceInfo: { path: "/third-party/index.ts" } }]),
    "replacement",
  );
  const native = { name: "mcp", source: "extension", sourceInfo: { path: "builtin:mcp" } };
  assert.equal(nativeMcpCommandOwner([native]), "native");
  assert.equal(nativeMcpCommandOwner([native, native]), "replacement");
});

test("CLI MCP diagnostics project only bounded verified fields; raw errors and transport stay out", () => {
  assert.deepEqual(
    projectMcpDiagnostic(
      JSON.stringify({
        servers: [
          { name: "fixture", state: "connected", tools: ["read", "write"], transport: "secret", error: "token" },
        ],
        errors: ["credential-error"],
      }),
    ),
    { servers: [{ name: "fixture", state: "connected", toolCount: 2 }], configErrorCount: 1 },
  );
  for (const value of [
    "not JSON",
    "{}",
    JSON.stringify({ servers: [{ name: "fixture", state: "third-party", tools: [] }], errors: [] }),
  ])
    assert.equal(projectMcpDiagnostic(value), undefined);
});

test("explicit MCP CLI fixture uses bounded public command arguments and discards secret output", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-mcp-cli-fixture-"));
  try {
    const executable = path.join(root, "fixture");
    await writeFile(
      executable,
      `#!${process.execPath}\nif (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(["mcp","list","--json"])) process.exit(8);\nif (process.env.PI_OFFLINE !== "1" || process.env.PI_TELEMETRY !== "0") process.exit(9);\nprocess.stderr.write("credential-secret");\nconsole.log(JSON.stringify({ servers: [{ name:"fixture", state:"connected", tools:["read"], transport:"secret", error:"secret" }], errors: [] }));\n`,
      { mode: 0o700 },
    );
    const result = await checkNativeMcp(executable, root, new AbortController().signal);
    assert.equal(result.source, "separate-cli");
    assert.equal(result.outcome, "completed");
    assert.deepEqual(result.servers, [{ name: "fixture", state: "connected", toolCount: 1 }]);
    assert.ok(!JSON.stringify(result).includes("secret"));
    await writeFile(executable, `#!${process.execPath}\nsetInterval(()=>{}, 1000);\n`, { mode: 0o700 });
    const controller = new AbortController();
    const pending = checkNativeMcp(executable, root, controller.signal);
    setTimeout(() => controller.abort(), 100);
    assert.equal((await pending).outcome, "cancelled");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native runtime selection retains one guard, rejects stale approval and distinguishes acknowledged-unverified changes", async () => {
  nativeManagementVscode ??= installVscodeMock();
  const vscode = nativeManagementVscode;
  try {
    const { PiRuntimeManager, NativeRuntimeControlAppliedError } =
      require("../piRuntime") as typeof import("../piRuntime");
    const runtime = new PiRuntimeManager({ environmentVariableCollection: { clear() {} } } as any);
    const internal = runtime as any;
    const commands: string[] = [];
    let generation = 1;
    let checks = 0;
    let failAfterAck = false;
    const client = {
      isRunning: true,
      setSteeringMode: async (mode: string) => {
        commands.push(`steering:${mode}`);
      },
      setFollowUpMode: async (mode: string) => {
        commands.push(`follow:${mode}`);
      },
      setAutoCompaction: async (enabled: boolean) => {
        commands.push(`compaction:${enabled}`);
      },
      setAutoRetry: async (enabled: boolean) => {
        commands.push(`retry:${enabled}`);
      },
    };
    await assert.rejects(
      runtime.configureNativeRuntimeControl(async () => ({ key: "retry.enabled", value: true })),
      /Start Pi explicitly/,
    );
    internal.client = client;
    internal.state.connected = true;
    internal.withForegroundOperation = async (
      _label: string,
      action: (client: unknown, guard: () => Promise<void>) => Promise<unknown>,
    ) => {
      const captured = generation;
      return action(client, async () => {
        checks++;
        if (captured !== generation || (failAfterAck && commands.length)) throw new Error("stale generation");
      });
    };
    internal.refreshStateAfterCommand = async () => {};
    internal.state.queue = { steering: ["first", "second"], followUp: ["last"] };
    const queue = JSON.stringify(internal.state.queue);
    assert.equal(
      await runtime.configureNativeRuntimeControl(async (assertCurrent) => {
        await assertCurrent();
        return { key: "steeringMode", value: "all" };
      }),
      true,
    );
    await runtime.setNativeRuntimeControl("followUpMode", "one-at-a-time");
    await runtime.setNativeRuntimeControl("compaction.enabled", false);
    await runtime.setNativeRuntimeControl("retry.enabled", true);
    assert.deepEqual(commands, ["steering:all", "follow:one-at-a-time", "compaction:false", "retry:true"]);
    assert.equal(
      JSON.stringify(internal.state.queue),
      queue,
      "Grouping must not rewrite pending order or queue ownership",
    );
    const before = commands.length;
    await assert.rejects(
      runtime.configureNativeRuntimeControl(async () => {
        generation++;
        return { key: "steeringMode", value: "all" };
      }),
      /stale/,
    );
    assert.equal(commands.length, before);
    assert.equal(await runtime.configureNativeRuntimeControl(async () => undefined), false);
    commands.length = 0;
    failAfterAck = true;
    await assert.rejects(runtime.setNativeRuntimeControl("retry.enabled", false), NativeRuntimeControlAppliedError);
    assert.deepEqual(commands, ["retry:false"]);
    assert.ok(checks >= 10);
    internal.client = undefined;
    runtime.dispose();
  } finally {
    vscode.workspace.workspaceFolders = [];
    vscode.workspace.textDocuments = [];
  }
});

test("native settings and MCP surfaces use passive host dialogs, explicit targets and no runtime start", async () => {
  nativeManagementVscode ??= installVscodeMock();
  const vscode = nativeManagementVscode;
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-native-ui-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  try {
    await mkdir(path.join(root, ".pi"));
    const { registerNativePiManagement } = require("../nativePiController") as typeof import("../nativePiController");
    vscode.workspace.workspaceFolders = [{ uri: MockUri.file(root) }];
    const context = { subscriptions: [] } as any;
    let starts = 0;
    const runtime = {
      currentState: { commands: [], connected: false },
      currentCwd: root,
      withWorkspaceOperation: async (_label: string, action: (assert: () => Promise<void>) => Promise<unknown>) =>
        action(async () => {
          if (!vscode.workspace.isTrusted) throw new Error("untrusted");
        }),
      ensureStarted: async () => {
        starts++;
      },
    } as any;
    registerNativePiManagement(context, runtime);
    const picks: string[] = [];
    vscode.window.showQuickPick = async (items: any[]) => {
      const action = picks.shift();
      return items.find((item) => item.action === action);
    };
    // Passive view/cancel performs no process, connection or file write.
    picks.push("global");
    await vscode.registrations.get("pi.openNativeSettings")();
    await vscode.registrations.get("pi.openNativeMcp")();
    await vscode.registrations.get("pi.nativeRuntimeControls")();
    assert.equal(starts, 0);
    picks.push("project", "defaultModel", "edit");
    vscode.window.showInputBox = async () => "fixture-model";
    vscode.window.showWarningMessage = async (_message: string, _options: unknown, action: string) => action;
    let notified!: () => void;
    let dismiss!: () => void;
    const notification = new Promise<void>((resolve) => {
      notified = resolve;
    });
    const originalInformation = vscode.window.showInformationMessage;
    vscode.window.showInformationMessage = () =>
      new Promise<void>((resolve) => {
        dismiss = resolve;
        notified();
      });
    let completed = false;
    const saving = vscode.registrations
      .get("pi.openNativeSettings")()
      .then(() => {
        completed = true;
      });
    try {
      await notification;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(completed, true, "informational notifications must not retain operation ownership");
    } finally {
      dismiss();
      await saving;
      vscode.window.showInformationMessage = originalInformation;
    }
    assert.equal(
      JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")).defaultModel,
      "fixture-model",
    );
    picks.push("project", "defaultModel", "reset");
    await vscode.registrations.get("pi.openNativeSettings")();
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")), {});
    // An external edit while the confirmation is visible must be retained.
    picks.push("project", "defaultModel", "edit");
    vscode.window.showWarningMessage = async (_message: string, _options: unknown, action: string) => {
      await writeFile(path.join(root, ".pi/settings.json"), '{"external":true}');
      return action;
    };
    let errorNotified!: () => void;
    let dismissError!: () => void;
    const errorNotice = new Promise<void>((resolve) => {
      errorNotified = resolve;
    });
    const originalError = vscode.window.showErrorMessage;
    vscode.window.showErrorMessage = () =>
      new Promise<void>((resolve) => {
        dismissError = resolve;
        errorNotified();
      });
    let failedCommandCompleted = false;
    const rejectedSave = vscode.registrations
      .get("pi.openNativeSettings")()
      .then(() => {
        failedCommandCompleted = true;
      });
    try {
      await errorNotice;
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(failedCommandCompleted, true, "a failure notice must not keep the command pending");
    } finally {
      dismissError();
      await rejectedSave;
      vscode.window.showErrorMessage = originalError;
    }
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")), { external: true });
    vscode.window.showWarningMessage = async (_message: string, _options: unknown, action: string) => action;
    await mkdir(path.join(root, "agent"));
    const globalMcp =
      '{"mcpServers":{"docs":{"url":"https://example.invalid/mcp","env":{"KEY":"!secret-command"},"headers":{"Authorization":"secret-token"}}},"unknown":true}';
    await writeFile(path.join(root, "agent/mcp.json"), globalMcp);
    const originalQuickPick = vscode.window.showQuickPick;
    vscode.window.showQuickPick = async (items: unknown[]) => {
      assert.ok(!JSON.stringify(items).includes("secret-command"));
      assert.ok(!JSON.stringify(items).includes("secret-token"));
      return originalQuickPick(items);
    };
    picks.push("server:docs", "project", "disable");
    await vscode.registrations.get("pi.openNativeMcp")();
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/mcp.json"), "utf8")), {
      mcpServers: { docs: { enabled: false } },
    });
    assert.equal(await readFile(path.join(root, "agent/mcp.json"), "utf8"), globalMcp);
    picks.push("check");
    await vscode.registrations.get("pi.openNativeMcp")(); // unapproved project file blocks connecting CLI
    picks.push("server:docs", "project", "remove");
    await vscode.registrations.get("pi.openNativeMcp")();
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/mcp.json"), "utf8")), { mcpServers: {} });
    assert.equal(await readFile(path.join(root, "agent/mcp.json"), "utf8"), globalMcp);
    if (process.platform !== "win32") {
      // This explicit diagnostic runs only a static fixture CLI, never an MCP server.
      await rm(path.join(root, ".pi/mcp.json"));
      const fixture = path.join(root, "mcp-cli-fixture");
      await writeFile(
        fixture,
        `#!${process.execPath}\nconsole.log(JSON.stringify({servers:[{name:"docs",state:"connected",tools:["read"],error:"secret-token"}],errors:[]}));\n`,
        { mode: 0o700 },
      );
      vscode.workspace.getConfiguration = () => ({
        get: (key: string, fallback: unknown) => (key === "executablePath" ? fixture : fallback),
      });
      const notices: string[] = [];
      vscode.window.showInformationMessage = async (message: string) => {
        notices.push(message);
      };
      picks.push("check");
      await vscode.registrations.get("pi.openNativeMcp")();
      assert.ok(notices.some((message) => message.includes("diagnostic: completed")));
      await writeFile(path.join(root, "agent/mcp.json"), globalMcp.replace('"unknown":true', '"unknown":false'));
      picks.push("last");
      await vscode.registrations.get("pi.openNativeMcp")();
      assert.ok(notices.some((message) => message.includes("different workspace or file revision")));
      assert.ok(!JSON.stringify(notices).includes("secret-token"));
      await writeFile(path.join(root, "agent/mcp.json"), globalMcp);
    }
    // A workspace opened through an alias must not bypass the dirty native editor.
    const alias = path.join(root, "workspace-alias");
    await symlink(root, alias, "junction");
    const aliasedSettings = path.join(alias, ".pi/settings.json");
    const dirty = { uri: MockUri.file(aliasedSettings), version: 3, isDirty: true };
    vscode.workspace.workspaceFolders = [{ uri: MockUri.file(alias) }];
    vscode.workspace.textDocuments = [dirty];
    picks.push("project", "defaultModel", "edit");
    await vscode.registrations.get("pi.openNativeSettings")();
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")), { external: true });
    // Ordinary editor Save can only save the user's retained draft, not overwrite a hidden extension edit.
    await writeFile(aliasedSettings, '{"userDraft":"retained"}');
    dirty.isDirty = false;
    dirty.version++;
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")), {
      userDraft: "retained",
    });
    const other = path.join(root, "other-root");
    await mkdir(path.join(other, ".pi"), { recursive: true });
    await writeFile(path.join(other, ".pi/settings.json"), "{}");
    picks.push("project", "defaultModel", "edit");
    vscode.window.showWarningMessage = async (_message: string, _options: unknown, action: string) => {
      await rm(alias);
      await symlink(other, alias, "junction");
      return action;
    };
    await vscode.registrations.get("pi.openNativeSettings")();
    assert.deepEqual(JSON.parse(await readFile(path.join(root, ".pi/settings.json"), "utf8")), {
      userDraft: "retained",
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(other, ".pi/settings.json"), "utf8")), {});
    assert.equal(starts, 0);
    for (const disposable of context.subscriptions) disposable.dispose();
  } finally {
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    vscode.restore();
    await rm(root, { recursive: true, force: true });
  }
});
