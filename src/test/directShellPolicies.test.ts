import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";

async function policy(
  name: string,
  version: string | null = "1.3.0",
): Promise<{ handlers: Map<string, (...args: any[]) => any>; commands: Map<string, any> }> {
  const source = readFileSync(path.resolve(__dirname, `../../resources/${name}.ts`), "utf8").replace(
    'import * as piPackage from "@earendil-works/pi-coding-agent";',
    `const piPackage = ${version === null ? "{}" : JSON.stringify({ VERSION: version })};`,
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
const cwd = realpathSync(path.resolve(__dirname, "../.."));
const event = { type: "user_bash", command: "printf harmless", cwd, excludeFromContext: true };
const context = (confirm: (...args: any[]) => any) => ({
  mode: "rpc",
  hasUI: true,
  cwd,
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

test("native TUI shell always requires full untimed approval, independent of tool mode and context inclusion", async () => {
  const original = process.env.PI_VSCODE_PERMISSION_MODE;
  try {
    const { handlers } = await policy("pi-permission-gate");
    const readOnly = await policy("pi-read-only-gate");
    for (const permissionMode of ["off", "dangerous", "all"]) {
      process.env.PI_VSCODE_PERMISSION_MODE = permissionMode;
      for (const excludeFromContext of [false, true]) {
        const command = `printf '日本語'\n${"# full review text\n".repeat(400)}printf END`;
        const shell = { ...event, command, excludeFromContext };
        let calls = 0;
        const ctx = {
          ...context(async (...args) => {
            calls++;
            assert.equal(args.length, 2, "Native review must not inherit the RPC five-second timeout");
            assert.equal(args[0], "Allow direct shell command?");
            assert.match(args[1], new RegExp(excludeFromContext ? "!! \\(excluded" : "! \\(included"));
            assert.ok(args[1].includes(`Working directory (canonical): ${cwd}`));
            assert.ok(args[1].endsWith(`Full command:\n${command}`), "No command truncation");
            return true;
          }),
          mode: "tui",
        };
        assert.equal(await handlers.get("user_bash")!(shell, ctx), undefined);
        assert.equal(calls, 1);
        // Simulate Pi's propagation: approval must not replace execution and
        // bypass the independently packaged preview-only handler.
        readOnly.handlers.get("before_agent_start")!({ prompt: "<<<PI_VSCODE_POLICY: read-only>>>\nrequest" });
        assert.throws(() => readOnly.handlers.get("user_bash")!(shell, ctx), /preview-only/);
        readOnly.handlers.get("agent_settled")!();
      }
    }
  } finally {
    if (original === undefined) delete process.env.PI_VSCODE_PERMISSION_MODE;
    else process.env.PI_VSCODE_PERMISSION_MODE = original;
  }
});

test("native TUI rejection, cancellation, missing UI, unsupported modes and errors throw", async () => {
  const { handlers } = await policy("pi-permission-gate");
  const bash = handlers.get("user_bash")!;
  for (const result of [false, undefined, null, "true", {}]) {
    await assert.rejects(bash(event, { ...context(async () => result), mode: "tui" }), /blocked/);
  }
  for (const mode of ["tui", "rpc", "print", "json", "unknown"]) {
    const ctx = { ...context(() => assert.fail("No approval UI expected")), mode };
    await assert.rejects(bash(event, { ...ctx, hasUI: false }), /approval UI/);
    if (mode !== "tui" && mode !== "rpc") await assert.rejects(bash(event, ctx), /approval UI/);
  }
  await assert.rejects(
    bash(event, {
      ...context(async () => {
        throw new Error("native UI failed");
      }),
      mode: "tui",
    }),
    /native UI failed/,
  );
});

test("approval cannot survive session, cwd, UI, request or cancellation changes", async () => {
  const { handlers } = await policy("pi-permission-gate");
  const bash = handlers.get("user_bash")!;
  for (const mode of ["tui", "rpc"]) {
    for (const change of [
      "session",
      "manager",
      "shutdown",
      "start",
      "cwd",
      "mode",
      "ui",
      "hasUI",
      "command",
      "context",
      "eventCwd",
      "abort",
    ]) {
      const shell = { ...event };
      const abort = new AbortController();
      const ctx = { ...context(async () => true), mode, signal: abort.signal };
      ctx.ui.confirm = async () => {
        // Approval is deliberately asynchronous; checks must run after it.
        await Promise.resolve();
        if (change === "session") ctx.sessionManager.getSessionId = () => "replacement";
        if (change === "manager") ctx.sessionManager = { getSessionId: () => "fixture-session" };
        if (change === "shutdown") handlers.get("session_shutdown")!();
        if (change === "start") handlers.get("session_start")!();
        if (change === "cwd") ctx.cwd = path.dirname(cwd);
        if (change === "mode") ctx.mode = "print";
        if (change === "ui") ctx.ui = { confirm: async () => true };
        if (change === "hasUI") ctx.hasUI = false;
        if (change === "command") shell.command = "printf replacement";
        if (change === "context") shell.excludeFromContext = false;
        if (change === "eventCwd") shell.cwd = path.dirname(cwd);
        if (change === "abort") abort.abort();
        return true;
      };
      await assert.rejects(bash(shell, ctx), /stale/, `${mode}: ${change}`);
    }
  }
});

test("native approval reviews canonical cwd and rejects alias replacement after review", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "pi-native-shell-policy-"));
  try {
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    const alias = path.join(root, "alias");
    mkdirSync(first);
    mkdirSync(second);
    symlinkSync(first, alias, "junction");
    const { handlers } = await policy("pi-permission-gate");
    let replace = false;
    const ctx = {
      ...context(async (_title, message) => {
        assert.ok(message.includes(`Working directory (canonical): ${realpathSync(first)}`));
        if (replace) {
          rmSync(alias);
          symlinkSync(second, alias, "junction");
        }
        return true;
      }),
      mode: "tui",
      cwd: alias,
    };
    assert.equal(await handlers.get("user_bash")!({ ...event, cwd: alias }, ctx), undefined);
    replace = true;
    await assert.rejects(handlers.get("user_bash")!({ ...event, cwd: alias }, ctx), /stale/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("native shell bounds and mismatched cwd reject before showing an approval", async () => {
  const { handlers } = await policy("pi-permission-gate");
  const ctx = { ...context(() => assert.fail("Invalid request must not prompt")), mode: "tui" };
  for (const shell of [
    { ...event, command: " " },
    { ...event, command: "x".repeat(8_001) },
    { ...event, command: "printf \u001b[31m" },
    { ...event, command: "printf \u202ehidden" },
    { ...event, cwd: "relative" },
    { ...event, cwd: `/${"x".repeat(8_193)}` },
    { ...event, cwd: `${cwd}\n` },
    { ...event, cwd: path.dirname(cwd) },
    { ...event, excludeFromContext: undefined },
  ]) {
    await assert.rejects(handlers.get("user_bash")!(shell, ctx), /bounds|invalid|stale/);
  }
});

test("missing VERSION leaves ordinary tool policy usable but direct shell fails closed", async () => {
  const original = process.env.PI_VSCODE_PERMISSION_MODE;
  try {
    process.env.PI_VSCODE_PERMISSION_MODE = "all";
    for (const version of [null, "1.2.0"]) {
      const { handlers, commands } = await policy("pi-permission-gate", version);
      assert.ok(commands.has("vscode-pi-permission-ready"));
      const ctx = { ...context(async () => true), mode: "tui" };
      await assert.rejects(handlers.get("user_bash")!(event, ctx), /verified Pi 1.3.0/);
      assert.equal(
        await handlers.get("tool_call")!({ toolName: "bash", input: { command: "printf harmless" } }, ctx),
        undefined,
      );
      ctx.ui.confirm = async () => false;
      assert.deepEqual(
        await handlers.get("tool_call")!({ toolName: "bash", input: { command: "printf harmless" } }, ctx),
        {
          block: true,
          reason: "Blocked bash by user.",
        },
      );
    }
  } finally {
    if (original === undefined) delete process.env.PI_VSCODE_PERMISSION_MODE;
    else process.env.PI_VSCODE_PERMISSION_MODE = original;
  }
});
