import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { settingsDescriptors, validSettingValue } from "../settingsModel";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("settings descriptors match every manifest property, including bounds and falsy defaults", () => {
  const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8"));
  const properties = manifest.contributes.configuration.properties;
  assert.deepEqual(settingsDescriptors.map((item) => `pi.${item.key}`).sort(), Object.keys(properties).sort());
  for (const descriptor of settingsDescriptors) {
    const property = properties[`pi.${descriptor.key}`];
    for (const key of ["type", "default", "enum", "minimum", "maximum"] as const)
      assert.deepEqual(descriptor[key], property[key]);
    if (descriptor.type === "array") assert.equal(property.items.type, "string");
    assert.equal(validSettingValue(descriptor, descriptor.default), true);
    assert.equal(validSettingValue(descriptor, null), false);
    assert.equal(validSettingValue(descriptor, {}), false);
  }
  const number = settingsDescriptors.find((item) => item.key === "inlineCompletions.minimumPrefixLength")!;
  for (const value of [NaN, Infinity, 1.1, -1, 101, "0"]) assert.equal(validSettingValue(number, value), false);
  assert.equal(validSettingValue(number, 0), true);
  const list = settingsDescriptors.find((item) => item.type === "array")!;
  for (const value of [
    Array(101).fill("a"),
    [1],
    ["a\nb"],
    ["a".repeat(4097)],
    Array(100).fill("a".repeat(200)),
    Array(5).fill("漢".repeat(2000)),
  ])
    assert.equal(validSettingValue(list, value), false);
  assert.equal(validSettingValue(list, []), true);
});

test("Settings host validates, scopes, synchronizes, serializes, and disposes without Pi dependencies", async () => {
  const vscode = installVscodeMock();
  const { registerSettingsPanel } = require("../settingsPanel") as typeof import("../settingsPanel");
  const user = new Map<string, unknown>();
  const workspace = new Map<string, unknown>();
  const calls: unknown[][] = [];
  let fail = false;
  let delay: (() => Promise<void>) | undefined;
  const defaults = new Map(settingsDescriptors.map((item) => [item.key, item.default]));
  vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/tmp/settings-fixture") }];
  vscode.workspace.getConfiguration = (section: string) => {
    assert.equal(section, "pi");
    return {
      inspect: (key: string) => ({
        defaultValue: defaults.get(key),
        globalValue: user.get(key),
        workspaceValue: workspace.get(key),
      }),
      get: (key: string, fallback: unknown) => workspace.get(key) ?? user.get(key) ?? fallback,
      update: async (key: string, value: unknown, target: number) => {
        if (delay) await delay();
        if (fail) throw new Error("Settings file is read-only");
        calls.push([key, value, target]);
        const values = target === 1 ? user : workspace;
        if (value === undefined) values.delete(key);
        else values.set(key, value);
        vscode.configurationEvents.emit("change", { affectsConfiguration: (name: string) => name === "pi" });
      },
    };
  };
  const commands: unknown[][] = [];
  vscode.commands.executeCommand = async (...args: unknown[]) => commands.push(args);
  const context = { extensionUri: MockUri.file(process.cwd()), subscriptions: [] } as any;
  const controller = registerSettingsPanel(context);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  try {
    vscode.registrations.get("pi.openSettings")();
    const panel = vscode.panels[0];
    controller.show();
    assert.equal(vscode.panels.length, 1);
    assert.equal(panel.reveals, 1);
    assert.equal(panel.options.retainContextWhenHidden, undefined);
    assert.equal(panel.options.localResourceRoots[0].fsPath, path.join(process.cwd(), "out/settings"));
    assert.ok(panel.webview.html.includes("default-src 'none'"));
    assert.ok(!panel.webview.html.includes("unsafe-inline"));
    panel.receive({ type: "ready" });
    await flush();
    const state = () => panel.webview.messages.filter((item: any) => item.type === "snapshot").at(-1);
    let id = 0;
    const send = async (extra: Record<string, unknown>) => {
      panel.receive({
        type: "save",
        id: `request-${++id}`,
        target: "user",
        revision: state().revision,
        key: "provider",
        value: "example",
        ...extra,
      });
      await flush();
      return panel.webview.messages.filter((item: any) => item.type === "result").at(-1);
    };
    assert.equal((await send({ value: "" })).ok, true);
    assert.equal(user.get("provider"), "");
    assert.equal((await send({ key: "inlineCompletions.enabled", value: false })).ok, true);
    assert.equal((await send({ key: "inlineCompletions.minimumPrefixLength", value: 0 })).ok, true);
    assert.equal((await send({ key: "inlineCompletions.excludedLanguages", value: [] })).ok, true);
    assert.equal((await send({ value: "workspace-model", target: "workspace" })).ok, true);
    assert.equal((await send({ value: "user-model" })).ok, true);
    assert.equal(state().entries.find((entry: any) => entry.key === "provider").effective, "workspace-model");
    assert.equal((await send({ type: "reset" })).ok, true);
    assert.equal(user.has("provider"), false);
    assert.equal(workspace.get("provider"), "workspace-model");
    const before = calls.length;
    for (const extra of [
      { key: "unknown" },
      { key: "agent.confirmToolCalls", value: "all" },
      { target: "folder" },
      { target: null },
      { revision: -1 },
      { value: 12 },
      { value: "x".repeat(4097) },
      { value: "a\0b" },
      { key: "thinkingLevel", value: "invalid" },
      { key: "inlineCompletions.debounceMilliseconds", value: 99 },
      { key: "inlineCompletions.minimumPrefixLength", value: Infinity },
      { type: "executeCommand" },
    ])
      assert.equal((await send(extra)).ok, false);
    assert.equal(calls.length, before);
    const revision = state().revision;
    workspace.set("provider", "external");
    vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    assert.equal((await send({ revision })).ok, false);
    // Even if the configuration event has not arrived, snapshot comparison rejects the write.
    const anotherRevision = state().revision;
    workspace.set("model", "external-without-event");
    assert.equal((await send({ revision: anotherRevision })).ok, false);
    vscode.workspace.isTrusted = false;
    assert.equal((await send({ key: "approveProjectResources", value: true })).ok, false);
    assert.equal((await send({ type: "reset", key: "approveProjectResources" })).ok, false);
    vscode.workspace.workspaceFolders = [];
    assert.equal((await send({ target: "workspace" })).ok, false);
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/tmp/settings-fixture") }];
    panel.receive({ type: "ready" });
    await flush();
    fail = true;
    assert.match((await send({})).error, /read-only/);
    fail = false;
    // Queue target-bound writes; the second stale request must not overwrite the first.
    let release!: () => void;
    delay = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    panel.receive({
      type: "save",
      id: "queued-1",
      target: "user",
      revision: state().revision,
      key: "model",
      value: "first",
    });
    await flush();
    panel.receive({
      type: "save",
      id: "queued-2",
      target: "workspace",
      revision: state().revision,
      key: "model",
      value: "second",
    });
    release();
    delay = undefined;
    await flush();
    assert.equal(user.get("model"), "first");
    assert.equal(workspace.get("model"), "external-without-event");
    // Hold one write and fill the remaining queue slots. Rejected writes need immediate results.
    const callsBeforeFullQueue = calls.length;
    delay = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    panel.receive({
      type: "save",
      id: "held-write",
      target: "user",
      revision: state().revision,
      key: "model",
      value: "held",
    });
    await flush();
    for (let i = 0; i < 15; i++) panel.receive({ type: "ready" });
    for (const type of ["save", "reset"]) {
      panel.receive({
        type,
        id: `overflow-${type}`,
        target: "workspace",
        revision: state().revision,
        key: "model",
        value: "must-not-write",
      });
      const result = panel.webview.messages.at(-1);
      assert.equal(result.id, `overflow-${type}`);
      assert.equal(result.ok, false);
      assert.match(result.error, /busy/);
    }
    const responsesAfterOverflow = panel.webview.messages.length;
    panel.receive({ type: "save", id: "invalid!" });
    panel.receive({ type: "executeCommand", id: "not-a-write" });
    assert.equal(panel.webview.messages.length, responsesAfterOverflow);
    assert.equal(calls.length, callsBeforeFullQueue, "Overflow must not start another configuration update");
    release();
    delay = undefined;
    await flush();
    assert.equal(calls.length, callsBeforeFullQueue + 1, "Only the accepted held write reaches configuration");
    assert.equal(
      (await send({ key: "model", value: "after-full-queue" })).ok,
      true,
      "The queue recovers after the held write finishes",
    );
    panel.receive({ type: "openNative", command: "malicious" });
    await flush();
    assert.deepEqual(commands, [["workbench.action.openSettings", "@ext:narumi.narumi-pi"]]);
    for (const message of [
      null,
      [],
      "bad",
      { type: "save", id: "invalid!" },
      { type: "ready", extra: "x".repeat(32769) },
    ])
      panel.receive(message);
    await flush();
    panel.dispose();
    assert.equal(vscode.configurationEvents.listenerCount("change"), 0);
    assert.equal(vscode.workspaceEvents.listenerCount("folders"), 0);
    controller.show();
    assert.equal(vscode.panels.length, 2);
    const second = vscode.panels[1];
    second.receive({ type: "ready" });
    await flush();
    const latest = second.webview.messages.at(-1).revision;
    delay = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    second.receive({
      type: "save",
      id: "dispose-save",
      target: "user",
      revision: latest,
      key: "model",
      value: "accepted-before-close",
    });
    await flush();
    controller.dispose();
    const posted = second.webview.messages.length;
    release();
    delay = undefined;
    await flush();
    assert.equal(second.webview.messages.length, posted, "No late post to disposed panel");
    assert.equal(vscode.configurationEvents.listenerCount("change"), 0);
    controller.show();
    assert.equal(vscode.panels.length, 2);
  } finally {
    controller.dispose();
    vscode.restore();
  }
});
