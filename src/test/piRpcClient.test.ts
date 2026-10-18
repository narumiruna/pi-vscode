import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import {
  buildPiProcessEnvironment,
  buildRpcArguments,
  PiRpcClient,
  type PiRpcEvent,
  StrictJsonLineDecoder,
} from "../piRpcClient";
import { alive, fixturePid, launchFixture, waitUntil } from "./piLaunchFixtures";

test("StrictJsonLineDecoder uses LF framing and preserves Unicode separators", () => {
  const lines: string[] = [];
  const decoder = new StrictJsonLineDecoder((line) => lines.push(line));
  const payload = '{"text":"first\u2028second"}\r\n{"value":2}\n';
  const bytes = Buffer.from(payload, "utf8");

  decoder.push(bytes.subarray(0, 11));
  decoder.push(bytes.subarray(11));
  decoder.end();

  assert.deepEqual(lines, ['{"text":"first\u2028second"}', '{"value":2}']);
});

test("buildPiProcessEnvironment applies overrides and removes sensitive inherited variables", () => {
  assert.deepEqual(
    buildPiProcessEnvironment(
      { KEEP: "base", REMOVE: "secret", OVERRIDE: "base", NO_COLOR: "0" },
      { OVERRIDE: "child" },
      ["REMOVE"],
    ),
    { KEEP: "base", OVERRIDE: "child", NO_COLOR: "1" },
  );
});

test("buildRpcArguments leaves foreground tools and system prompt at Pi defaults", () => {
  assert.deepEqual(
    buildRpcArguments({
      executablePath: "pi",
      cwd: "/workspace",
      provider: "anthropic",
      model: "sonnet",
      thinkingLevel: "high",
      extensions: ["/extension/permission.ts", "/extension/read-only.ts"],
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
      "--extension",
      "/extension/permission.ts",
      "--extension",
      "/extension/read-only.ts",
      "--session",
      "/tmp/session.jsonl",
      "--approve",
    ],
  );
});

test("buildRpcArguments retains only the background orchestration prompt", () => {
  const args = buildRpcArguments({
    executablePath: "pi",
    cwd: "/workspace",
    appendSystemPrompt: "This is an independent background task. Work only in the provided working directory.",
    extensions: ["/extension/permission.ts"],
    approveProjectResources: false,
  });
  assert.deepEqual(args, [
    "--mode",
    "rpc",
    "--append-system-prompt",
    "This is an independent background task. Work only in the provided working directory.",
    "--extension",
    "/extension/permission.ts",
    "--no-approve",
  ]);
  assert.equal(args.includes("--tools"), false);
});

test("PiRpcClient correlates responses and streams events", async () => {
  await withFakePi(async (options) => {
    const client = new PiRpcClient(options);
    const events: PiRpcEvent[] = [];
    const subscription = client.onEvent((event) => events.push(event));

    await client.start();
    assert.equal((await client.getState()).sessionId, "fake-session");
    assert.equal(await client.prompt("/handled-command"), "handled");
    assert.equal(
      events.some((event) => event.type === "agent_start"),
      false,
    );
    await client.prompt("hello");
    await waitForEvent(events, "agent_settled");

    assert.equal(
      events.find((event) => event.type === "message_update")?.assistantMessageEvent instanceof Object,
      true,
    );
    assert.equal(
      events.some((event) => event.type === "tool_execution_start"),
      true,
    );
    await client.prompt("image", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    await waitForEvent(events, "image_received");
    assert.equal(events.find((event) => event.type === "image_received")?.count, 1);
    await client.abort();
    await client.stop();
    subscription.dispose();
    assert.equal(client.isRunning, false);
  });
});

test("native runtime setters send typed public commands without prompting or queue mutation", async () => {
  await withFakePi(async (options) => {
    const client = new PiRpcClient(options);
    const events: PiRpcEvent[] = [];
    client.onEvent((event) => events.push(event));
    await client.start();
    try {
      await client.setSteeringMode("all");
      await client.setFollowUpMode("one-at-a-time");
      await client.setAutoCompaction(false);
      await client.setAutoRetry(true);
      await waitForEvent(events, "native_control_received");
      assert.deepEqual(
        events.filter((event) => event.type === "native_control_received").map((event) => event.command),
        [
          { type: "set_steering_mode", mode: "all" },
          { type: "set_follow_up_mode", mode: "one-at-a-time" },
          { type: "set_auto_compaction", enabled: false },
          { type: "set_auto_retry", enabled: true },
        ],
      );
      assert.equal(
        events.some((event) => event.type === "agent_start" || event.type === "queue_update"),
        false,
      );
      await assert.rejects(client.setSteeringMode("invalid" as "all"), /Invalid/);
      await assert.rejects(client.setAutoRetry("true" as unknown as boolean), /Invalid/);
    } finally {
      await client.stop();
    }
  });
});

test("PiRpcClient prompt resolves after acceptance and before task settlement", async () => {
  await withFakePi(async (options) => {
    const client = new PiRpcClient(options);
    const events: PiRpcEvent[] = [];
    client.onEvent((event) => events.push(event));

    await client.start();
    await client.prompt("delayed-settlement");

    assert.equal(
      events.some((event) => event.type === "agent_settled"),
      false,
    );
    await waitForEvent(events, "agent_start");
    await client.getState();
    await waitForEvent(events, "agent_settled");
    await client.stop();
  });
});

test("multiple PiRpcClient sessions stream independently", async () => {
  await withFakePi(async (options) => {
    const first = new PiRpcClient(options);
    const second = new PiRpcClient(options);
    const firstEvents: PiRpcEvent[] = [];
    const secondEvents: PiRpcEvent[] = [];
    first.onEvent((event) => firstEvents.push(event));
    second.onEvent((event) => secondEvents.push(event));

    await Promise.all([first.start(), second.start()]);
    await Promise.all([first.prompt("first"), second.prompt("second")]);
    await Promise.all([waitForEvent(firstEvents, "agent_settled"), waitForEvent(secondEvents, "agent_settled")]);

    assert.equal(
      firstEvents.some((event) => event.type === "message_update"),
      true,
    );
    assert.equal(
      secondEvents.some((event) => event.type === "message_update"),
      true,
    );
    await Promise.all([first.stop(), second.stop()]);
  });
});

test("PiRpcClient rejects pending commands when the process exits", async () => {
  await withFakePi(async (options) => {
    const client = new PiRpcClient(options);
    await client.start();
    await assert.rejects(client.prompt("crash"), /exited with code 7/);
    await client.stop();
  });
});

test("RPC launches the resolved runtime, preserves arguments, and stops it exactly once", async () => {
  const f = await launchFixture();
  const parent = await launchFixture();
  const parentPath = process.env.PATH;
  process.env.PATH = parent.bin;
  const executablePath = process.platform === "win32" ? "pi" : f.executable;
  const client = new PiRpcClient({
    executablePath,
    cwd: f.root,
    env: { ...f.env, path: f.bin },
    model: "%TEMP% & | 漢字",
    appendSystemPrompt: 'a "quote"\nC:\\dir\\',
    extensions: ["%PI_REVIEW_VALUE%"],
    sessionPath: "a b.jsonl",
    requestTimeoutMs: 1_000,
  });
  const events: PiRpcEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    const state = await client.getState();
    assert.equal(client.processId, state.pid);
    assert.equal(state.script, f.script);
    const args = state.args as string[];
    assert.equal(args[args.indexOf("--model") + 1], "%TEMP% & | 漢字");
    assert.equal(args[args.indexOf("--append-system-prompt") + 1], 'a "quote"\nC:\\dir\\');
    assert.equal(args[args.indexOf("--extension") + 1], "%PI_REVIEW_VALUE%");
    await Promise.all([client.stop(), client.stop(), client.stop()]);
    await waitUntil(() => !alive(state.pid as number));
    assert.equal(events.filter((event) => event.type === "process_exit").length, 1);
    assert.equal(
      events.some((event) => event.type === "runtime_warning"),
      process.platform === "win32",
    );
  } finally {
    await client.stop();
    if (parentPath === undefined) delete process.env.PATH;
    else process.env.PATH = parentPath;
    await f.cleanup();
    await parent.cleanup();
  }
});

test("RPC ignores late events from a replaced child generation", async () => {
  const requests: { id: string; type: string }[] = [];
  const makeChild = () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: () => false,
      unref: () => {},
    });
    child.stdin.on("data", (chunk: Buffer) => {
      const request = JSON.parse(chunk.toString());
      if (request.type === "get_state") {
        child.stdout.write(
          `${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} })}\n`,
        );
      } else requests.push(request);
    });
    return child;
  };
  const first = makeChild();
  const second = makeChild();
  const spawn = vi
    .spyOn(require("node:child_process"), "spawn")
    .mockReturnValueOnce(first as unknown as ChildProcessWithoutNullStreams)
    .mockReturnValueOnce(second as unknown as ChildProcessWithoutNullStreams);
  const client = new PiRpcClient({ executablePath: process.execPath, cwd: process.cwd() });
  try {
    await client.start();
    first.emit("close");
    await client.stop();
    await client.start();
    const pending = client.prompt("pending");
    let error: unknown;
    void pending.catch((failure) => {
      error = failure;
    });
    first.emit("exit", 7, null);
    first.emit("error", new Error("late error"));
    first.stdout.emit("data", Buffer.from('{"type":"queue_update","steering":null}\n'));
    first.stderr.emit("data", Buffer.from("stale diagnostics"));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(error, undefined);
    assert.equal(client.diagnostics, "");
    assert.equal(client.isRunning, true);
    const request = requests[0];
    assert.ok(request);
    second.stdout.write(
      `${JSON.stringify({ type: "response", id: request.id, command: request.type, success: true, data: {} })}\n`,
    );
    await pending;
  } finally {
    second.emit("close");
    await client.stop();
    spawn.mockRestore();
  }
});

test("RPC preserves unexpected-exit classification when a rejected caller stops during cleanup", async () => {
  const f = await launchFixture();
  const client = new PiRpcClient({ executablePath: f.executable, cwd: f.root, env: f.env, model: "early-exit" });
  const events: PiRpcEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    await assert.rejects(client.prompt("wait-for-exit"), /exited/);
    await client.stop();
    const exits = events.filter((event) => event.type === "process_exit");
    assert.equal(exits.length, 1);
    assert.equal(exits[0]?.expected, false);
  } finally {
    await client.stop();
    await f.cleanup();
  }
});

test("RPC rejects reentrant restart until stop settles, then can restart", async () => {
  const f = await launchFixture();
  const client = new PiRpcClient({ executablePath: f.executable, cwd: f.root, env: f.env });
  let restart: Promise<void> | undefined;
  const subscription = client.onEvent((event) => {
    if (event.type === "process_exit") {
      restart = client.start();
      void restart.catch(() => {});
    }
  });
  try {
    await client.start();
    await client.stop();
    assert.ok(restart);
    await assert.rejects(restart, /stopping/);
    subscription.dispose();
    await client.start();
    await client.stop();
  } finally {
    subscription.dispose();
    await client.stop();
    await f.cleanup();
  }
});

test("RPC explicit relative paths use child cwd; PATH removal never restores parent lookup", async () => {
  const f = await launchFixture();
  const client = new PiRpcClient({
    executablePath: `.${path.sep}${path.relative(f.root, f.executable)}`,
    cwd: f.root,
    env: f.env,
  });
  try {
    await client.start();
    assert.equal((await client.getState()).pid, client.processId);
    await client.stop();
    if (process.platform === "win32") {
      for (const env of [{ Path: f.bin }, { PATH: "" }]) {
        const missing = new PiRpcClient({
          executablePath: "pi",
          cwd: f.root,
          env,
          unsetEnv: ["path"],
          requestTimeoutMs: 100,
        });
        await assert.rejects(missing.start(), /not found/);
        assert.equal(missing.processId, undefined);
        await missing.stop();
      }
    }
  } finally {
    await client.stop();
    await f.cleanup();
  }
});

for (const failure of ["timeout", "oversized", "bad-queue"]) {
  test(`RPC cleans up after ${failure}`, async () => {
    const f = await launchFixture();
    const client = new PiRpcClient({
      executablePath: f.executable,
      cwd: f.root,
      env: f.env,
      model: failure,
      requestTimeoutMs: failure === "timeout" ? 1_000 : 5_000,
    });
    const events: PiRpcEvent[] = [];
    client.onEvent((event) => events.push(event));
    try {
      if (failure === "timeout") await assert.rejects(client.start(), /Timed out/);
      else {
        await client.start();
        await assert.rejects(client.prompt(failure), /larger|queue|stopped/);
      }
      await client.stop();
      const pid = await fixturePid(f.pidFile);
      await waitUntil(() => !alive(pid));
      assert.equal(events.filter((event) => event.type === "process_exit").length, 1);
    } finally {
      await client.stop();
      await f.cleanup();
    }
  });
}

test("RPC inherited descendant pipes have bounded cleanup and explicit Windows uncertainty", async () => {
  const f = await launchFixture();
  const client = new PiRpcClient({ executablePath: f.executable, cwd: f.root, env: f.env, model: "descendant" });
  const events: PiRpcEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    const pid = await fixturePid(f.pidFile);
    const descendant = await fixturePid(f.descendantFile);
    assert.equal(alive(descendant), true);
    const started = Date.now();
    await client.stop();
    assert.ok(Date.now() - started < 3_500);
    await waitUntil(() => !alive(pid));
    if (process.platform === "win32") {
      // The OS can stop this descendant, but that is not a general tree-ownership guarantee.
      assert.ok(
        events.some(
          (event) =>
            event.type === "runtime_warning" &&
            event.warningCode === "cleanup-unverified" &&
            /could not be verified/.test(String(event.message)),
        ),
      );
    }
    assert.equal(events.filter((event) => event.type === "process_exit").length, 1);
  } finally {
    await client.stop();
    await f.cleanup();
  }
});

test("RPC spawn failures do not emit a duplicate exit or leave pending requests", async () => {
  const f = await launchFixture();
  const client = new PiRpcClient({
    executablePath: f.executable,
    cwd: path.join(f.root, "missing"),
    requestTimeoutMs: 200,
  });
  const events: PiRpcEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await assert.rejects(client.start(), /Could not start/);
    await client.stop();
    assert.equal(events.filter((event) => event.type === "process_exit").length, 1);
  } finally {
    await client.stop();
    await f.cleanup();
  }
});

test("typed session RPC wrappers validate shapes, cancellation and unsupported acknowledgements", async () => {
  await withFakePi(async (options) => {
    const client = new PiRpcClient(options);
    try {
      await client.start();
      assert.equal((await client.getTree()).leafId, "user");
      assert.deepEqual(await client.getForkMessages(), [{ entryId: "user", text: "Prompt" }]);
      assert.deepEqual(await client.fork("user"), { cancelled: false, text: "Prompt" });
      assert.deepEqual(await client.fork("cancel"), { cancelled: true, text: undefined });
      assert.deepEqual(await client.clone(), { cancelled: false });
      await assert.rejects(client.fork("bad"), /Invalid Pi fork acknowledgement/);
      await assert.rejects(client.fork("unsupported"), /Unknown command/);
      await assert.rejects(client.fork("invalid id"), /Invalid fork entry ID/);
    } finally {
      await client.stop();
    }
  });
});

async function withFakePi(
  run: (options: ConstructorParameters<typeof PiRpcClient>[0]) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-rpc-"));
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
  while (!events.some((event) => event.type === type)) {
    if (Date.now() > deadline) {
      throw new Error(`Timed out waiting for ${type}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const fakePiScript = String.raw`
let buffer = "";
let delayedSettlementPending = false;
const settle = () => process.stdout.write(JSON.stringify({ type: "agent_settled" }) + "\n");
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
    if (["set_steering_mode", "set_follow_up_mode", "set_auto_compaction", "set_auto_retry"].includes(request.type)) {
      const { id, ...command } = request;
      process.stdout.write(JSON.stringify({ type: "native_control_received", command }) + "\n");
    }
    if (request.type === "prompt" && request.message === "/handled-command") {
      respond({ disposition: "handled" });
      continue;
    }
    if (request.type === "get_state") {
      respond({ sessionId: "fake-session", sessionFile: "/tmp/fake.jsonl", model: { provider: "fake", id: "model" } });
    } else if (request.type === "get_tree") {
      respond({ tree: [{ entry: { id: "user", parentId: null, type: "message", message: { role: "user", content: "Prompt" } }, children: [] }], leafId: "user" });
    } else if (request.type === "get_fork_messages") {
      respond({ messages: [{ entryId: "user", text: "Prompt" }] });
    } else if (request.type === "fork") {
      if (request.entryId === "unsupported") process.stdout.write(JSON.stringify({ type: "response", id: request.id, command: "fork", success: false, error: "Unknown command: fork" }) + "\n");
      else respond(request.entryId === "bad" ? {} : request.entryId === "cancel" ? { cancelled: true } : { cancelled: false, text: "Prompt" });
    } else if (request.type === "clone") {
      respond({ cancelled: false });
    } else if (request.type === "get_messages") {
      respond({ messages: [] });
    } else {
      respond({});
    }
    if (request.type === "prompt") {
      if (Array.isArray(request.images)) {
        process.stdout.write(JSON.stringify({ type: "image_received", count: request.images.length }) + "\n");
      }
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
      if (request.message === "delayed-settlement") {
        delayedSettlementPending = true;
      } else {
        settle();
      }
    } else if (request.type === "get_state" && delayedSettlementPending) {
      delayedSettlementPending = false;
      settle();
    }
  }
});
`;
