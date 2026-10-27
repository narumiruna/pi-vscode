import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32 } from "node:zlib";
import { PiRpcClient, type PiRpcEvent } from "../piRpcClient";
import { resolvePiRuntime } from "../piRuntimeSelection";

function historyImage(): string {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jrXcAAAAASUVORK5CYII=",
    "base64",
  );
  const text = Buffer.from(`padding\0${"x".repeat(1_800_000)}`);
  const body = Buffer.concat([Buffer.from("tEXt"), text]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(text.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([png.subarray(0, -12), length, body, checksum, png.subarray(-12)]).toString("base64");
}

test("bundled Pi restores the reported-size history across reconnect without changing the session", async () => {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-large-history-")));
  try {
    for (const directory of ["workspace", "home", "agent", "sessions", "tmp"]) await mkdir(path.join(root, directory));
    const cwd = path.join(root, "workspace");
    const sessionPath = path.join(root, "sessions", "remembered.jsonl");
    const sessionId = "00000000-0000-4000-8000-000000000126";
    const messages = Array.from({ length: 856 }, (_, index) => ({
      role: "user",
      content: [{ type: "text", text: `message ${index}` }] as Record<string, unknown>[],
      timestamp: 1_700_000_000_000 + index,
    }));
    messages[0]?.content.push({ type: "image", data: historyImage(), mimeType: "image/png" });
    const response = () =>
      JSON.stringify({ type: "response", id: "vscode_2", command: "get_messages", success: true, data: { messages } });
    const last = messages.at(-1)?.content[0];
    assert.ok(last);
    last.text += "x".repeat(5_297_452 - Buffer.byteLength(response()));
    assert.equal(Buffer.byteLength(response()), 5_297_452);
    const header = { type: "session", version: 3, id: sessionId, timestamp: "2026-10-27T00:00:00.000Z", cwd };
    // Include startup metadata so Pi does not repair missing settings during restore.
    const thinking = {
      type: "thinking_level_change",
      id: "thinking",
      parentId: null,
      timestamp: header.timestamp,
      thinkingLevel: "off",
    };
    const entries = messages.map((message, index) => ({
      type: "message",
      id: `m${index}`,
      parentId: index ? `m${index - 1}` : thinking.id,
      timestamp: new Date(message.timestamp).toISOString(),
      message,
    }));
    const contents = `${[header, thinking, ...entries].map((value) => JSON.stringify(value)).join("\n")}\n`;
    const digest = createHash("sha256").update(contents).digest("hex");
    await writeFile(sessionPath, contents);

    const extension = path.resolve(__dirname, "../..");
    const invocation = resolvePiRuntime("", extension);
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      LANG: "C.UTF-8",
      SystemRoot: process.env.SystemRoot,
      WINDIR: process.env.WINDIR,
      ComSpec: process.env.ComSpec,
      PATHEXT: process.env.PATHEXT,
      HOME: path.join(root, "home"),
      USERPROFILE: path.join(root, "home"),
      PI_CODING_AGENT_DIR: path.join(root, "agent"),
      PI_CODING_AGENT_SESSION_DIR: path.join(root, "sessions"),
      TEMP: path.join(root, "tmp"),
      TMPDIR: path.join(root, "tmp"),
      NODE_OPTIONS: `--require=${JSON.stringify(path.join(extension, "scripts/fixtures/bundled-runtime/network-guard.cjs"))}`,
      ...invocation.env,
    };
    const flags = [
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-mcp",
      "--no-tools",
      "--no-skills",
      "--no-prompt-templates",
      "--no-context-files",
      "--no-themes",
    ];
    for (let attempt = 0; attempt < 2; attempt++) {
      const events: PiRpcEvent[] = [];
      const client = new PiRpcClient({
        ...invocation,
        executableArgs: [...(invocation.executableArgs ?? []), ...flags],
        cwd,
        env,
        unsetEnv: [...(invocation.unsetEnv ?? []), ...Object.keys(process.env).filter((key) => !(key in env))],
        sessionPath,
      });
      client.onEvent((event) => events.push(event));
      try {
        await client.start();
        const pid = client.processId;
        assert.deepEqual(await client.getMessages(), messages);
        const state = await client.getState();
        assert.equal(state.sessionId, sessionId);
        assert.equal(state.sessionFile, sessionPath);
        assert.equal(client.processId, pid);
        assert.equal(client.isRunning, true);
        assert.equal(
          events.some((event) => ["agent_start", "protocol_error", "process_exit"].includes(event.type)),
          false,
        );
      } finally {
        await client.stop();
      }
      assert.equal(
        createHash("sha256")
          .update(await readFile(sessionPath))
          .digest("hex"),
        digest,
      );
    }
    await assert.rejects(readFile(path.join(root, "tmp", "network-attempts.log")), { code: "ENOENT" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
