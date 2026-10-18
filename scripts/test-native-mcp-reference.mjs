// Usage: node scripts/test-native-mcp-reference.mjs /explicit/path/to/pi/dist/cli.js
// Actual Pi CLI/RPC, local stdio servers, and fixed in-process provider responses. No live model.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = process.argv[2];
assert.ok(cli && path.isAbsolute(cli), "Supply an explicit absolute Pi 1.3.0 dist/cli.js path");
assert.equal(JSON.parse(await readFile(path.resolve(path.dirname(cli), "../package.json"), "utf8")).version, "1.3.0");
assert.notEqual(process.platform, "win32", "This process-group reference fixture requires POSIX");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-mcp-reference-")));
const agent = path.join(root, "agent");
const cwd = path.join(root, "workspace");
const log = path.join(root, "stdio.jsonl");
const children = new Set();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const env = {
  HOME: root,
  PATH: path.dirname(process.execPath),
  PI_CODING_AGENT_DIR: agent,
  XDG_CONFIG_HOME: path.join(root, "config"),
  XDG_CACHE_HOME: path.join(root, "cache"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  NO_COLOR: "1",
  TMPDIR: root,
};
const common = [
  "--offline",
  "--no-approve",
  "--no-skills",
  "--no-prompt-templates",
  "--no-themes",
  "--no-context-files",
];
const entry = (exposure, mode = "normal") => ({
  command: process.execPath,
  args: [path.join(repository, "scripts/fixtures/mcp-stdio.mjs"), log, mode],
  exposure,
  timeout: 1,
});
const readLog = async () => (await readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
const text = (result) =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
function signal(child, value) {
  try {
    process.kill(-child.pid, value);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function launch(args, extra = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd,
    env: { ...env, ...extra },
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.add(child);
  child.stderr.setEncoding("utf8");
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, sig) => resolve({ code, signal: sig }));
  });
  const timer = setTimeout(() => signal(child, "SIGKILL"), 90000);
  done.finally(() => clearTimeout(timer));
  return { child, done, stderr: () => stderr };
}
async function close(run) {
  run.child.stdin.end();
  const timer = setTimeout(() => signal(run.child, "SIGKILL"), 5000);
  try {
    assert.equal((await run.done).code, 0, run.stderr());
  } finally {
    clearTimeout(timer);
    children.delete(run.child);
  }
}
function rpc(extraArgs = [], extraEnv = {}) {
  const run = launch(
    [
      ...common,
      "--mode",
      "rpc",
      "--no-session",
      "--no-extensions",
      "--extension",
      "builtin:mcp",
      "--extension",
      "builtin:codemode",
      "--extension",
      "builtin:tool-search",
      "--extension",
      path.join(repository, "scripts/fixtures/mcp-reference.ts"),
      "--extension",
      path.join(repository, "resources/pi-read-only-gate.ts"),
      "--provider",
      "mcp-fixture",
      "--model",
      "fixed",
      ...extraArgs,
    ],
    extraEnv,
  );
  let buffer = "";
  let serial = 0;
  let failure;
  const pending = new Map();
  const events = [];
  run.child.stdout.setEncoding("utf8");
  const fail = (error) => {
    failure = error;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    pending.clear();
  };
  run.child.stdout.on("data", (chunk) => {
    try {
      buffer += chunk;
      assert.ok(buffer.length < 2 * 1024 * 1024, "Bounded RPC frame");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const event = JSON.parse(line);
        const waiter = event.type === "response" && pending.get(event.id);
        if (waiter) {
          clearTimeout(waiter.timer);
          pending.delete(event.id);
          if (event.success) waiter.resolve(event.data);
          else waiter.reject(new Error(event.error));
        } else {
          assert.ok(events.length < 10000, "Bounded RPC event retention");
          events.push(event);
        }
      }
    } catch (error) {
      fail(error);
      signal(run.child, "SIGKILL");
    }
  });
  run.done.then(() => fail(new Error(`Pi exited: ${run.stderr()}`)), fail);
  const command = (type, fields = {}) =>
    new Promise((resolve, reject) => {
      if (failure) {
        reject(failure);
        return;
      }
      const id = String(++serial);
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${type} deadline: ${run.stderr()}`));
      }, 20000);
      pending.set(id, { resolve, reject, timer });
      run.child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    });
  const prompt = async (message) => {
    const response = await command("prompt", { message });
    assert.equal(response.disposition, "handled", message);
  };
  return {
    ...run,
    events,
    command,
    prompt,
    async snapshot() {
      const start = events.length;
      await prompt("/fixture-snapshot");
      const event = events.slice(start).find((event) => event.message?.startsWith("FIXTURE_SNAPSHOT "));
      assert.ok(event, "Fixture snapshot command must complete");
      return JSON.parse(event.message.slice("FIXTURE_SNAPSHOT ".length));
    },
    async call(name, args, marker = false) {
      await prompt(`/fixture-plan ${JSON.stringify([{ name, arguments: args }])}`);
      const start = events.length;
      const response = await command("prompt", {
        message: `${marker ? "<<<PI_VSCODE_POLICY: read-only>>>\n" : ""}fixture run`,
      });
      assert.equal(response.disposition, "started");
      const deadline = Date.now() + 20000;
      while (!events.slice(start).some((event) => event.type === "agent_settled")) {
        if (failure) throw failure;
        assert.ok(Date.now() < deadline, `Tool ${name} settlement deadline`);
        await sleep(10);
      }
      const result = events
        .slice(start)
        .find((event) => event.type === "tool_execution_end" && event.toolName === name);
      assert.ok(result, `No actual tool result for ${name}: ${JSON.stringify(events.slice(start))}`);
      return result;
    },
  };
}
async function waitTools(pi, names) {
  const deadline = Date.now() + 15000;
  while (true) {
    const snapshot = await pi.snapshot();
    if (names.every((name) => snapshot.tools.some((tool) => tool.name === name))) return snapshot;
    assert.ok(Date.now() < deadline, `MCP registration deadline: ${JSON.stringify(snapshot)}`);
    await sleep(25);
  }
}
function assertExposures(snapshot, searched = false) {
  const tool = (name) => snapshot.tools.find((tool) => tool.name === name);
  assert.equal(snapshot.trusted, false);
  for (const [server, exposure] of [
    ["direct", "direct"],
    ["deferred", "deferred"],
    ["codemode", "deferred"],
    ["hidden", "hidden"],
  ]) {
    assert.equal(tool(`mcp__${server}__echo`)?.exposure, exposure, `${server} effective exposure`);
    assert.equal(
      snapshot.active.includes(`mcp__${server}__echo`),
      exposure === "direct" || (searched && server === "deferred"),
    );
  }
  for (const [name, exposure] of [
    ["echo", "direct"],
    ["get_alpha", "deferred"],
    ["get_exact", "direct"],
    ["mutate", "hidden"],
  ]) {
    assert.equal(tool(`mcp__mixed__${name}`)?.exposure, exposure, `per-tool ${name}`);
    assert.equal(
      snapshot.active.includes(`mcp__mixed__${name}`),
      exposure === "direct",
      `per-tool ${name} declaration`,
    );
  }
  assert.equal(tool("mcp__direct__echo").annotations.readOnlyHint, true);
  assert.equal(tool("mcp__direct__mutate").annotations.destructiveHint, true);
  for (const name of ["codemode", "tool_search", "list_mcp_resources", "read_mcp_resource"])
    assert.ok(snapshot.active.includes(name), `Inherited ${name}`);
}
try {
  await mkdir(agent);
  await mkdir(cwd);
  await mkdir(path.join(cwd, ".pi"));
  await writeFile(log, "");
  await writeFile(
    path.join(agent, "settings.json"),
    JSON.stringify({
      defaultProjectTrust: "never",
      cacheWarming: "off",
      enableInstallTelemetry: false,
      compaction: { enabled: false },
      retry: { enabled: false },
    }),
  );
  await writeFile(path.join(cwd, ".pi/mcp.json"), JSON.stringify({ mcpServers: { unapproved: entry("direct") } }));
  const config = { mcpServers: {} };
  await writeFile(path.join(agent, "mcp.json"), JSON.stringify(config));
  const pi = rpc();
  const initial = await pi.command("get_state");
  assert.equal(
    (await pi.snapshot()).tools.some((tool) => tool.name.startsWith("mcp__")),
    false,
  );
  for (const exposure of ["direct", "deferred", "codemode", "hidden"]) config.mcpServers[exposure] = entry(exposure);
  config.mcpServers.mixed = {
    ...entry("hidden"),
    toolExposure: {
      echo: "direct",
      "get_*": "codemode",
      get_exact: "direct",
      mutate: "hidden",
    },
  };
  config.mcpServers.disabled = { ...entry("direct"), enabled: false };
  await writeFile(path.join(agent, "mcp.json"), JSON.stringify(config));
  assert.deepEqual(await readLog(), [], "Saving configuration starts no server");
  await pi.prompt("/fixture-reload");
  const snapshot = await waitTools(pi, ["mcp__mixed__get_exact", "read_mcp_resource"]);
  assertExposures(snapshot);
  assert.equal((await pi.command("get_state")).sessionId, initial.sessionId);
  assert.equal(
    snapshot.tools.some((tool) => /mcp__(unapproved|disabled)__/.test(tool.name)),
    false,
  );
  const mcpOwner = (await pi.command("get_commands")).commands.find((command) => command.name === "mcp");
  assert.ok(mcpOwner?.sourceInfo.path.includes("builtin:mcp"), JSON.stringify(mcpOwner));
  const direct = await pi.call("mcp__direct__echo", {});
  assert.equal(direct.isError, false);
  assert.match(text(direct.result), /fixture:echo/);
  const declarations = (await pi.command("get_entries")).entries.filter(
    (entry) => entry.customType === "fixture-declarations",
  );
  assert.ok(declarations[0].data.includes("mcp__direct__echo"));
  for (const name of ["mcp__codemode__echo", "mcp__deferred__echo", "mcp__hidden__echo"])
    assert.equal(declarations[0].data.includes(name), false, `${name} not declared before discovery`);
  const code = await pi.call("codemode", {
    code: 'return { result: await tools.mcp__codemode__echo({}), deferred: await tools.mcp__deferred__echo({}), mixed: await tools.mcp__mixed__get_alpha({}), hidden: "mcp__hidden__echo" in tools, perToolHidden: "mcp__mixed__mutate" in tools, all: ALL_TOOLS.map(t => t.name).filter(n => n.startsWith("mcp__hidden__")) };',
  });
  assert.equal(
    code.isError,
    false,
    JSON.stringify({ result: code, schema: snapshot.tools.find((tool) => tool.name === "codemode").parameters }),
  );
  assert.match(text(code.result), /fixture:echo/);
  assert.match(text(code.result), /"hidden":false/);
  assert.match(text(code.result), /"perToolHidden":false/);
  assert.match(text(code.result), /"all":\[\]/);
  const hidden = await pi.call("codemode", { code: "return await tools.mcp__hidden__echo({});" });
  assert.equal(hidden.isError, true);
  assert.match(text(hidden.result), /does not exist/);
  const search = await pi.call("tool_search", { query: "+mcp__deferred__echo", limit: 1 });
  assert.equal(search.isError, false, text(search.result));
  assert.ok((await pi.snapshot()).active.includes("mcp__deferred__echo"), text(search.result));
  const deferred = await pi.call("mcp__deferred__echo", {});
  assert.equal(deferred.isError, false);
  const resources = await pi.call("list_mcp_resources", {});
  assert.equal(resources.isError, false);
  assert.match(text(resources.result), /fixture:\/\/note/);
  assert.deepEqual(
    JSON.parse(text(resources.result))
      .resources.map((item) => item.server)
      .sort(),
    // Per-tool overrides do not expose resources of a server whose own exposure is hidden.
    ["codemode", "deferred", "direct"],
  );
  assert.doesNotMatch(text(resources.result), /"server":\s*"hidden"/);
  const resource = await pi.call("read_mcp_resource", { server: "direct", uri: "fixture://note" });
  assert.equal(resource.isError, false);
  assert.match(text(resource.result), /fixture resource bytes/);
  const exactOverride = await pi.call("mcp__mixed__get_exact", {});
  assert.equal(exactOverride.isError, false);
  assert.match(text(exactOverride.result), /fixture:get_exact/);
  const perToolHidden = await pi.call("codemode", { code: "return await tools.mcp__mixed__mutate({});" });
  assert.equal(perToolHidden.isError, true);
  assert.match(text(perToolHidden.result), /does not exist/);
  const denied = await pi.call("mcp__direct__mutate", {}, true);
  assert.equal(denied.isError, true);
  assert.match(text(denied.result), /preview-only|not found|not available/i);
  assert.equal(
    (await readLog()).some((event) => event.method === "tools/call" && event.params.name === "mutate"),
    false,
  );
  await pi.prompt("/fixture-reload");
  assertExposures(await waitTools(pi, ["mcp__mixed__get_exact"]), true);
  await close(pi);
  const startsBefore = (await readLog()).filter((event) => event.event === "start").length;
  for (const replacement of [false, true]) {
    const other = rpc(replacement ? [] : ["--no-mcp"], replacement ? { MCP_FIXTURE_REPLACEMENT: "1" } : {});
    const commands = (await other.command("get_commands")).commands.filter((command) => command.name === "mcp");
    assert.equal(commands.length, replacement ? 1 : 0);
    if (replacement) {
      assert.equal(commands[0].sourceInfo.path, path.join(repository, "scripts/fixtures/mcp-reference.ts"));
      await other.prompt("/mcp");
      assert.ok(other.events.some((event) => event.message === '{"connected":true,"server":"forged"}'));
    }
    assert.equal(
      (await other.snapshot()).tools.some((tool) => tool.name.startsWith("mcp__")),
      false,
    );
    await close(other);
  }
  assert.equal(
    (await readLog()).filter((event) => event.event === "start").length,
    startsBefore,
    "Disabled/replaced builtin must not connect; arbitrary replacement output is not connection evidence",
  );
  await writeFile(
    path.join(agent, "mcp.json"),
    JSON.stringify({ mcpServers: { malformed: entry("direct", "malformed"), invalid: { command: 7 } } }),
  );
  // MCP subcommands reject --offline and --no-approve. PI_OFFLINE=1 and an isolated,
  // never-trusted project provide the same fixture restrictions. Shell MCP loads no extensions.
  const diagnostic = launch(["mcp", "list", "--json"]);
  diagnostic.child.stdin.end();
  let stdout = "";
  diagnostic.child.stdout.setEncoding("utf8");
  let oversized = false;
  diagnostic.child.stdout.on("data", (chunk) => {
    stdout += chunk;
    if (stdout.length > 128000) {
      oversized = true;
      stdout = stdout.slice(-128000);
      signal(diagnostic.child, "SIGKILL");
    }
  });
  assert.equal((await diagnostic.done).code, 1, diagnostic.stderr());
  children.delete(diagnostic.child);
  assert.ok(stdout.trim(), `Missing MCP JSON: ${diagnostic.stderr()}`);
  const errors = JSON.parse(stdout);
  assert.equal(oversized, false);
  assert.equal(errors.servers.length, 1);
  assert.equal(errors.servers[0].name, "malformed");
  assert.equal(errors.servers[0].state, "failed");
  assert.deepEqual(errors.servers[0].tools, []);
  assert.match(errors.servers[0].error, /Invalid MCP initialize result/);
  assert.match(errors.servers[0].error, /fixture MCP malformed/);
  assert.ok(errors.errors.some((error) => error.includes('server "invalid" needs either')));
  assert.match(errors.note, /ignored because the project is not trusted/);
  const deadline = Date.now() + 5000;
  const pids = [...new Set((await readLog()).map((event) => event.pid))];
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      if (error.code === "ESRCH") return false;
      throw error;
    }
  };
  while (pids.some(alive) && Date.now() < deadline) await sleep(25);
  assert.deepEqual(pids.filter(alive), [], "All local stdio fixture processes must exit");
  assert.ok((await readLog()).some((event) => event.method === "resources/read"));
  console.log(
    "PI_NATIVE_MCP_REFERENCE_EVIDENCE",
    JSON.stringify({
      pi: "1.3.0",
      platform: process.platform,
      reloads: 2,
      inheritedNativeTools: true,
      direct: true,
      deferredSearchAndCall: true,
      codemodeCall: true,
      hiddenUnreachable: true,
      perToolExposure: true,
      resourceListRead: true,
      replacementOwnership: true,
      disabledNoConnections: true,
      malformedConnectionRejected: true,
      fixtureProcessesExited: pids.length,
      focusedPolicyDeniedMutation: true,
      fixedInProcessProvider: true,
      liveModelCalls: 0,
      externalServers: 0,
    }),
  );
} finally {
  for (const child of children) signal(child, "SIGKILL");
  // MCP stdio children own groups separate from the CLI. Stop only fixture PIDs recorded in this disposable run.
  for (const event of await readLog().catch(() => [])) {
    if (event.event !== "start") continue;
    try {
      process.kill(-event.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") {
        console.error(`Fixture process-group cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
  }
  await Promise.all(
    [...children].map(
      (child) =>
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve();
            return;
          }
          const timer = setTimeout(resolve, 3000);
          child.once("close", () => {
            clearTimeout(timer);
            resolve();
          });
        }),
    ),
  );
  await rm(root, { recursive: true, force: true });
}
