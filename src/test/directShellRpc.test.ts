import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { type BashResultView, maxShellOutputCharacters } from "../directShell";
import { PiRpcClient, type PiRpcEvent } from "../piRpcClient";

async function fixture(action: (client: PiRpcClient, events: PiRpcEvent[]) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-direct-shell-rpc-"));
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: [path.resolve(__dirname, "../../scripts/fixtures/direct-shell.cjs")],
    cwd: root,
    requestTimeoutMs: 2_000,
  });
  const events: PiRpcEvent[] = [];
  client.onEvent((event) => events.push(event));
  try {
    await client.start();
    await action(client, events);
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
}

test("direct shell works without provider selection; output is correlated and final replaces streamed output", async () => {
  await fixture(async (client, events) => {
    const updates: BashResultView[] = [];
    const result = await client.bash("fixture:hello", false, (update) => updates.push(update));
    assert.equal(result.output, "hello\n");
    assert.equal(result.exitCode, 7);
    assert.ok(updates.length >= 2);
    assert.deepEqual(updates.at(-1), result);
    assert.ok(updates.every((update) => !update.output.includes("DO_NOT_RENDER")));
    assert.equal(result.output.split("hello").length, 2);
    await client.prompt("next prompt fixture");
    const first = events.filter((event) => event.type === "fixture_model_context").at(-1)!;
    assert.equal((first.messages as any[]).length, 1);
    await client.bash("fixture:hello", true, () => {});
    await client.prompt("second prompt fixture");
    const second = events.filter((event) => event.type === "fixture_model_context").at(-1)!;
    assert.equal((second.messages as any[]).length, 1, "excluded output is not projected into context");
    assert.equal((await client.getMessages()).length, 2, "excluded shell is still stored in Pi history");
  });
});

test("shell output floods remain bounded and hanging local children return cancelled final evidence after abort", async () => {
  await fixture(async (client) => {
    const result = await client.bash("fixture:flood", true, (update) =>
      assert.ok(update.output.length <= maxShellOutputCharacters),
    );
    assert.equal(result.output.length, maxShellOutputCharacters);
    assert.equal(result.truncated, true);
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const execution = client.bash("fixture:hang", false, () => ready());
    await started;
    await client.abortBash();
    assert.equal((await execution).cancelled, true);
  });
});

test("unsupported fixture shell fails without replay; failed abort does not claim termination", async () => {
  await fixture(async (client) => {
    await assert.rejects(
      client.bash("not-an-allowed-fixture", false, () => {}),
      /Unsupported harmless fixture/,
    );
    let ready!: () => void;
    const started = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const execution = client.bash("fixture:failed-abort", false, () => ready());
    void execution.catch(() => {});
    await started;
    await assert.rejects(client.abortBash(), /abort unavailable/);
    assert.equal(client.isRunning, true, "failed abort is not termination evidence");
    await client.stop();
    await assert.rejects(execution, /stopped|exited/);
  });
});
