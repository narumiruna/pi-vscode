// Explicit reference check: external Pi CLI path, isolated HOME, offline, no model/auth/network.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = process.argv[2];
assert.ok(cli, "Supply an installed Pi 1.3.0 dist/cli.js as an explicit reference, not a runtime dependency");
assert.equal(JSON.parse(await readFile(path.resolve(path.dirname(cli), "..", "package.json"), "utf8")).version, "1.3.0", "This discovery fixture records the checked Pi 1.3.0 contract");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const temporary = await mkdtemp(path.join(tmpdir(), "pi-control-reference-"));
const root = await realpath(temporary);
const agentDir = path.join(root, "agent");
await mkdir(agentDir);
const sessionFile = path.join(root, "fixture session.jsonl");
const original = [
  { type: "session", version: 3, id: "control-fixture", cwd: root, timestamp: "2026-01-01T00:00:00Z" },
  { type: "message", id: "first", parentId: null, timestamp: "2026-01-01T00:00:01Z", message: { role: "user", content: "Fixture first prompt", timestamp: 1 } },
  { type: "message", id: "second", parentId: "first", timestamp: "2026-01-01T00:00:02Z", message: { role: "user", content: "Fixture second prompt", timestamp: 2 } },
  { type: "compaction", id: "compacted", parentId: "second", timestamp: "2026-01-01T00:00:03Z", summary: "Fixture compaction", firstKeptEntryId: "first", tokensBefore: 1 },
  { type: "label", id: "label-a", parentId: "compacted", timestamp: "2026-01-01T00:00:04Z", targetId: "first", label: "Duplicate" },
  { type: "label", id: "label-b", parentId: "label-a", timestamp: "2026-01-01T00:00:05Z", targetId: "second", label: "Duplicate" },
  { type: "message", id: "abandoned", parentId: "first", timestamp: "2026-01-01T00:00:06Z", message: { role: "user", content: [{ type: "text", text: "Fixture abandoned prompt" }, { type: "image", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", mimeType: "image/gif" }], timestamp: 3 } },
].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
await writeFile(sessionFile, original);
const resources = ["pi-bridge.ts", "pi-permission-gate.ts", "pi-read-only-gate.ts", "pi-control.ts"];
const children = new Set();
function launch(includeControl = true, resume = true, selectedSession = sessionFile) {
  const child = spawn(process.execPath, [cli, "--offline", "--mode", "rpc", "--no-extensions", "--no-mcp", "--no-approve", ...(resume ? ["--session", selectedSession] : []),
    ...resources.filter((resource) => includeControl || resource !== "pi-control.ts").flatMap((resource) => ["--extension", path.join(repository, "resources", resource)]),
  ], { cwd: root, env: { HOME: root, PATH: process.env.PATH, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1", NO_COLOR: "1" }, stdio: ["pipe", "pipe", "pipe"] });
  children.add(child);
  let buffer = "";
  let diagnostic = "";
  let id = 0;
  const pending = new Map();
  const events = [];
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-10_000); });
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    assert.ok(buffer.length < 5 * 1024 * 1024);
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
      if (!line) continue;
      const record = JSON.parse(line);
      const waiter = pending.get(record.id);
      if (record.type === "response" && waiter) {
        pending.delete(record.id); clearTimeout(waiter.timer);
        if (record.success) waiter.resolve(record.data); else waiter.reject(new Error(record.error));
      } else events.push(record);
    }
  });
  const done = new Promise((resolve) => child.once("exit", resolve));
  return {
    events,
    command(type, fields = {}) {
      return new Promise((resolve, reject) => {
        const requestId = String(++id);
        const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`Reference ${type} timeout: ${diagnostic}`)); }, 30_000);
        pending.set(requestId, { resolve, reject, timer });
        child.stdin.write(`${JSON.stringify({ id: requestId, type, ...fields })}\n`);
      });
    },
    async close() { child.stdin.end(); await done; children.delete(child); },
  };
}
try {
  const pi = launch();
  const initial = await pi.command("get_state");
  let leafId = (await pi.command("get_tree")).leafId;
  assert.equal(initial.sessionId, "control-fixture");
  for (let index = 0; index < 3; index++) {
    const catalog = (await pi.command("get_commands")).commands;
    for (const name of ["vscode-pi-control", "vscode-pi-bridge-ready", "vscode-pi-permission-ready", "vscode-pi-read-only-ready"])
      assert.equal(catalog.filter((command) => command.name === name).length, 1);
    const data = await pi.command("prompt", { message: `/vscode-pi-control ${JSON.stringify({ action: "reload", token: `reload-${index}`, cwd: root, sessionId: initial.sessionId, leafId })}` });
    assert.equal(data.disposition, "handled");
    assert.equal((await pi.command("get_state")).sessionId, initial.sessionId);
    assert.equal((await pi.command("get_tree")).leafId, leafId);
  }
  assert.equal(pi.events.some((event) => event.type === "extension_error"), false);
  const forkMessages = (await pi.command("get_fork_messages")).messages;
  assert.deepEqual(forkMessages.map((message) => message.entryId), ["first", "second", "abandoned"]);
  assert.equal((await pi.command("prompt", { message: `/vscode-pi-control ${JSON.stringify({ action: "navigate", token: "navigate", cwd: root, sessionId: initial.sessionId, leafId, targetId: "first" })}` })).disposition, "handled");
  assert.equal((await pi.command("get_tree")).leafId, null);
  await assert.rejects(pi.command("clone"), /no current entry selected/);
  assert.equal(pi.events.some((event) => event.type === "agent_start"), false);
  await pi.close();
  const resumed = launch();
  assert.equal((await resumed.command("get_tree")).leafId, leafId, "Unsummarized leaf navigation is not durable by itself");
  const beforeFork = await readFile(sessionFile, "utf8");
  assert.equal((await resumed.command("fork", { entryId: "second" })).cancelled, false, "Fork accepts an abandoned branch user message");
  assert.equal(await readFile(sessionFile, "utf8"), beforeFork, "Host branching must not overwrite the source session");
  assert.equal((await resumed.command("clone")).cancelled, false);
  const firstFork = await resumed.command("fork", { entryId: "first" });
  assert.equal(firstFork.cancelled, false);
  assert.equal(firstFork.text, "Fixture first prompt");
  await resumed.close();
  const missing = launch(false);
  const fallback = await missing.command("prompt", { message: "/vscode-pi-control {}" });
  assert.equal(fallback.disposition, "handled");
  assert.equal(missing.events.some((event) => event.type === "agent_start"), false);
  assert.ok(missing.events.some((event) => event.type === "extension_ui_request" && event.notifyType === "error"));
  await missing.close();
  const empty = launch(true, false);
  const emptyState = await empty.command("get_state");
  const emptyTree = await empty.command("get_tree");
  const hasHeader = await readFile(emptyState.sessionFile, "utf8").then(() => true).catch((error) => { if (error.code !== "ENOENT") throw error; return false; });
  assert.equal((await empty.command("prompt", { message: `/vscode-pi-control ${JSON.stringify({ action: "reload", token: "empty-reload", cwd: root, sessionId: emptyState.sessionId, leafId: emptyTree.leafId })}` })).disposition, "handled");
  assert.equal(empty.events.some((event) => event.type === "agent_start" || event.type === "extension_error"), false);
  await empty.close();
  const unsavedResume = launch(true, true, emptyState.sessionFile);
  const unsavedState = await unsavedResume.command("get_state");
  assert.equal(unsavedState.sessionFile, emptyState.sessionFile);
  assert.notEqual(unsavedState.sessionId, emptyState.sessionId, "An unsaved session has no durable ID yet");
  await unsavedResume.close();
  console.log("PI_CONTROL_EMPTY_REFERENCE", JSON.stringify({ hasHeader, reloadHandled: true, unsavedPathCanReopen: true, unsavedIdDurable: false }));
  console.log("PI_CONTROL_REFERENCE_EVIDENCE", JSON.stringify({ reloads: 3, forkAbandoned: true, firstTurnFork: true, clone: true, emptyCloneRejected: true, imageAndCompactionHistory: true, duplicateLabels: true, noSummaryNavigation: true, navigationDurableWithoutNewEntry: false, missingControlBlocked: true, modelCalls: 0 }));
} finally {
  for (const child of children) child.kill("SIGKILL");
  await rm(temporary, { recursive: true, force: true });
}
