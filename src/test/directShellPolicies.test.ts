import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

async function policy(version: string | null = "1.3.0") {
  const source = readFileSync(path.resolve(__dirname, "../../resources/pi-read-only-gate.ts"), "utf8").replace(
    'import * as piPackage from "@earendil-works/pi-coding-agent";',
    `const piPackage = ${version === null ? "{}" : JSON.stringify({ VERSION: version })};`,
  );
  const javascript = stripTypeScriptTypes(source);
  const { default: factory } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  let tools = ["read", "bash", "write", "edit", "vscode_annotate", "custom_mutation"];
  const changes: string[][] = [];
  factory({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getActiveTools: () => [...tools],
    setActiveTools: (value: string[]) => {
      tools = [...value];
      changes.push([...value]);
    },
  });
  return { handlers, commands, tools: () => tools, changes };
}

const marker = "<<<PI_VSCODE_POLICY: read-only>>>";
const context = {
  mode: "rpc",
  hasUI: true,
  ui: { confirm: () => assert.fail("The read-only policy must not request confirmation") },
};

test("ordinary mutating tools and direct shell continue without policy UI", async () => {
  const { handlers, changes } = await policy();
  for (const toolName of ["bash", "edit", "write", "custom_mutation"]) {
    assert.equal(await handlers.get("tool_call")!({ toolName, input: {} }, context), undefined);
  }
  for (const mode of ["rpc", "tui", "print"]) {
    for (const excludeFromContext of [false, true]) {
      assert.equal(
        await handlers.get("user_bash")!({ command: "printf harmless", excludeFromContext }, { ...context, mode }),
        undefined,
      );
    }
  }
  assert.deepEqual(changes, []);
});

test("preview-only policy blocks mutating tools and user_bash while retaining read-only tools", async () => {
  const p = await policy();
  p.handlers.get("before_agent_start")!({ prompt: `${marker}\nrequest` }, context);
  assert.deepEqual(p.tools(), ["read", "vscode_annotate"]);
  for (const toolName of ["bash", "edit", "write", "custom_mutation"]) {
    assert.deepEqual(p.handlers.get("tool_call")!({ toolName }, context), {
      block: true,
      reason: `Blocked ${toolName}: this VS Code editor action is preview-only.`,
    });
  }
  for (const toolName of ["read", "grep", "find", "ls", "vscode_context", "vscode_code_context", "vscode_annotate"]) {
    assert.equal(p.handlers.get("tool_call")!({ toolName }, context), undefined);
  }
  assert.throws(() => p.handlers.get("user_bash")!({}, context), /preview-only/);
});

test("read-only marker requires the exact prompt prefix", async () => {
  const p = await policy();
  for (const prompt of [marker, ` ${marker}\nrequest`, `request\n${marker}\n`, `${marker} extra\nrequest`]) {
    p.handlers.get("before_agent_start")!({ prompt }, context);
    assert.equal(p.handlers.get("tool_call")!({ toolName: "write" }, context), undefined);
    assert.equal(p.handlers.get("user_bash")!({}, context), undefined);
  }
  assert.deepEqual(p.changes, []);
});

test("settlement and shutdown restore the original tools once, including repeated preview starts", async () => {
  for (const cleanup of ["agent_settled", "session_shutdown"]) {
    const p = await policy();
    const original = [...p.tools()];
    for (let cycle = 0; cycle < 2; cycle++) {
      p.handlers.get("before_agent_start")!({ prompt: `${marker}\nrequest` }, context);
      p.handlers.get("before_agent_start")!({ prompt: `${marker}\nsecond request` }, context);
      assert.deepEqual(p.tools(), ["read", "vscode_annotate"]);
      p.handlers.get(cleanup)!();
      assert.deepEqual(p.tools(), original);
      assert.equal(p.handlers.get("user_bash")!({}, context), undefined);
      assert.equal(p.handlers.get("tool_call")!({ toolName: "write" }, context), undefined);
      const count = p.changes.length;
      p.handlers.get(cleanup)!();
      assert.equal(p.changes.length, count, "Cleanup must not restore an expired tool snapshot");
    }
  }
});

test("discovery metadata reports the actual package VERSION without a permission sentinel", async () => {
  for (const version of ["1.3.0", "1.2.0", null]) {
    const p = await policy(version);
    assert.deepEqual([...p.commands.keys()], ["vscode-pi-read-only-ready"]);
    const command = p.commands.get("vscode-pi-read-only-ready");
    assert.equal(command.description, `VS Code read-only direct-shell policy v1; Pi ${version ?? "undefined"}`);
    await assert.rejects(command.handler(), /discovery-only/);
    assert.equal(p.handlers.get("user_bash")!({}, context), undefined);
    p.handlers.get("before_agent_start")!({ prompt: `${marker}\nrequest` }, context);
    assert.throws(() => p.handlers.get("user_bash")!({}, context), /preview-only/);
  }
});
