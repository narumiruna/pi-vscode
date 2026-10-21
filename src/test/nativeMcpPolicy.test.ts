import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";
import { buildAgentPrompt } from "../prompts";

type GateResult = { block: true; reason: string } | undefined;
type Handler = (event?: unknown) => GateResult;

// Handler contract only: server annotations are unverified and cannot widen the packaged allowlist.
test("focused packaged policy blocks MCP tools and indirect entry points regardless of server hints", async () => {
  const source = readFileSync(path.resolve(__dirname, "../../resources/pi-read-only-gate.ts"), "utf8");
  const javascript = stripTypeScriptTypes(
    source.replace(
      'import * as piPackage from "@earendil-works/pi-coding-agent";',
      'const piPackage = { VERSION: "1.3.0" };',
    ),
  );
  const { default: gate } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
  const handlers = new Map<string, Handler>();
  const original = [
    "read",
    "mcp__fixture__mutate",
    "mcp__fixture__echo",
    "read_mcp_resource",
    "codemode",
    "tool_search",
  ];
  let active = [...original];
  const commands = new Set<string>();
  gate({
    registerCommand: (name: string) => commands.add(name),
    on: (name: string, handler: Handler) => handlers.set(name, handler),
    getActiveTools: () => active,
    setActiveTools: (tools: string[]) => {
      active = tools;
    },
    getAllTools: () => original.map((name) => ({ name, annotations: { readOnlyHint: true } })),
  });
  assert.equal(commands.has("vscode-pi-read-only-ready"), true);
  const invoke = (name: string, event?: unknown) => {
    const handler = handlers.get(name);
    assert.ok(handler, `Missing packaged handler: ${name}`);
    return handler(event);
  };
  const call = (toolName: string, parentToolCallId?: string) => invoke("tool_call", { toolName, parentToolCallId });
  assert.equal(call("mcp__fixture__mutate"), undefined, "Ordinary requests retain existing MCP permission behavior");
  invoke("before_agent_start", { prompt: buildAgentPrompt("review", [], undefined, "read-only") });
  assert.deepEqual(active, ["read"]);
  for (const name of original.slice(1)) {
    for (const parent of [undefined, "codemode-parent"]) {
      const result = call(name, parent);
      assert.ok(result, name);
      assert.equal(result.block, true, name);
      assert.match(result.reason, /preview-only/);
    }
  }
  assert.equal(call("read"), undefined);
  invoke("before_agent_start", { prompt: "ordinary request cannot end an active focused policy" });
  assert.equal(call("mcp__fixture__mutate")?.block, true);
  invoke("agent_settled");
  assert.deepEqual(active, original);
  assert.equal(call("mcp__fixture__mutate"), undefined);
  invoke("before_agent_start", { prompt: buildAgentPrompt("review", [], undefined, "read-only") });
  invoke("session_shutdown");
  assert.deepEqual(active, original);
  assert.equal(call("mcp__fixture__mutate"), undefined);
});
