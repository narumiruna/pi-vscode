import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

interface ConfigurationGroup {
  title: string;
  order: number;
  properties: Record<string, Record<string, unknown>>;
}
const manifest = JSON.parse(readFileSync(path.resolve("package.json"), "utf8")) as {
  contributes: {
    configuration: ConfigurationGroup[];
    commands: { command: string; title: string; icon?: string }[];
    menus: Record<string, { command: string; when: string; group: string }[]>;
  };
};

test("native Settings categories preserve every existing property contract", () => {
  const groups = manifest.contributes.configuration;
  assert.deepEqual(
    groups.map((group) => group.title),
    ["General", "Permissions", "Editor"],
  );
  assert.deepEqual(
    groups.map((group) => group.order),
    [1, 2, 3],
  );
  const properties = Object.assign({}, ...groups.map((group) => group.properties));
  const expected = {
    "pi.executablePath": { type: "string", default: "" },
    "pi.provider": { type: "string", default: "" },
    "pi.model": { type: "string", default: "" },
    "pi.thinkingLevel": {
      type: "string",
      default: "default",
      enum: ["default", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
    },
    "pi.approveProjectResources": { type: "boolean", default: false },
    "pi.sensitiveContextNames": {
      type: "array",
      default: [".env", "credential", "secret", "id_rsa", "id_ed25519"],
      items: { type: "string" },
    },
    "pi.annotations.initialState": { type: "string", default: "collapsed", enum: ["collapsed", "expanded"] },
    "pi.inlineCompletions.enabled": { type: "boolean", default: false },
    "pi.inlineCompletions.debounceMilliseconds": { type: "number", default: 650, minimum: 100, maximum: 5000 },
    "pi.inlineCompletions.minimumPrefixLength": { type: "number", default: 3, minimum: 0, maximum: 100 },
    "pi.inlineCompletions.excludedLanguages": {
      type: "array",
      default: ["plaintext", "scminput"],
      items: { type: "string" },
    },
  };
  assert.deepEqual(Object.keys(properties).sort(), Object.keys(expected).sort());
  assert.equal(
    groups.reduce((count, group) => count + Object.keys(group.properties).length, 0),
    11,
  );
  for (const [key, contract] of Object.entries(expected)) {
    const { description, markdownDescription, order, ...actual } = properties[key];
    assert.deepEqual(actual, contract, key);
    assert.ok(description || markdownDescription, key);
    assert.ok(Number.isInteger(order), key);
  }
});

test("both settings destinations share the title overflow group with clear names and gear icons", () => {
  const destinations = [
    ["pi.openSettings", "Extension Settings", "configuration@10"],
    ["pi.openPiConfiguration", "Pi Configuration", "configuration@20"],
  ];
  for (const [id, title, group] of destinations) {
    const entries = manifest.contributes.menus["view/title"].filter((item) => item.command === id);
    assert.deepEqual(entries, [{ command: id, when: "view == pi.chatView", group }]);
    assert.ok(!group.startsWith("navigation"), "Settings must not have standalone title buttons");
    const command = manifest.contributes.commands.find((item) => item.command === id);
    assert.equal(command?.title, title);
    assert.equal(command?.icon, "$(gear)");
  }
  const sidebar = readFileSync(path.resolve("src/sidebar.ts"), "utf8");
  const more = sidebar.slice(
    sidebar.indexOf("private async showMoreActions("),
    sidebar.indexOf("private assertSettingsIdle("),
  );
  assert.ok(more.length > 0);
  for (const [id] of destinations) assert.ok(!more.includes(id), "Composer More must not duplicate global settings");
});

test("Settings uses the native route while Pi Configuration stays bounded, singleton, and process-free", async () => {
  const vscode = installVscodeMock();
  const { registerSettingsPanel } = require("../settingsPanel") as typeof import("../settingsPanel");
  const commands: unknown[][] = [];
  vscode.commands.executeCommand = async (...args: unknown[]) => commands.push(args);
  vscode.workspace.getConfiguration = () => {
    throw new Error("The panel shell must not read or write VS Code setting values");
  };
  vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/tmp/settings-fixture") }];
  const context = {
    extensionUri: MockUri.file(process.cwd()),
    subscriptions: [],
  } as unknown as import("vscode").ExtensionContext;
  const controller = registerSettingsPanel(context);
  const flush = async () => {
    for (let i = 0; i < 30; i++) await new Promise((resolve) => setImmediate(resolve));
  };
  const nativeRoute = ["workbench.action.openSettings", "@ext:narumi.narumi-pi"];
  try {
    await vscode.registrations.get("pi.openSettings")();
    assert.deepEqual(commands, [nativeRoute]);
    assert.equal(vscode.panels.length, 0);
    vscode.registrations.get("pi.openPiConfiguration")();
    const panel = vscode.panels[0];
    controller.show();
    assert.equal(vscode.panels.length, 1);
    assert.equal(panel.reveals, 1);
    assert.equal(panel.title, "Pi Configuration");
    assert.equal(panel.options.retainContextWhenHidden, undefined);
    assert.equal(panel.options.localResourceRoots[0].fsPath, path.join(process.cwd(), "out/settings"));
    assert.ok(panel.webview.html.includes("default-src 'none'"));
    assert.ok(!panel.webview.html.includes("unsafe-inline"));
    assert.ok(!panel.webview.html.includes('id="target"'));
    assert.ok(panel.webview.html.includes(">Open Extension Settings</button>"));
    assert.ok(!panel.webview.html.includes("Open VS Code Settings"));
    panel.receive({ type: "ready" });
    await flush();
    const state = () => panel.webview.messages.filter((item: { type?: string }) => item.type === "snapshot").at(-1);
    assert.deepEqual(state(), { type: "snapshot", nativeFilesAvailable: true });
    panel.receive({ type: "openNative", command: "malicious" });
    await flush();
    assert.deepEqual(commands.at(-1), nativeRoute);
    for (const scope of ["global", "project"]) {
      for (const kind of ["settings", "mcp"]) {
        panel.receive({ type: "openPiFile", scope, kind, command: "malicious", path: "/untrusted" });
        await flush();
        assert.deepEqual(commands.at(-1), [kind === "settings" ? "pi.openNativeSettings" : "pi.openNativeMcp", scope]);
      }
    }
    const opened = commands.length;
    for (const extra of [
      { scope: "workspace" },
      { scope: "user" },
      { scope: null },
      { kind: "auth" },
      { kind: "../settings" },
    ])
      panel.receive({ type: "openPiFile", scope: "project", kind: "settings", ...extra });
    // Legacy messages cannot mutate configuration, including recovered pre-change drafts.
    for (const type of ["save", "reset", "executeCommand"])
      panel.receive({ type, id: "legacy-write", key: "approveProjectResources", value: true, target: "user" });
    for (const message of [null, [], "bad", { type: "ready", extra: "x".repeat(32769) }]) panel.receive(message);
    await flush();
    assert.equal(commands.length, opened);
    for (const workspace of ["untrusted", "virtual", "missing"]) {
      vscode.workspace.isTrusted = workspace !== "untrusted";
      vscode.workspace.workspaceFolders =
        workspace === "missing"
          ? []
          : [
              {
                uri:
                  workspace === "virtual"
                    ? MockUri.from({ scheme: "virtual", path: "/workspace" })
                    : MockUri.file("/tmp/workspace"),
              },
            ];
      vscode.workspaceEvents.emit("folders");
      await flush();
      assert.equal(state().nativeFilesAvailable, false);
      panel.receive({ type: "openPiFile", scope: "global", kind: "settings" });
      await flush();
      assert.equal(commands.length, opened);
      await vscode.registrations.get("pi.openSettings")();
      assert.deepEqual(commands.pop(), nativeRoute, "Native Settings remains independent of Pi file availability");
    }
    vscode.workspace.isTrusted = true;
    vscode.workspace.workspaceFolders = [{ uri: MockUri.file("/tmp/settings-fixture") }];
    vscode.workspaceEvents.emit("trust");
    assert.equal(state().nativeFilesAvailable, true);
    const previous = panel.webview.messages.length;
    vscode.configurationEvents.emit("change", { affectsConfiguration: () => false });
    assert.equal(panel.webview.messages.length, previous);
    vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    assert.equal(panel.webview.messages.at(-1).type, "nativeInvalidated");
    panel.dispose();
    assert.equal(vscode.configurationEvents.listenerCount("change"), 0);
    assert.equal(vscode.workspaceEvents.listenerCount("folders"), 0);
    assert.equal(vscode.workspaceEvents.listenerCount("trust"), 0);
    controller.show();
    assert.equal(vscode.panels.length, 2);
    const second = vscode.panels[1];
    let release!: () => void;
    let entered = false;
    vscode.commands.executeCommand = async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      throw new Error("Private command error must not reach a disposed panel");
    };
    second.receive({ type: "openNative" });
    await flush();
    assert.equal(entered, true);
    controller.dispose();
    const posted = second.webview.messages.length;
    release();
    await flush();
    assert.equal(second.webview.messages.length, posted);
    controller.show();
    assert.equal(vscode.panels.length, 2);
  } finally {
    controller.dispose();
    vscode.restore();
  }
});
