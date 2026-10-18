import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

interface MenuContribution {
  readonly command?: string;
  readonly when?: string;
}

interface ExtensionManifest {
  readonly name: string;
  readonly displayName: string;
  readonly publisher: string;
  readonly scripts: Record<string, string>;
  readonly engines: { readonly vscode: string };
  readonly extensionKind: readonly string[];
  readonly devDependencies: Record<string, string>;
  readonly contributes: {
    readonly viewsContainers: { readonly secondarySidebar: readonly { readonly id: string; readonly title: string }[] };
    readonly views: Record<string, readonly { readonly id: string }[]>;
    readonly commands: readonly { command: string; title: string; category: string; enablement?: string }[];
    readonly chatParticipants: readonly { readonly id: string; readonly name: string; readonly fullName: string }[];
    readonly submenus: readonly { readonly label: string }[];
    readonly menus: Record<string, readonly MenuContribution[]>;
    readonly configuration: { readonly title: string; readonly properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as ExtensionManifest;

test("extension identity stays consistent across packaging, settings, and documentation", () => {
  assert.equal(manifest.name, "narumi-pi");
  assert.equal(manifest.displayName, "Pi");
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].title, "Pi");
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].id, "pi");
  assert.deepEqual(Object.keys(manifest.contributes.views), ["pi"]);
  assert.equal(manifest.contributes.views.pi[0].id, "pi.chatView");
  assert.equal(manifest.contributes.chatParticipants[0].id, "pi.chat");
  assert.ok(
    manifest.contributes.commands.every((command) => command.category === "Pi" && !command.title.includes("PiCode")),
  );
  assert.deepEqual(
    manifest.contributes.chatParticipants.map(({ name, fullName }) => ({ name, fullName })),
    [{ name: "pi", fullName: "Pi" }],
  );
  assert.ok(manifest.contributes.submenus.every((submenu) => submenu.label === "Pi"));
  assert.equal(manifest.contributes.configuration.title, "Pi");
  assert.equal(manifest.publisher, "narumi");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  const id = `${manifest.publisher}.${manifest.name}`;
  assert.ok(readFileSync("src/editorActions.ts", "utf8").includes(`"@ext:${id}"`));
  assert.ok(readFileSync("README.md", "utf8").includes(`The extension ID is \`${id}\``));
  assert.ok(manifest.scripts.package.includes("--out pi.vsix"));
  assert.ok(manifest.scripts["install:vsix"].includes("code --install-extension pi.vsix --force"));
  assert.ok(manifest.contributes.commands.every((command) => command.command.startsWith("pi.")));
  assert.ok(Object.keys(manifest.contributes.configuration.properties).every((key) => key.startsWith("pi.")));
  for (const path of [
    "resources/pi.svg",
    "resources/pi-bridge.ts",
    "resources/pi-permission-gate.ts",
    "resources/pi-read-only-gate.ts",
    "resources/pi-control.ts",
    "scripts/remove-legacy-pi-extension.mjs",
  ]) {
    assert.equal(existsSync(path), true, `missing Pi asset: ${path}`);
  }
  for (const path of [
    "resources/picode.svg",
    "resources/picode-bridge.ts",
    "resources/picode-permission-gate.ts",
    "resources/picode-read-only-gate.ts",
    "scripts/remove-legacy-picode-extension.mjs",
    "scripts/install-picode-extension.mjs",
  ]) {
    assert.equal(existsSync(path), false, `obsolete PiCode asset: ${path}`);
  }
  assert.equal(existsSync("justfile"), false);
  assert.equal(manifest.scripts.install, undefined, "npm install must not install the extension");
  assert.equal(
    manifest.scripts["install:extension"],
    "npm run install:vsix && node scripts/remove-legacy-pi-extension.mjs",
  );
});

test("workflow commands are contributed, registered, documented and keep minimum stable workspace-host compatibility", () => {
  assert.equal(manifest.engines.vscode, "^1.106.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  const vscodeTypesVersion = manifest.devDependencies["@types/vscode"];
  assert.match(vscodeTypesVersion, /^\d+\.\d+\.\d+$/);
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.packages[""].devDependencies["@types/vscode"], vscodeTypesVersion);
  assert.equal(lock.packages["node_modules/@types/vscode"].version, vscodeTypesVersion);
  assert.equal(manifest.contributes.configuration.properties["pi.defaultMode"], undefined);
  assert.equal(existsSync("src/runtimeProfiles.ts"), false);
  assert.equal(existsSync("src/test/runtimeProfiles.test.ts"), false);
  const entry = readFileSync("src/extension.ts", "utf8");
  const readme = readFileSync("README.md", "utf8");
  const cleanupIndex = entry.indexOf("await removeLegacyGlobalBridgeExtensions()");
  assert.ok(cleanupIndex >= 0 && cleanupIndex < entry.indexOf("new PiRuntimeManager(context)"));
  for (const [command, controller, register] of [
    ["reviewStagedChanges", "gitReviewController", "registerGitReview"],
    ["reviewChanges", "gitReviewController", "registerGitReview"],
    ["showReviewFindings", "gitReviewController", "registerGitReview"],
    ["fixWorkspaceDiagnostics", "workspaceDiagnosticsController", "registerWorkspaceDiagnostics"],
    ["showStagedFindings", "gitReviewController", "registerGitReview"],
    ["repairFailedTest", "testRepairController", "registerTestRepair"],
    ["askDebugContext", "debugContextController", "registerDebugContext"],
  ]) {
    const id = `pi.${command}`;
    assert.match(
      manifest.contributes.commands.find((item) => item.command === id)?.enablement ?? "",
      /isWorkspaceTrusted/,
    );
    assert.ok(readFileSync(`src/${controller}.ts`, "utf8").includes(`"${id}"`));
    assert.ok(entry.includes(`${register}(context, runtime, conversation)`));
  }
  for (const label of [
    "Review Changes",
    "Show Review Findings",
    "Fix Workspace Diagnostics (Preview)",
    "Review Staged Changes",
    "Show Staged Findings",
    "Repair Failed Test (Preview)",
    "Ask Debug Context",
  ])
    assert.ok(readme.includes(`Pi: ${label}`));
});

test("extension editor commands use matching IDs, guarded context and keyboard bindings", () => {
  const controller = readFileSync("src/extensionUiDialogs.ts", "utf8");
  assert.ok(readFileSync("src/extension.ts", "utf8").includes("registerExtensionUiDialogs(context, runtime)"));
  const raw = JSON.parse(readFileSync("package.json", "utf8"));
  for (const action of ["submit", "cancel"]) {
    const id = `pi.extensionEditor.${action}`;
    assert.ok(controller.includes(`"${id}"`));
    assert.equal(
      manifest.contributes.commands.find((item) => item.command === id)?.enablement,
      "isWorkspaceTrusted && pi.extensionEditorActive",
    );
    assert.equal(
      manifest.contributes.menus["editor/title"].find((item) => item.command === id)?.when,
      "pi.extensionEditorActive",
    );
    assert.match(
      raw.contributes.keybindings.find((item: { command: string }) => item.command === id).when,
      /editorTextFocus.*pi.extensionEditorActive/,
    );
  }
});

test("timed extension confirmations expose approval only for the active owned review", () => {
  const controller = readFileSync("src/extensionUiDialogs.ts", "utf8");
  for (const action of ["allow", "block"]) {
    const id = `pi.extensionDialog.${action}`;
    assert.ok(controller.includes(`"${id}"`));
    assert.equal(
      manifest.contributes.commands.find((item) => item.command === id)?.enablement,
      "isWorkspaceTrusted && pi.extensionConfirmationActive",
    );
    assert.equal(
      manifest.contributes.menus["editor/title"].find((item) => item.command === id)?.when,
      "pi.extensionConfirmationActive",
    );
  }
});

test("quick-fix menu contributions are hidden for read-only editors", () => {
  for (const menu of ["editor/title", "editor/context"]) {
    const contribution = manifest.contributes.menus[menu].find((item) => item.command === "pi.quickFix");

    assert.ok(contribution, `missing Pi quick fix contribution in ${menu}`);
    assert.match(contribution.when ?? "", /(?:^|&&)\s*!editorReadonly(?:\s*&&|$)/);
  }
});

test("development launchers target the intended extension mode", () => {
  const launch = JSON.parse(readFileSync(".vscode/launch.json", "utf8")) as {
    configurations: { type: string; args: string[] }[];
  };
  const hosts = launch.configurations.filter((configuration) => configuration.type === "extensionHost");
  assert.ok(hosts.length > 0, "missing Extension Development Host configuration");
  for (const host of hosts) {
    assert.deepEqual(host.args, ["--extensionDevelopmentPath=${workspaceFolder}"]);
  }

  assert.equal(manifest.scripts.dev, "npm run install:extension && node scripts/open-dev-window.mjs");
  assert.equal(manifest.scripts["dev:pi"], "pi -ne -e resources/pi-bridge.ts");
});
