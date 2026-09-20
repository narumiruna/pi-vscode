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
    readonly viewsContainers: { readonly secondarySidebar: readonly { readonly title: string }[] };
    readonly commands: readonly { command: string; title: string; category: string; enablement?: string }[];
    readonly chatParticipants: readonly { readonly name: string; readonly fullName: string }[];
    readonly submenus: readonly { readonly label: string }[];
    readonly menus: Record<string, readonly MenuContribution[]>;
    readonly configuration: { readonly title: string; readonly properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as ExtensionManifest;

test("extension identity stays consistent across packaging, settings, and documentation", () => {
  assert.equal(manifest.name, "pi-coding-agent-vscode");
  assert.equal(manifest.displayName, "Pi");
  assert.equal(manifest.contributes.viewsContainers.secondarySidebar[0].title, "Pi");
  assert.ok(manifest.contributes.commands.every(command => command.category === "Pi" && !command.title.includes("PiCode")));
  assert.deepEqual(manifest.contributes.chatParticipants.map(({ name, fullName }) => ({ name, fullName })), [{ name: "pi", fullName: "Pi" }]);
  assert.ok(manifest.contributes.submenus.every(submenu => submenu.label === "Pi"));
  assert.equal(manifest.contributes.configuration.title, "Pi");
  assert.equal(manifest.publisher, "narumi");
  const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
  assert.equal(lock.name, manifest.name);
  assert.equal(lock.packages[""].name, manifest.name);
  const id = `${manifest.publisher}.${manifest.name}`;
  assert.ok(readFileSync("src/editorActions.ts", "utf8").includes(`"@ext:${id}"`));
  assert.ok(readFileSync("README.md", "utf8").includes(`The extension ID is \`${id}\``));
  assert.ok(manifest.scripts.package.includes(`--out ${manifest.name}.vsix`));
  assert.ok(readFileSync("justfile", "utf8").includes(`/${manifest.name}.vsix`));
  assert.ok(manifest.contributes.commands.every(command => command.command.startsWith("picode.")));
  assert.ok(Object.keys(manifest.contributes.configuration.properties).every(key => key.startsWith("picode.")));
  for (const path of ["resources/picode.svg", "resources/picode-bridge.ts", "resources/picode-permission-gate.ts", "resources/picode-read-only-gate.ts", "scripts/remove-legacy-picode-extension.mjs"]) {
    assert.equal(existsSync(path), true, `missing Pi asset: ${path}`);
  }
  assert.equal(existsSync("scripts/install-picode-extension.mjs"), false);
  const recipes = readFileSync("justfile", "utf8");
  assert.ok(recipes.includes("scripts/remove-legacy-picode-extension.mjs"));
  assert.equal(recipes.includes("install-picode-extension"), false);
});

test("workflow commands are contributed, registered, documented and keep minimum stable workspace-host compatibility", () => {
  assert.equal(manifest.engines.vscode, "^1.106.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.devDependencies["@types/vscode"], "1.106.0");
  assert.equal(manifest.contributes.configuration.properties["picode.defaultMode"], undefined);
  assert.equal(existsSync("src/runtimeProfiles.ts"), false);
  assert.equal(existsSync("src/test/runtimeProfiles.test.ts"), false);
  const entry = readFileSync("src/extension.ts", "utf8"), readme = readFileSync("README.md", "utf8");
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
    const id = `picode.${command}`;
    assert.match(manifest.contributes.commands.find(item => item.command === id)?.enablement ?? "", /isWorkspaceTrusted/);
    assert.ok(readFileSync(`src/${controller}.ts`, "utf8").includes(`\"${id}\"`));
    assert.ok(entry.includes(`${register}(context, runtime, conversation)`));
  }
  for (const label of ["Review Changes", "Show Review Findings", "Fix Workspace Diagnostics (Preview)", "Review Staged Changes", "Show Staged Findings", "Repair Failed Test (Preview)", "Ask Debug Context"]) assert.ok(readme.includes(`Pi: ${label}`));
});

test("quick-fix menu contributions are hidden for read-only editors", () => {
  for (const menu of ["editor/title", "editor/context"]) {
    const contribution = manifest.contributes.menus[menu]
      .find(item => item.command === "picode.quickFix");

    assert.ok(contribution, `missing Pi quick fix contribution in ${menu}`);
    assert.match(contribution.when ?? "", /(?:^|&&)\s*!editorReadonly(?:\s*&&|$)/);
  }
});

test("development launchers target the intended extension mode", () => {
  const launch = JSON.parse(readFileSync(".vscode/launch.json", "utf8")) as {
    configurations: { type: string; args: string[] }[];
  };
  const hosts = launch.configurations.filter(configuration => configuration.type === "extensionHost");
  assert.ok(hosts.length > 0, "missing Extension Development Host configuration");
  for (const host of hosts) {
    assert.deepEqual(host.args, ["--extensionDevelopmentPath=${workspaceFolder}"]);
  }

  const recipes = readFileSync("justfile", "utf8");
  const dev = /^dev: install\n((?:[ \t].*\n)+)/m.exec(recipes)?.[1];
  assert.ok(dev, "missing just dev recipe with install dependency");
  const launchLine = dev.split("\n").find(line => line.trimStart().startsWith("code "));
  assert.ok(launchLine, "just dev must launch VS Code");
  assert.ok(launchLine.includes('--new-window "{{invocation_directory()}}"'));
  assert.equal(launchLine.includes("--extensionDevelopmentPath"), false);
});
