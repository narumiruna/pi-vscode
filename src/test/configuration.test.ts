import assert from "node:assert/strict";
import type { Uri } from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("Pi settings read only the pi namespace and preserve resource scope and explicit values", () => {
  const vscode = installVscodeMock();
  const resource = MockUri.file("/tmp/project/file.ts") as unknown as Uri;
  const calls: Array<{ section: string; resource: unknown }> = [];
  const values = new Map<string, unknown>();
  vscode.workspace.getConfiguration = (section: string, requestedResource: unknown) => {
    calls.push({ section, resource: requestedResource });
    const namespace = section === "pi" || section === "pi.inlineCompletions";
    return {
      get: (key: string, fallback: unknown) => {
        if (!namespace) throw new Error(`Unexpected settings namespace: ${section}`);
        const qualifiedKey = section === "pi.inlineCompletions" ? `inlineCompletions.${key}` : key;
        return values.get(qualifiedKey) ?? fallback;
      },
    };
  };

  try {
    const { piConfiguration } = require("../configuration") as typeof import("../configuration");
    assert.equal(piConfiguration().get("agent.confirmToolCalls", "dangerous"), "dangerous");
    assert.equal(piConfiguration("inlineCompletions", resource).get("enabled", false), false);

    values.set("agent.confirmToolCalls", "all");
    values.set("inlineCompletions.enabled", true);
    assert.equal(piConfiguration().get("agent.confirmToolCalls", "dangerous"), "all");
    assert.equal(piConfiguration("inlineCompletions", resource).get("enabled", false), true);

    values.set("agent.confirmToolCalls", "off");
    values.set("inlineCompletions.enabled", false);
    assert.equal(piConfiguration().get("agent.confirmToolCalls", "dangerous"), "off");
    assert.equal(piConfiguration("inlineCompletions", resource).get("enabled", true), false);
    assert.deepEqual(calls, [
      { section: "pi", resource: undefined },
      { section: "pi.inlineCompletions", resource },
      { section: "pi", resource: undefined },
      { section: "pi.inlineCompletions", resource },
      { section: "pi", resource: undefined },
      { section: "pi.inlineCompletions", resource },
    ]);
  } finally {
    vscode.restore();
  }
});
