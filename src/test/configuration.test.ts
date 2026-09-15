import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("PiCode settings fall back to explicitly configured pre-rename values", () => {
  const vscode = installVscodeMock();
  const resource = MockUri.file("/tmp/project/file.ts");
  const calls: Array<{ section: string; resource: unknown }> = [];
  const currentExplicit = new Map<string, unknown>();
  const previousValues = new Map<string, unknown>([
    ["agent.confirmToolCalls", "all"],
    ["inlineCompletions.enabled", true],
  ]);
  vscode.workspace.getConfiguration = (section: string, requestedResource: unknown) => {
    calls.push({ section, resource: requestedResource });
    const isCurrent = section.startsWith("picode");
    return {
      get: (key: string, fallback: unknown) => {
        const qualifiedKey = section.endsWith(".inlineCompletions") ? `inlineCompletions.${key}` : key;
        return (isCurrent ? currentExplicit : previousValues).get(qualifiedKey) ?? fallback;
      },
      inspect: (key: string) => ({
        key,
        ...(isCurrent && currentExplicit.has(section.endsWith(".inlineCompletions") ? `inlineCompletions.${key}` : key)
          ? { globalValue: currentExplicit.get(section.endsWith(".inlineCompletions") ? `inlineCompletions.${key}` : key) }
          : {}),
      }),
    };
  };

  try {
    const { picodeConfiguration } = require("../configuration") as typeof import("../configuration");
    assert.equal(picodeConfiguration().get("agent.confirmToolCalls", "dangerous"), "all");
    assert.equal(picodeConfiguration("inlineCompletions", resource as any).get("enabled", false), true);

    currentExplicit.set("agent.confirmToolCalls", "off");
    currentExplicit.set("inlineCompletions.enabled", false);
    assert.equal(picodeConfiguration().get("agent.confirmToolCalls", "dangerous"), "off");
    assert.equal(picodeConfiguration("inlineCompletions", resource as any).get("enabled", true), false);

    assert.ok(calls.some(call => call.section === "picode.inlineCompletions" && call.resource === resource));
    assert.ok(calls.some(call => call.section === "piCodingAgent.inlineCompletions" && call.resource === resource));
  } finally {
    vscode.restore();
  }
});
