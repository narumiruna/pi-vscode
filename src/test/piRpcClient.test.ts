import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRpcArguments,
  PiRpcClient,
  StrictJsonLineDecoder,
  type PiRpcEvent,
} from "../piRpcClient";

test("StrictJsonLineDecoder uses LF framing and preserves Unicode separators", () => {
  const lines: string[] = [];
  const decoder = new StrictJsonLineDecoder(line => lines.push(line));
  const payload = '{"text":"first\u2028second"}\r\n{"value":2}\n';
  const bytes = Buffer.from(payload, "utf8");

  decoder.push(bytes.subarray(0, 11));
  decoder.push(bytes.subarray(11));
  decoder.end();

  assert.deepEqual(lines, ['{"text":"first\u2028second"}', '{"value":2}']);
});

test("buildRpcArguments applies tool policy and configured overrides", () => {
  assert.deepEqual(
    buildRpcArguments({
      executablePath: "pi",
      cwd: "/workspace",
      provider: "anthropic",
      model: "sonnet",
      thinkingLevel: "high",
      tools: ["read", "grep"],
      appendSystemPrompt: "Stay read-only.",
      sessionPath: "/tmp/session.jsonl",
      approveProjectResources: true,
    }),
    [
      "--mode",
      "rpc",
      "--provider",
      "anthropic",
      "--model",
      "sonnet",
      "--thinking",
      "high",
      "--tools",
      "read,grep",
      "--append-system-prompt",
      "Stay read-only.",
      "--session",
      "/tmp/session.jsonl",
      "--approve",
    ],
  );
});

test("PiRpcClient correlates responses and streams events", async () => {
  await withFakePi(async options => {
    const client = new PiRpcClient(options);
    const events: PiRpcEvent[] = [];
    const subscription = client.onEvent(event => events.push(event));

    await client.start();
    assert.equal((await client.getState()).sessionId, "fake-session");
    await client.prompt("hello");
    await waitForEvent(events, "agent_settled");

    assert.equal(
      events.find(event => event.type === "message_update")?.assistantMessageEvent instanceof Object,
      true,
    );
    assert.equal(events.some(event => event.type === "tool_execution_start"), true);
    await client.abort();
    await client.stop();
    subscription.dispose();
    assert.equal(client.isRunning, false);
  });
});

test("PiRpcClient rejects pending commands when the process exits", async () => {
  await withFakePi(async options => {
    const client = new PiRpcClient(options);
    await client.start();
    await assert.rejects(client.prompt("crash"), /exited with code 7/);
    await client.stop();
  });
});

async function withFakePi(run: (options: ConstructorParameters<typeof PiRpcClient>[0]) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-vscode-rpc-"));
  const scriptPath = path.join(directory, "fake-pi.cjs");
  await writeFile(scriptPath, fakePiScript, "utf8");
  try {
    await run({
      executablePath: process.execPath,
      executableArgs: [scriptPath],
      cwd: directory,
      requestTimeoutMs: 5_000,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForEvent(events: readonly PiRpcEvent[], type: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!events.some(event => event.type === type)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${type}.`);
    }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

const fakePiScript = String.raw`
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    const request = JSON.parse(line);
    if (request.type === "prompt" && request.message === "crash") {
      process.exit(7);
    }
    const respond = data => process.stdout.write(JSON.stringify({
      id: request.id,
      type: "response",
      command: request.type,
      success: true,
      data,
    }) + "\n");
    if (request.type === "get_state") {
      respond({ sessionId: "fake-session", sessionFile: "/tmp/fake.jsonl", model: { provider: "fake", id: "model" } });
    } else if (request.type === "get_messages") {
      respond({ messages: [] });
    } else {
      respond({});
    }
    if (request.type === "prompt") {
      process.stdout.write(JSON.stringify({ type: "agent_start" }) + "\n");
      process.stdout.write(JSON.stringify({
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "Hello" },
      }) + "\n");
      process.stdout.write(JSON.stringify({
        type: "tool_execution_start",
        toolCallId: "tool-1",
        toolName: "read",
        args: { path: "README.md" },
      }) + "\n");
      process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
    }
  }
});
`;
