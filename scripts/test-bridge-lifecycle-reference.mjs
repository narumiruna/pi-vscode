// Explicit Pi 1.3.0 reference only. No provider, authentication, or model requests.
// Usage: node scripts/test-bridge-lifecycle-reference.mjs /path/to/pi/dist/cli.js
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

assert.equal(process.argv.length, 3, "Supply an explicit installed Pi 1.3.0 dist/cli.js path");
const cli = await realpath(path.resolve(process.argv[2]));
assert.equal(path.basename(cli), "cli.js");
assert.equal(path.basename(path.dirname(cli)), "dist");
const metadata = JSON.parse(await readFile(path.resolve(path.dirname(cli), "..", "package.json"), "utf8"));
assert.equal(metadata.name, "@earendil-works/pi-coding-agent");
assert.equal(metadata.version, "1.3.0", "This fixture checks only the Pi 1.3.0 public contract");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-bridge-lifecycle-reference-"));
const sockets = new Set();
const subscriptions = [];
const requests = [];
const cancelledIds = [];
const observations = [];
const pending = new Map();
const token = randomUUID();
let child;
let closed;
let childClosed = false;
let exiting = false;
let failure;
let diagnostic = "";
let sequence = 0;
const server = net.createServer();

function fail(error) {
  failure ??= error instanceof Error ? error : new Error(String(error));
  for (const waiter of pending.values()) {
    clearTimeout(waiter.timer);
    waiter.reject(failure);
  }
  pending.clear();
}

// Split only on LF, preserving fragmented UTF-8 and Unicode line/paragraph separators.
function readLines(stream, receive, limit = 5 * 1024 * 1024) {
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  stream.on("data", (chunk) => {
    try {
      buffer += decoder.write(chunk);
      assert.ok(Buffer.byteLength(buffer) <= limit, "Fixture frame exceeded its limit");
      while (true) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (line) receive(JSON.parse(line));
      }
    } catch (error) {
      fail(error);
      stream.destroy();
    }
  });
  stream.on("end", () => {
    buffer += decoder.end();
    if (buffer) fail(new Error("Fixture stream ended without LF framing"));
  });
}

async function waitFor(check, label, milliseconds = 10_000) {
  const deadline = Date.now() + milliseconds;
  while (Date.now() < deadline) {
    if (failure) throw failure;
    const value = check();
    if (value) return value;
    await delay(20);
  }
  throw new Error(`${label} timeout. Pi stderr: ${diagnostic}`);
}

function command(type, fields = {}) {
  const id = `rpc-${++sequence}`;
  const result = new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${type} timeout. Pi stderr: ${diagnostic}`));
    }, 30_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`, (error) => {
      if (error) fail(error);
    });
  });
  // Exit can reject several outstanding commands before the caller awaits each one.
  void result.catch(() => {});
  return result;
}

function observed(kind, id) {
  return observations.filter((entry) => entry.kind === kind && (id === undefined || entry.data.id === id));
}

function activeSubscriptions() {
  return subscriptions.filter((entry) => !entry.closed);
}

async function handled(message) {
  assert.equal((await command("prompt", { message })).disposition, "handled");
}

async function request(id, outcome) {
  const before = requests.length;
  await handled(`/bridge-fixture ${JSON.stringify({ id, method: "context", params: { outcome } })}`);
  const wire = await waitFor(
    () => requests.slice(before).find((entry) => entry.request.params.outcome === outcome),
    id,
  );
  if (outcome !== "pending") {
    await waitFor(() => observed("response", id).length, `${id} response`);
    assert.equal(observed("response", id).length, 1, "Exactly one correlated response");
    const response = observed("response", id)[0].data;
    assert.equal(response.id, id);
    assert.equal(response.ok, outcome === "success");
    if (response.ok) assert.deepEqual(response.result, { text: "bridge ✓\u2028\u2029", wireId: wire.request.id });
    else assert.match(response.error, /fixture rejection/);
  }
  return wire;
}

async function checkSession(label, previousCount) {
  const state = await command("get_state");
  await waitFor(
    () => subscriptions.length > previousCount && activeSubscriptions().length === 1,
    `${label} subscription`,
  );
  assert.equal(subscriptions.length, previousCount + 1, "Exactly one new subscription per transition");
  const subscription = activeSubscriptions()[0];
  assert.deepEqual(
    subscription.request.params,
    { cwd: root, sessionId: state.sessionId },
    "Fresh subscription metadata",
  );
  await waitFor(
    () => observed("connected").some((entry) => entry.data.sessionId === state.sessionId),
    `${label} connected`,
  );
  const marker = `${label}-${randomUUID()}`;
  subscription.socket.write(
    `${JSON.stringify({ type: "event", event: "fixture.normal", data: { marker, text: "✓\u2028\u2029" } })}\n`,
  );
  await waitFor(
    () => observed("event").some((entry) => entry.data.data.marker === marker),
    `${label} event forwarding`,
  );
  await request(`${label}-success`, "success");
  await request(`${label}-failure`, "failure");
  assert.equal(observed("event").filter((entry) => entry.data.data.marker === marker).length, 1);
  assert.equal(activeSubscriptions().length, 1);
  assert.equal(subscriptions.length, previousCount + 1);
  return state;
}

async function transition(label, action) {
  const count = subscriptions.length;
  const id = `${label}-cancelled`;
  const held = await request(id, "pending");
  await action();
  await waitFor(() => held.closed, `${label} cancels pending bridge socket`, 3_000);
  // Request cancellation must be silent, including after the replacement event bus starts.
  const state = await checkSession(label, count);
  cancelledIds.push(id);
  for (const cancelled of cancelledIds) {
    assert.equal(observed("response", cancelled).length, 0, "Shutdown must not emit an old response event");
  }
  return state;
}

let root;
const stop = () => fail(new Error("Reference check interrupted"));
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  root = await realpath(temporary);
  const home = path.join(root, "home");
  const cwd = path.join(root, "workspace");
  const agentDir = path.join(root, "agent");
  const sessionDir = path.join(root, "sessions");
  const scratch = path.join(root, "tmp");
  await Promise.all([home, cwd, agentDir, sessionDir, scratch].map((directory) => mkdir(directory)));
  // Match canonical cwd in the packaged control contract and fixture session headers.
  root = await realpath(cwd);
  const fixtures = [];
  for (const name of ["one", "two"]) {
    const file = path.join(sessionDir, `${name}.jsonl`);
    const entries = [
      { type: "session", version: 3, id: `bridge-${name}`, cwd: root, timestamp: "2026-01-01T00:00:00Z" },
      ...["first", "second", "third"].map((id, index, ids) => ({
        type: "message",
        id,
        parentId: index ? ids[index - 1] : null,
        timestamp: "2026-01-01T00:00:01Z",
        message: { role: "user", content: `Harmless fixture ${name} ${id}`, timestamp: index + 1 },
      })),
    ];
    await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    fixtures.push(file);
  }
  const observer = path.join(temporary, "observer.ts");
  await writeFile(
    observer,
    `
export default function (pi) {
  let ctx;
  const notify = (kind, data) => ctx.ui.notify("BRIDGE_FIXTURE:" + JSON.stringify({ kind, data }), "info");
  pi.on("session_start", (_event, fresh) => { ctx = fresh; });
  for (const [event, kind] of [["vscode:connected", "connected"], ["vscode:event", "event"], ["vscode:response", "response"]])
    pi.events.on(event, (data) => notify(kind, data));
  pi.registerCommand("bridge-fixture", {
    handler: async (args) => { pi.events.emit("vscode:request", JSON.parse(args)); },
  });
  // Fail closed if command discovery/dispatch ever falls through to ordinary input.
  pi.on("input", () => { notify("unexpected-input", {}); return { action: "handled" }; });
  pi.on("before_agent_start", () => { throw new Error("Fixture forbids model runs"); });
}
`,
  );
  server.on("error", fail);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", fail);
    socket.once("close", () => {
      sockets.delete(socket);
      for (const entry of [...subscriptions, ...requests]) if (entry.socket === socket) entry.closed = true;
    });
    let received = false;
    readLines(
      socket,
      (record) => {
        assert.equal(received, false, "One request per bridge socket");
        received = true;
        assert.equal(record.token, token, "Every fixture connection must authenticate");
        assert.equal(typeof record.id, "string");
        const entry = { request: record, socket, closed: false };
        if (record.method === "subscribe") {
          subscriptions.push(entry);
          socket.write(`${JSON.stringify({ id: record.id, ok: true, result: { subscribed: true } })}\n`);
        } else {
          assert.equal(record.method, "context");
          requests.push(entry);
          const outcome = record.params.outcome;
          assert.ok(["success", "failure", "pending"].includes(outcome));
          if (outcome !== "pending")
            socket.end(
              `${JSON.stringify({
                id: record.id,
                ok: outcome === "success",
                error: "fixture rejection",
                result: { text: "bridge ✓\u2028\u2029", wireId: record.id },
              })}\n`,
            );
        }
      },
      1024 * 1024,
    );
  });
  server.listen(0, "127.0.0.1");
  await waitFor(() => server.listening, "Loopback fixture startup");
  const resources = ["pi-bridge.ts", "pi-read-only-gate.ts", "pi-control.ts"];
  // Allowlist only runtime OS variables, never credentials, proxies, Node hooks, or user Pi settings.
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    HOME: home,
    USERPROFILE: home,
    APPDATA: home,
    LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home,
    XDG_CACHE_HOME: scratch,
    XDG_DATA_HOME: home,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    NO_COLOR: "1",
    PI_OFFLINE: "1",
    PI_CODING_AGENT_DIR: agentDir,
    PI_CODING_AGENT_SESSION_DIR: sessionDir,
    PI_VSCODE_BRIDGE_PORT: String(server.address().port),
    PI_VSCODE_BRIDGE_TOKEN: token,
  });
  child = spawn(
    process.execPath,
    [
      cli,
      "--offline",
      "--mode",
      "rpc",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
      "--session-dir",
      sessionDir,
      "--session",
      fixtures[0],
      ...[...resources.map((name) => path.join(repository, "resources", name)), observer].flatMap((file) => [
        "--extension",
        file,
      ]),
    ],
    { cwd: root, env, stdio: ["pipe", "pipe", "pipe"] },
  );
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.stderr.on("data", (chunk) => {
    diagnostic = (diagnostic + chunk.toString()).slice(-16_000);
  });
  closed = new Promise((resolve) =>
    child.once("close", (code, signal) => {
      childClosed = true;
      if (!exiting || code !== 0 || pending.size) fail(new Error(`Pi exited (${code ?? signal}). ${diagnostic}`));
      resolve({ code, signal });
    }),
  );
  readLines(child.stdout, (record) => {
    if (record.type === "response") {
      const waiter = pending.get(record.id);
      assert.ok(waiter, `Unexpected RPC response ID: ${record.id}`);
      pending.delete(record.id);
      clearTimeout(waiter.timer);
      if (record.success) waiter.resolve(record.data);
      else waiter.reject(new Error(record.error));
    } else {
      assert.notEqual(record.type, "extension_error", JSON.stringify(record));
      assert.ok(!["agent_start", "turn_start", "message_update"].includes(record.type), "No model activity permitted");
      if (
        record.type === "extension_ui_request" &&
        record.method === "notify" &&
        record.message.startsWith("BRIDGE_FIXTURE:")
      ) {
        const observation = JSON.parse(record.message.slice("BRIDGE_FIXTURE:".length));
        assert.notEqual(observation.kind, "unexpected-input");
        observations.push(observation);
      }
    }
  });
  await checkSession("startup", 0);
  for (let index = 0; index < 3; index++) {
    await transition(`new-${index}`, async () => assert.equal((await command("new_session")).cancelled, false));
    await transition(`switch-${index}`, async () => {
      assert.equal((await command("switch_session", { sessionPath: fixtures[index % 2] })).cancelled, false);
    });
  }
  await transition("fork", async () => assert.equal((await command("fork", { entryId: "third" })).cancelled, false));
  await transition("clone", async () => assert.equal((await command("clone")).cancelled, false));
  for (let index = 0; index < 2; index++) {
    await transition(`reload-${index}`, async () => {
      const catalog = (await command("get_commands")).commands;
      for (const [name, file] of [
        ["vscode-pi-control", "pi-control.ts"],
        ["vscode-pi-bridge-ready", "pi-bridge.ts"],
        ["vscode-pi-read-only-ready", "pi-read-only-gate.ts"],
      ]) {
        const matches = catalog.filter((entry) => entry.name === name);
        assert.equal(matches.length, 1);
        assert.equal(matches[0].source, "extension");
        assert.equal(
          await realpath(matches[0].sourceInfo.path),
          await realpath(path.join(repository, "resources", file)),
        );
      }
      const state = await command("get_state");
      const { leafId } = await command("get_tree");
      await handled(
        `/vscode-pi-control ${JSON.stringify({
          action: "reload",
          token: `reload-${index}`,
          cwd: root,
          sessionId: state.sessionId,
          leafId,
        })}`,
      );
      assert.equal((await command("get_state")).sessionId, state.sessionId);
      assert.equal((await command("get_tree")).leafId, leafId);
    });
  }
  const held = await request("exit-cancelled", "pending");
  cancelledIds.push("exit-cancelled");
  exiting = true;
  child.stdin.end();
  const exit = await Promise.race([
    closed,
    delay(5_000).then(() => {
      throw new Error("Orderly Pi shutdown timeout");
    }),
  ]);
  assert.equal(exit.code, 0, diagnostic);
  assert.equal(exit.signal, null);
  await waitFor(() => held.closed && activeSubscriptions().length === 0, "Process shutdown closes bridge sockets");
  for (const id of cancelledIds) assert.equal(observed("response", id).length, 0);
  assert.equal(pending.size, 0);
  assert.doesNotMatch(diagnostic, /unhandled|stale|uncaught/i);
  console.log(
    "PI_BRIDGE_LIFECYCLE_REFERENCE",
    JSON.stringify({
      pi: "1.3.0",
      platform: process.platform,
      newSessions: 3,
      switches: 3,
      forks: 1,
      clones: 1,
      reloads: 2,
      subscriptions: subscriptions.length,
      eventForwarding: true,
      correlatedSuccessAndFailure: true,
      pendingCancelled: cancelledIds.length,
      modelCalls: 0,
    }),
  );
} finally {
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await Promise.race([closed, delay(1_000)]);
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await Promise.race([closed, delay(2_000)]);
  }
  fail(new Error("Reference fixture cleanup"));
  child?.stdin.destroy();
  child?.stdout.destroy();
  child?.stderr.destroy();
  for (const socket of sockets) socket.destroy();
  await Promise.race([new Promise((resolve) => server.close(resolve)), delay(2_000)]);
  await rm(temporary, { recursive: true, force: true });
  assert.ok(!child || childClosed, "Cleanup could not verify Pi process exit");
}
