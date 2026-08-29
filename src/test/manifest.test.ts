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
