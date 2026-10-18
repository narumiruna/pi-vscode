import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import path from "node:path";

async function policy(
  name: string,
  version = "1.3.0",
): Promise<{ handlers: Map<string, (...args: any[]) => any>; commands: Map<string, any> }> {
  const source = readFileSync(path.resolve(__dirname, `../../resources/${name}.ts`), "utf8").replace(
    'import * as piPackage from "@earendil-works/pi-coding-agent";',
    `const piPackage = { VERSION: ${JSON.stringify(version)} };`,
  );
  const javascript = stripTypeScriptTypes(source);
  const { default: factory } = await import(`data:text/javascript,${encodeURIComponent(javascript)}`);
  const handlers = new Map<string, (...args: any[]) => any>();
  const commands = new Map<string, any>();
  factory({
    on: (event: string, handler: (...args: any[]) => any) => handlers.set(event, handler),
    registerCommand: (name: string, options: any) => commands.set(name, options),
    getActiveTools: () => ["read", "bash"],
    setActiveTools() {},
  });
  return { handlers, commands };
}
const event = { type: "user_bash", command: "printf harmless", cwd: "/fixture", excludeFromContext: true };
const context = (confirm: (...args: any[]) => any) => ({
  mode: "rpc",
  hasUI: true,
  ui: { confirm },
  sessionManager: { getSessionId: () => "fixture-session" },
});

test("packaged user_bash uses its own throw/undefined contract and requires approval in every tool mode", async () => {
  const original = process.env.PI_VSCODE_PERMISSION_MODE;
  try {
    const { handlers, commands } = await policy("pi-permission-gate");
    assert.match(commands.get("vscode-pi-permission-ready").description, /Pi 1.3.0/);
    await assert.rejects(commands.get("vscode-pi-permission-ready").handler(), /metadata/);
    for (const mode of ["off", "dangerous", "all"]) {
      process.env.PI_VSCODE_PERMISSION_MODE = mode;
      let calls = 0;
      const ctx = context(async (title, payload, options) => {
        calls++;
        assert.equal(title, "PI_VSCODE_DIRECT_SHELL_V1");
        assert.deepEqual(JSON.parse(payload), {
          command: event.command,
          cwd: event.cwd,
          excludeFromContext: true,
          sessionId: "fixture-session",
        });
        assert.equal(options.timeout, 5_000);
        return true;
      });
      assert.equal(await handlers.get("user_bash")!(event, ctx), undefined);
      assert.equal(calls, 1);
      await assert.rejects(
        handlers.get("user_bash")!(
          event,
          context(async () => false),
        ),
        /blocked/,
      );
    }
  } finally {
    if (original === undefined) delete process.env.PI_VSCODE_PERMISSION_MODE;
    else process.env.PI_VSCODE_PERMISSION_MODE = original;
  }
});

test("missing UI, handler errors, stale session, unsupported runtime and read-only policy never authorize shell", async () => {
  const { handlers } = await policy("pi-permission-gate");
  const bash = handlers.get("user_bash")!;
  await assert.rejects(bash(event, { ...context(async () => true), hasUI: false }), /approval UI/);
  await assert.rejects(bash(event, { ...context(async () => true), mode: "print" }), /approval UI/);
  await assert.rejects(
    bash(
      event,
      context(async () => {
        throw new Error("fixture UI failure");
      }),
    ),
    /fixture UI failure/,
  );
  const stale = context(async () => {
    stale.sessionManager.getSessionId = () => "replacement";
    return true;
  });
  await assert.rejects(bash(event, stale), /stale/);
  const unsupported = await policy("pi-permission-gate", "1.2.0");
  await assert.rejects(
    unsupported.handlers.get("user_bash")!(
      event,
      context(() => assert.fail("No UI in unsupported runtime")),
    ),
    /verified Pi 1.3.0/,
  );
  const readOnly = await policy("pi-read-only-gate");
  assert.equal(readOnly.handlers.get("user_bash")!(), undefined);
  readOnly.handlers.get("before_agent_start")!({ prompt: "<<<PI_VSCODE_POLICY: read-only>>>\nrequest" });
  assert.throws(() => readOnly.handlers.get("user_bash")!(), /preview-only/);
  readOnly.handlers.get("agent_settled")!();
  assert.equal(readOnly.handlers.get("user_bash")!(), undefined);
});
