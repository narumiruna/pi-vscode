import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

interface MenuContribution {
  readonly command?: string;
  readonly when?: string;
}

interface ExtensionManifest {
  readonly contributes: {
    readonly menus: Record<string, readonly MenuContribution[]>;
  };
}

const manifest = JSON.parse(readFileSync("package.json", "utf8")) as ExtensionManifest;

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
