// Network-free public-SDK compatibility check. Supply the configured Pi executable explicitly.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const require = createRequire(import.meta.url);
const { runIsolatedPi, helperArguments, helperEnvironment } = require("../out/isolatedPi.js");
const { validateSessionJsonl, hashSessionEntries } = require("../out/sessionTransfer.js");
const { planPiSpawn } = require("../out/piSpawn.js");
const { PiProcessOwner } = require("../out/piProcess.js");
const { verifyPackagedCommands } = require("../out/piControl.js");

// Exercise the actual command context after opening a same-cwd file outside the configured session directory.
async function verifySessionLocation(invocation, directory, input) {
  const env = helperEnvironment(directory, directory);
  const resources = path.resolve("resources");
  const args = helperArguments(path.join(resources, "pi-control.ts")).filter((value) => value !== "--no-session");
  args.push("--session", input);
  for (const file of ["pi-bridge.ts", "pi-permission-gate.ts", "pi-read-only-gate.ts"])
    args.push("--extension", path.join(resources, file));
  const plan = planPiSpawn(invocation.executablePath, args, { cwd: directory, env });
  const child = spawn(plan.command, plan.args, { cwd: directory, env, shell: false, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const owner = new PiProcessOwner(child);
  const pending = new Map();
  const reader = createInterface({ input: child.stdout });
  let sequence = 0;
  let snapshot;
  let agentStarted = false;
  let bytes = 0;
  child.stderr.resume();
  reader.on("line", (line) => {
    bytes += Buffer.byteLength(line);
    assert.ok(bytes <= 256 * 1024, "bounded fixture RPC output");
    const event = JSON.parse(line);
    if (event.type === "agent_start") agentStarted = true;
    if (event.type === "extension_ui_request" && event.method === "notify" && event.message.startsWith("PI_VSCODE_CONTROL_RESULT:")) {
      assert.ok(Buffer.byteLength(event.message) <= 16_384);
      snapshot = JSON.parse(event.message.slice("PI_VSCODE_CONTROL_RESULT:".length));
    }
    if (event.type === "response" && pending.has(event.id)) {
      const { resolve, reject, timer } = pending.get(event.id);
      pending.delete(event.id);
      clearTimeout(timer);
      if (event.success) resolve(event.data); else reject(new Error("Fixture RPC command failed"));
    }
  });
  const command = (type, fields = {}) => new Promise((resolve, reject) => {
    const id = `fixture-${++sequence}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("Fixture RPC deadline")); }, 15_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
  });
  try {
    const state = await command("get_state");
    const catalog = await command("get_commands");
    await verifyPackagedCommands(catalog.commands, resources);
    const result = await command("prompt", { message: `/vscode-pi-control ${JSON.stringify({ action: "session-location", cwd: directory, sessionId: state.sessionId, token: "fixture-location" })}` });
    assert.equal(result.disposition, "handled");
    assert.equal(agentStarted, false, "read-only query must never invoke a model");
    assert.ok(snapshot);
    assert.equal(snapshot.token, "fixture-location");
    assert.equal(snapshot.sessionFile, input);
    assert.notEqual(snapshot.sessionDir, path.dirname(input));
    const saved = validateSessionJsonl(await readFile(input));
    assert.equal(snapshot.sessionId, saved.header.id);
    assert.equal(snapshot.entriesHash, hashSessionEntries(saved.entries));
    assert.ok(saved.entries.some((entry) => entry.id === snapshot.leafId));
    console.log("Public command-context session directory and active-entry digest passed (external same-cwd session).");
  } finally {
    reader.close();
    for (const value of pending.values()) clearTimeout(value.timer);
    await owner.stop();
  }
}
const executablePath = process.argv[2];
if (!executablePath) throw new Error("Usage: node scripts/test-isolated-sdk.mjs <configured-pi-executable>");
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-public-sdk-fixture-")));
try {
  const store = path.join(directory, "selected-store");
  await mkdir(store);
  const credentials = Buffer.from(JSON.stringify({ fixture: { type: "api_key", key: "!this-command-must-never-execute" } }));
  await writeFile(path.join(store, "auth.json"), credentials);
  const invocation = { executablePath, cwd: directory };
  const helper = path.resolve("resources/pi-isolated-helper.ts");
  const cancellation = new AbortController();
  const deadline = setTimeout(() => cancellation.abort(), 20_000);
  const catalog = await runIsolatedPi(invocation, helper, { operation: "discover", agentDir: store }, undefined, cancellation.signal);
  console.log("Isolated public SDK discovery passed.");
  assert.equal(catalog.status, "providers");
  assert.ok(catalog.providers.some((provider) => provider.id === "openai"));
  assert.deepEqual(await readFile(path.join(store, "auth.json")), credentials);
  assert.deepEqual(await readdir(store), ["auth.json"], "metadata discovery must not touch selected store/config");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const header = { type: "session", version: 3, id: "fixture-session", timestamp, cwd: directory };
  const entry = (id, parentId, message) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content: message, timestamp: 0 } });
  const source = Buffer.from([header, entry("a", null, "root"), entry("b", "a", "active branch"), entry("c", "a", "abandoned branch")].map((value) => JSON.stringify(value)).join("\n") + "\n");
  const input = path.join(directory, "source.jsonl");
  const output = path.join(directory, "export.jsonl");
  await writeFile(input, source);
  await runIsolatedPi(invocation, helper, { operation: "export", cwd: directory, input, output, leaf: "b" }, undefined, cancellation.signal);
  console.log("Isolated public SDK branch export passed.");
  const exported = validateSessionJsonl(await readFile(output));
  assert.deepEqual(exported.entries.map((value) => value.id), ["a", "b"]);
  assert.ok(!(await readFile(output, "utf8")).includes("abandoned branch"));
  const imported = path.join(directory, "import.jsonl");
  await runIsolatedPi(invocation, helper, { operation: "import", cwd: directory, input, output: imported }, undefined, cancellation.signal);
  clearTimeout(deadline);
  const importedEntries = validateSessionJsonl(await readFile(imported)).entries;
  console.log("Imported SDK entry types:", importedEntries.map((value) => value.type).join(", "));
  assert.deepEqual(importedEntries.slice(0, 3).map((value) => value.id), ["a", "b", "c"]);
  assert.ok(importedEntries.slice(3).every((value) => value.type === "thinking_level_change" || value.type === "model_change"), "Only Pi initialization metadata may be appended");
  assert.deepEqual(await readFile(input), source, "source must remain unchanged through SDK export/import");
  await verifySessionLocation(invocation, directory, input);
  console.log(JSON.stringify({ executablePath, reference: "Pi 1.3.0", discovery: "passed (empty isolated store)", publicBranchExport: "passed (selected leaf b, abandoned c excluded)", publicRuntimeImport: "passed (complete tree copied, source unchanged)", modelCalls: 0, authorization: "not performed", network: "not used" }));
} finally {
  await rm(directory, { recursive: true, force: true });
}
