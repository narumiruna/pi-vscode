import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { type LogEvent, type Logger, type LogLevel, type LogMetadata, nullLogger } from "../logging";
import { PiRpcClient, type PiRpcEvent } from "../piRpcClient";

const sentinel = "PRIVATE_RPC_SENTINEL_credential_prompt_path_json";
interface CapturedRecord {
  readonly level: LogLevel;
  readonly event: LogEvent;
  readonly metadata: LogMetadata;
}

function captureLogger() {
  const records: CapturedRecord[] = [];
  let nextId = 0;
  const logger: Logger = {
    ...nullLogger,
    operation: () => `op-${++nextId}`,
    record: (level, event, metadata = {}) => records.push({ level, event, metadata }),
    warning: () => assert.fail("Runtime, not RPC, owns protocol/runtime warning records."),
    endGeneration: () => assert.fail("Runtime owns generation completion."),
    show: () => assert.fail("RPC diagnostics must not open Output."),
  };
  return { logger, records };
}

function mockRpc(logger?: Logger, operationId?: `op-${number}`) {
  const requests: Record<string, unknown>[] = [];
  const events: PiRpcEvent[] = [];
  const child = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: () => false,
    unref: () => {},
  });
  const respond = (request: Record<string, unknown>, fields: Record<string, unknown> = {}) => {
    child.stdout.write(
      `${JSON.stringify({
        type: "response",
        id: request.id,
        command: request.type,
        success: true,
        data: { sessionId: sentinel, sessionFile: sentinel, content: sentinel, token: sentinel },
        ...fields,
      })}\n`,
    );
  };
  child.stdin.on("data", (chunk: Buffer) => {
    const request = JSON.parse(chunk.toString()) as Record<string, unknown>;
    requests.push(request);
    if (request.type === "get_state") respond(request);
  });
  const spawn = vi
    .spyOn(require("node:child_process"), "spawn")
    .mockReturnValue(child as unknown as ChildProcessWithoutNullStreams);
  const client = new PiRpcClient(
    {
      executablePath: process.execPath,
      cwd: process.cwd(),
      provider: sentinel,
      model: sentinel,
      sessionPath: sentinel,
      appendSystemPrompt: sentinel,
      env: { PI_TEST_SECRET: sentinel },
      requestTimeoutMs: 100,
    },
    logger ? { logger, generation: 23, operationId } : undefined,
  );
  client.onEvent((event) => events.push(event));
  return {
    client,
    child,
    requests,
    respondLast(fields: Record<string, unknown> = {}) {
      const request = requests.at(-1);
      assert.ok(request);
      respond(request, fields);
    },
    events,
    async cleanup() {
      child.emit("close");
      await client.stop();
      spawn.mockRestore();
    },
  };
}

function assertSafe(records: readonly CapturedRecord[]): void {
  assert.equal(JSON.stringify(records).includes(sentinel), false);
  for (const record of records) {
    assert.equal(record.event, "rpc-command");
    assert.equal(record.metadata.generation, 23);
    assert.match(record.metadata.operationId ?? "", /^op-\d+$/);
    assert.ok(
      Object.keys(record.metadata).every((key) =>
        ["command", "generation", "operationId", "result", "category", "durationMs"].includes(key),
      ),
    );
  }
}

function assertPair(records: readonly CapturedRecord[], command: string, category?: string): void {
  const pair = records.filter((record) => record.metadata.command === command);
  assert.equal(pair.length, 2);
  assert.equal(pair[0].level, "debug");
  assert.equal(pair[0].metadata.result, "started");
  assert.equal(pair[1].level, category ? "error" : "debug");
  assert.equal(pair[1].metadata.result, category ? "failed" : "completed");
  assert.equal(pair[1].metadata.category, category);
  assert.equal(pair[1].metadata.operationId, pair[0].metadata.operationId);
  assert.ok((pair[1].metadata.durationMs ?? -1) >= 0);
  assertSafe(pair);
}

test("RPC logs paired safe command timing with distinct host operation IDs", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const prompt = rpc.client.prompt(sentinel, [{ type: "image", data: sentinel, mimeType: "image/png" }]);
    rpc.respondLast({ data: { disposition: "handled", content: sentinel } });
    assert.equal(await prompt, "handled");
    const name = rpc.client.setSessionName(sentinel);
    rpc.respondLast();
    await name;
    assertPair(records, "get_state");
    assertPair(records, "prompt");
    assertPair(records, "set_session_name");
    assert.equal(new Set(records.map((record) => record.metadata.operationId)).size, 3);
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC excludes queued attachments, shell text, streamed output, and result fields", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const queued = rpc.client.steer(sentinel, [{ type: "image", data: sentinel, mimeType: "image/png" }]);
    rpc.respondLast();
    await queued;
    const shell = rpc.client.bash(sentinel, true, () => {});
    const request = rpc.requests.at(-1);
    assert.ok(request);
    rpc.child.stdout.write(`${JSON.stringify({ type: "bash_execution_update", id: request.id, delta: sentinel })}\n`);
    rpc.respondLast({
      data: { output: sentinel, cancelled: false, truncated: false, exitCode: 0, fullOutputPath: sentinel },
    });
    assert.equal((await shell).output, sentinel);
    assertPair(records, "steer");
    assertPair(records, "bash");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC retains an injected operation ID and excludes remote error fields", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger, "op-812");
  try {
    await rpc.client.start();
    const pending = rpc.client.switchSession(sentinel);
    rpc.respondLast({
      success: false,
      error: sentinel,
      cause: { token: sentinel },
      stack: sentinel,
      auth: { url: sentinel },
      mcp: { headers: sentinel },
    });
    await assert.rejects(pending, (error: Error) => error.message === sentinel);
    assertPair(records, "switch_session", "unknown");
    assert.ok(records.every((record) => record.metadata.operationId === "op-812"));
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC projects unexpected command types to unknown before calling the logger", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const pending = (rpc.client as unknown as { command(type: string): Promise<unknown> }).command(sentinel);
    rpc.respondLast();
    await pending;
    assertPair(records, "unknown");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC timeout records fixed metadata without changing private stderr diagnostics", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    rpc.child.stderr.write(sentinel);
    await assert.rejects(
      rpc.client.prompt(sentinel),
      (error: Error) =>
        error.message.startsWith("Timed out waiting for Pi RPC command 'prompt'.") && error.message.includes(sentinel),
    );
    assert.equal(rpc.client.diagnostics, sentinel);
    assertPair(records, "prompt", "timeout");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC disconnect logs each pending outcome without logging exit or warning boundaries", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    rpc.child.stderr.write(sentinel);
    const prompt = rpc.client.prompt(sentinel);
    const name = rpc.client.setSessionName(sentinel);
    rpc.child.exitCode = 7;
    rpc.child.emit("exit", 7, null);
    await assert.rejects(
      prompt,
      (error: Error) => error.message.includes("exited with code 7") && error.message.includes(sentinel),
    );
    await assert.rejects(name, /exited with code 7/);
    assertPair(records, "prompt", "disconnect");
    assertPair(records, "set_session_name", "disconnect");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC invalid acknowledgements log invalid-frame without copying response command or error", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const prompt = rpc.client.prompt(sentinel);
    rpc.respondLast({ command: sentinel, success: sentinel, error: sentinel });
    await assert.rejects(prompt, /Invalid Pi RPC command acknowledgement; acceptance is uncertain\./);
    assertPair(records, "prompt", "invalid-frame");
    assert.equal(rpc.events.length, 0);
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC emits malformed JSON protocol events without duplicate diagnostic boundaries", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const prompt = rpc.client.prompt(sentinel);
    const before = records.length;
    rpc.child.stdout.write(`${sentinel}\n${JSON.stringify({ error: sentinel, cause: sentinel })}\n`);
    assert.equal(rpc.events.filter((event) => event.type === "protocol_error").length, 2);
    assert.equal(records.length, before);
    rpc.respondLast();
    await prompt;
    assertPair(records, "prompt");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC size failure rejects all pending commands once and ignores stdout during cleanup", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const prompt = rpc.client.prompt(sentinel);
    const history = rpc.client.getMessages();
    const failures = Promise.all([
      assert.rejects(prompt, /JSON line larger than 64 MiB/),
      assert.rejects(history, /JSON line larger than 64 MiB/),
    ]);
    rpc.child.emit("close");
    rpc.child.stdout.write(`${sentinel}${"x".repeat(64 * 1024 * 1024)}\n`);
    rpc.child.stdout.write(`${JSON.stringify({ type: "late_private_event", message: sentinel })}\n`);
    rpc.child.stdout.end();
    await failures;
    await rpc.client.stop();
    assertPair(records, "prompt", "frame-too-large");
    assertPair(records, "get_messages", "frame-too-large");
    assert.equal(rpc.events.filter((event) => event.type === "protocol_error").length, 1);
    assert.equal(
      rpc.events.some((event) => event.type === "late_private_event"),
      false,
    );
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("fatal framing rejects reentrant commands and dialog replies before cleanup", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  let laterCommand: Promise<unknown> | undefined;
  let replyError: unknown;
  rpc.client.onEvent((event) => {
    if (event.type !== "protocol_error") return;
    laterCommand = rpc.client.prompt(sentinel);
    try {
      rpc.client.sendExtensionUiResponse(sentinel, { cancelled: true });
    } catch (error) {
      replyError = error;
    }
  });
  try {
    await rpc.client.start();
    const history = rpc.client.getMessages();
    const failure = assert.rejects(history, /JSON line larger than 64 MiB/);
    const before = rpc.requests.length;
    rpc.child.emit("close");
    rpc.child.stdout.write(Buffer.alloc(64 * 1024 * 1024 + 1, "x"));
    assert.ok(laterCommand);
    await assert.rejects(laterCommand, /Pi RPC is not running/);
    await failure;
    assert.ok(replyError instanceof Error);
    assert.match(replyError.message, /Pi RPC is not running/);
    assert.equal(rpc.requests.length, before, "A failed transport must not write another request");
    assertPair(records, "get_messages", "frame-too-large");
    assertPair(records, "prompt", "disconnect");
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC stdin errors keep error text private while recording disconnect", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const pending = rpc.client.prompt(sentinel);
    const error = new Error(sentinel, { cause: new Error(sentinel) });
    error.stack = sentinel;
    rpc.child.emit("close");
    rpc.child.stdin.emit("error", error);
    await assert.rejects(pending, (failure: Error) => failure.message === `Pi RPC stdin failed: ${sentinel}`);
    assertPair(records, "prompt", "disconnect");
    assert.equal(rpc.events.filter((event) => event.type === "protocol_error").length, 1);
    assertSafe(records);
  } finally {
    await rpc.cleanup();
  }
});

test("RPC disconnected commands retain their rejection and receive one failure record", async () => {
  const { logger, records } = captureLogger();
  const rpc = mockRpc(logger);
  try {
    await assert.rejects(rpc.client.prompt(sentinel), /^Error: Pi RPC is not running\.$/);
    assertPair(records, "prompt", "disconnect");
  } finally {
    await rpc.cleanup();
  }
});

test("RPC without injected diagnostics does not submit log records", async () => {
  const record = vi.spyOn(nullLogger, "record");
  const operation = vi.spyOn(nullLogger, "operation");
  const rpc = mockRpc();
  try {
    await rpc.client.start();
    const prompt = rpc.client.prompt(sentinel);
    rpc.respondLast();
    await prompt;
    assert.equal(record.mock.calls.length, 0);
    assert.equal(operation.mock.calls.length, 0);
  } finally {
    await rpc.cleanup();
    record.mockRestore();
    operation.mockRestore();
  }
});

test("RPC logger failures do not change acceptance, response errors, or stop", async () => {
  const logger: Logger = {
    ...nullLogger,
    operation: () => {
      throw new Error(sentinel);
    },
    record: () => {
      throw new Error(sentinel);
    },
  };
  const rpc = mockRpc(logger);
  try {
    await rpc.client.start();
    const accepted = rpc.client.prompt(sentinel);
    rpc.respondLast({ data: { disposition: "handled" } });
    assert.equal(await accepted, "handled");
    const failed = rpc.client.setSessionName(sentinel);
    rpc.respondLast({ success: false, error: sentinel });
    await assert.rejects(failed, (error: Error) => error.message === sentinel);
    assert.equal(rpc.client.isRunning, true);
  } finally {
    await rpc.cleanup();
  }
});
