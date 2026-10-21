import assert from "node:assert/strict";
import { PiLogger, safeErrorCategory, safeErrorCode } from "../logging";
import { installVscodeMock } from "./vscodeMock";

const vscode = installVscodeMock();
afterAll(() => vscode.restore());

function fixture() {
  const channel = vscode.window.createOutputChannel("Pi", { log: true });
  let now = 0;
  const logger = new PiLogger(channel, () => now);
  return {
    channel,
    logger,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("one shared channel keeps severity and opens only on explicit action with preserved focus", () => {
  const { channel, logger } = fixture();
  for (const level of ["info", "warn", "error", "debug", "trace"] as const) {
    logger.record(level, "request", { operationId: logger.operation(), result: "completed" });
  }
  assert.deepEqual(
    channel.records.map((record: any) => record.level),
    ["info", "warn", "error", "debug", "trace"],
  );
  assert.deepEqual(channel.shown, []);
  logger.show();
  assert.deepEqual(channel.shown, [true]);
  logger.dispose();
  logger.dispose();
  logger.show();
  logger.record("error", "request");
  assert.equal(channel.disposeCalls, 1);
  assert.equal(channel.records.length, 5);
  assert.deepEqual(channel.shown, [true]);
});

test("metadata projection excludes secrets at every level and bounds all fields", () => {
  const { channel, logger } = fixture();
  const sentinel = "PRIVATE_SENTINEL";
  const raw = {
    message: sentinel,
    cause: new Error(sentinel),
    stack: sentinel,
    stderr: sentinel,
    line: sentinel,
    sessionPath: `/private/${sentinel}`,
    sessionTitle: sentinel,
    prompt: sentinel,
    response: sentinel,
    thinking: sentinel,
    sourceCode: sentinel,
    toolInput: sentinel,
    toolOutput: sentinel,
    commandText: sentinel,
    terminalText: sentinel,
    queueText: sentinel,
    attachments: [{ name: sentinel, data: sentinel }],
    auth: { token: sentinel, redirect: sentinel },
    mcp: { endpoint: sentinel, command: sentinel, env: sentinel, headers: sentinel },
    annotation: { credential: sentinel, origin: sentinel },
    command: sentinel,
    warningCode: sentinel,
    errorCode: sentinel,
    operationId: sentinel,
    result: sentinel,
    category: sentinel,
    signal: sentinel,
    platform: sentinel,
    host: sentinel,
    extensionVersion: sentinel,
    vscodeVersion: sentinel,
    stage: sentinel,
    generation: Infinity,
    count: -1,
    durationMs: NaN,
    exitCode: 1e100,
    retryAvailable: sentinel,
    cleanupVerified: sentinel,
    operationCompleted: sentinel,
  };
  for (const level of ["info", "warn", "error", "debug", "trace"] as const) {
    logger.record(level, "request", raw as any);
    logger.record(level, "deletion", {
      operationId: "op-123",
      generation: 4,
      durationMs: 35,
      result: "retained",
      category: safeErrorCategory({ ...raw, code: "EACCES" }),
      errorCode: safeErrorCode({ ...raw, code: "EACCES" }),
      exitCode: 2,
      signal: "SIGTERM",
      retryAvailable: false,
      operationCompleted: true,
    });
    logger.record(level, `${sentinel}\u001b[31m\u202e` as any, {});
  }
  const records = channel.records.map((record: any) => record.message);
  assert.equal(records.length, 10);
  for (const record of records) {
    assert.ok(!record.includes(sentinel));
    assert.ok(record.length <= 8_000);
    assert.ok(!/[\p{Cc}\p{Cf}]/u.test(record));
  }
  assert.match(records[1], /EACCES/);
  assert.match(records[1], /permission/);
  assert.match(records[1], /"result":"retained"/);
  assert.match(records[1], /"operationId":"op-123"/);
});

test("unknown failures stay unknown and error adapters never read error prose", () => {
  const error = {
    code: "EIO",
    get message() {
      throw new Error("must not read message");
    },
    get cause() {
      throw new Error("must not read cause");
    },
    get stack() {
      throw new Error("must not read stack");
    },
  };
  assert.equal(safeErrorCode(error), "EIO");
  assert.equal(safeErrorCategory(error), "io");
  assert.equal(safeErrorCategory(new Error("timeout with private details")), "unknown");
  assert.equal(safeErrorCategory({ code: "EACCES /private/secret" }), "unknown");
  assert.equal(
    safeErrorCategory({
      get code() {
        throw new Error("secret");
      },
    }),
    "unknown",
  );
});

test("warnings are bounded by known code and generation, with suppressed totals at next interval/end", () => {
  const { channel, logger, advance } = fixture();
  logger.warning("protocol-error", 1, { category: "invalid-frame" });
  for (let i = 0; i < 100; i++) logger.warning("protocol-error", 1);
  assert.equal(channel.records.length, 1);
  advance(5_000);
  logger.warning("protocol-error", 1);
  assert.match(channel.records[1].message, /"count":100/);
  logger.warning("protocol-error", 1);
  logger.endGeneration(1);
  assert.match(channel.records[3].message, /"count":1/);
  logger.warning("protocol-error", 2);
  assert.equal(channel.records.length, 5);
  for (let i = 0; i < 1_000; i++) logger.warning(`private-${i}`, 2);
  const state = (logger as any).warnings as Map<number, Map<string, unknown>>;
  assert.ok(state.get(2)!.size <= 32);
  logger.endGeneration(2);
  assert.match(channel.records.at(-1).message, /"count":999/);
  assert.equal(state.size, 0);
  logger.dispose();
});

test("final outcomes are not suppressed and unavailable/throwing/disposed logging cannot break work", async () => {
  const { channel, logger } = fixture();
  logger.warning("cleanup-unverified", 1);
  logger.warning("cleanup-unverified", 1);
  logger.record("error", "deletion", { result: "failed" });
  logger.record("error", "deletion", { result: "failed" });
  assert.equal(channel.records.filter((record: any) => record.message.startsWith("deletion")).length, 2);
  for (const method of ["info", "warn", "error", "debug", "trace", "show", "dispose"]) {
    channel[method] = () => {
      throw new Error("private disposed-channel error");
    };
  }
  const work = async (log: PiLogger) => {
    log.record("error", "request", { result: "failed" });
    log.warning("unknown", 5);
    log.endGeneration(5);
    log.show();
    return 42;
  };
  assert.equal(await work(logger), 42);
  logger.dispose();
  assert.equal(await work(logger), 42);
  assert.equal(await work(new PiLogger(undefined)), 42);
});
