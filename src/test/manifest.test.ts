import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

interface MenuContribution {
  readonly command?: string;
  readonly when?: string;
}

interface ExtensionManifest {
  readonly engines: { readonly vscode: string };
  readonly extensionKind: readonly string[];
  readonly devDependencies: Record<string, string>;
  readonly contributes: {
    readonly commands: readonly { command: string; enablement?: string }[];
    readonly menus: Record<string, readonly MenuContribution[]>;
    readonly configuration: { readonly properties: Record<string, unknown> };
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as ExtensionManifest;

test("workflow commands are contributed, registered, documented and keep minimum stable workspace-host compatibility", () => {
  assert.equal(manifest.engines.vscode, "^1.106.0");
  assert.deepEqual(manifest.extensionKind, ["workspace"]);
  assert.equal(manifest.devDependencies["@types/vscode"], "1.106.0");
  assert.equal(manifest.contributes.configuration.properties["piCodingAgent.defaultMode"], undefined);
  assert.equal(existsSync("src/runtimeProfiles.ts"), false);
  assert.equal(existsSync("src/test/runtimeProfiles.test.ts"), false);
  const entry = readFileSync("src/extension.ts", "utf8"), readme = readFileSync("README.md", "utf8");
  for (const [command, controller, register] of [
    ["reviewStagedChanges", "gitReviewController", "registerGitReview"],
    ["showStagedFindings", "gitReviewController", "registerGitReview"],
    ["repairFailedTest", "testRepairController", "registerTestRepair"],
    ["askDebugContext", "debugContextController", "registerDebugContext"],
  ]) {
    const id = `piCodingAgent.${command}`;
    assert.match(manifest.contributes.commands.find(item => item.command === id)?.enablement ?? "", /isWorkspaceTrusted/);
    assert.ok(readFileSync(`src/${controller}.ts`, "utf8").includes(`\"${id}\"`));
    assert.ok(entry.includes(`${register}(context, runtime, conversation)`));
  }
  for (const label of ["Review Staged Changes", "Show Staged Findings", "Repair Failed Test (Preview)", "Ask Debug Context"]) assert.ok(readme.includes(`Pi: ${label}`));
});

test("quick-fix menu contributions are hidden for read-only editors", () => {
  for (const menu of ["editor/title", "editor/context"]) {
    const contribution = manifest.contributes.menus[menu]
      .find(item => item.command === "piCodingAgent.quickFix");

    assert.ok(contribution, `missing Pi quick fix contribution in ${menu}`);
    assert.match(contribution.when ?? "", /(?:^|&&)\s*!editorReadonly(?:\s*&&|$)/);
  }
});

test("development launchers disable the legacy Pi ID without disabling unrelated extensions", () => {
  const legacyFlag = "--disable-extension=narumitw.pi-coding-agent";
  const launch = JSON.parse(readFileSync(".vscode/launch.json", "utf8")) as {
    configurations: { type: string; args: string[] }[];
  };
  const hosts = launch.configurations.filter(configuration => configuration.type === "extensionHost");
  assert.ok(hosts.length > 0, "missing Extension Development Host configuration");
  for (const host of hosts) {
    assert.ok(host.args.includes(legacyFlag), "F5 must not activate both Pi extension IDs");
    assert.ok(host.args.includes("--extensionDevelopmentPath=${workspaceFolder}"));
    assert.deepEqual(host.args.filter(arg => arg.startsWith("--disable-extension")), [legacyFlag]);
  }

  const recipes = readFileSync("justfile", "utf8");
  const dev = /^dev:\n((?:[ \t].*\n)+)/m.exec(recipes)?.[1];
  assert.ok(dev, "missing just dev recipe");
  const launchLine = dev.split("\n").find(line => line.trimStart().startsWith("code "));
  assert.ok(launchLine, "just dev must launch VS Code");
  assert.ok(launchLine.includes(legacyFlag));
  assert.ok(launchLine.includes('--extensionDevelopmentPath="{{justfile_directory()}}"'));
  assert.deepEqual(launchLine.match(/--disable-extension\S*/g), [legacyFlag]);
});
