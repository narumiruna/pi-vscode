import assert from "node:assert/strict";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PiProcessOwner } from "../piProcess";

function fakeChild(pid?: number) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => false),
    unref: vi.fn(),
  });
  return child;
}

test("cleanup is bounded, idempotent, and explicit when termination cannot be verified", async () => {
  // No real PID is signalled. Simulate denied/missing process-group access.
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("denied");
  });
  const child = fakeChild(12345);
  const owner = new PiProcessOwner(child as unknown as ChildProcessWithoutNullStreams);
  try {
    const started = Date.now();
    const first = owner.stop();
    assert.equal(owner.stop(), first);
    const result = await first;
    assert.ok(Date.now() - started < 3_500);
    assert.equal(result.pipesClosed, false);
    assert.match(result.warning ?? "", /deadline reached/);
    for (const event of ["exit", "error", "close"]) assert.equal(child.listenerCount(event), 0);
    assert.equal(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed, true);
    assert.equal(child.unref.mock.calls.length, 1);
  } finally {
    kill.mockRestore();
  }
});

test("a failed spawn without a PID closes without signalling a process", async () => {
  const kill = vi.spyOn(process, "kill").mockImplementation(() => {
    throw new Error("must not signal");
  });
  const child = fakeChild();
  const owner = new PiProcessOwner(child as unknown as ChildProcessWithoutNullStreams);
  try {
    child.emit("error", new Error("ENOENT"));
    child.emit("close");
    assert.deepEqual(await owner.stop(), { pipesClosed: true, warning: undefined });
    assert.equal(child.kill.mock.calls.length, 0);
    assert.equal(kill.mock.calls.length, 0);
  } finally {
    kill.mockRestore();
  }
});
