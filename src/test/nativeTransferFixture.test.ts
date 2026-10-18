import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { hashSessionEntries, validateSessionJsonl } from "../sessionTransfer";

const root = path.resolve(__dirname, "../..");
async function run(script: string, cwd: string, input: unknown[], env: NodeJS.ProcessEnv = {}): Promise<unknown[]> {
  const child = spawn(process.execPath, [script], {
    cwd,
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    error += data;
  });
  const complete = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => (code === 0 ? resolve() : reject(new Error(`Fixture exit ${code}: ${error}`))));
  });
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    child.stdin.end(`${input.map((value) => JSON.stringify(value)).join("\n")}\n`);
    await complete;
    return output
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } finally {
    clearTimeout(timer);
  }
}

test("native fixture persists v3 entries and restores history; snapshot is a read-only source/memory digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-native-tree-unit-"));
  try {
    await writeFile(path.join(directory, "response.txt"), "Fixture answer");
    const script = path.join(root, "scripts/fixtures/native-pi.cjs");
    const env = { PI_VSCODE_UI_FIXTURE: directory };
    await run(script, directory, [{ id: "prompt", type: "prompt", message: "Unicode\u2028LS\u2029PS" }], env);
    const source = path.join(directory, "session.jsonl");
    const before = await readFile(source);
    const saved = validateSessionJsonl(before);
    assert.equal(saved.entries.length, 2);
    const result = (await run(
      script,
      directory,
      [
        { id: "history", type: "get_messages" },
        {
          id: "location",
          type: "prompt",
          message: `/vscode-pi-control ${JSON.stringify({ action: "session-location", token: "fixture", cwd: directory, sessionId: saved.header.id })}`,
        },
      ],
      env,
    )) as Record<string, unknown>[];
    const history = result.find((value) => value.id === "history") as { data: { messages: unknown[] } };
    assert.deepEqual(
      history.data.messages,
      saved.entries.map((entry) => entry.message),
    );
    const notification = result.find((value) => value.method === "notify");
    assert.ok(notification);
    const snapshot = JSON.parse(String(notification.message).slice("PI_VSCODE_CONTROL_RESULT:".length));
    assert.equal(snapshot.entriesHash, hashSessionEntries(saved.entries));
    assert.equal(snapshot.sessionFile, source);
    assert.equal(snapshot.sessionDir, path.join(directory, "configured-sessions"));
    assert.notEqual(snapshot.sessionDir, path.dirname(source));
    assert.deepEqual(await readFile(source), before);
    assert.equal((await readFile(path.join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").length, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("isolated fixture export selects a branch; import retains the complete known v3 tree and source", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-native-helper-unit-"));
  try {
    const stamp = "2026-01-01T00:00:00.000Z";
    const entries = [
      { type: "session", version: 3, id: "fixture", cwd: directory, timestamp: stamp },
      ...["root", "abandoned", "active"].map((id, index) => ({
        type: "message",
        id,
        parentId: index ? "root" : null,
        timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: `${id}\u2028LS\u2029PS` }], timestamp: 1 },
      })),
    ];
    const source = path.join(directory, "source.jsonl");
    const bytes = Buffer.from(`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await writeFile(source, bytes);
    for (const operation of ["export", "import"]) {
      const output = path.join(directory, `${operation}.jsonl`);
      await run(path.join(root, "src/test/fixtures/isolated-pi-fixture.mjs"), directory, [
        {
          protocol: "pi-vscode-isolated-v1",
          type: "request",
          operation,
          cwd: directory,
          input: source,
          output,
          leaf: "active",
        },
      ]);
      const saved = validateSessionJsonl(await readFile(output));
      assert.deepEqual(
        saved.entries.map((entry) => entry.id),
        operation === "export" ? ["root", "active"] : ["root", "abandoned", "active"],
      );
      assert.deepEqual(await readFile(source), bytes);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
