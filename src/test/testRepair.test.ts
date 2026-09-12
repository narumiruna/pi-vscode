import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { runBoundedProcess } from "../boundedProcess";
import { boundedFailure, noTestsMatched, redactRecognizableSecrets, RepairAttempts, validateTestCommand } from "../testRepair";

test("test command validation, log redaction, no-test matches and finite repair attempts", () => {
  assert.deepEqual(validateTestCommand({ executable: "node", args: ["--test", "test with space.js"] }), { executable: "node", args: ["--test", "test with space.js"] });
  for (const value of [{ executable: "sh", args: ["-c", "echo secret"] }, { executable: "node && rm", args: [] }, { executable: "node", args: [null] }]) assert.throws(() => validateTestCommand(value));
  assert.equal(boundedFailure("x".repeat(100001)).truncated, true);
  assert.match(redactRecognizableSecrets("password=supersecretvalue"), /REDACTED/);
  assert.equal(noTestsMatched("No tests found"), true);
  const attempts = new RepairAttempts("failure"); attempts.approve(); attempts.observe(1, "failure", "exited"); assert.equal(attempts.stopped, "Unchanged failure");
  assert.throws(() => attempts.approve());
  const exhausted = new RepairAttempts("a"); exhausted.approve(); exhausted.observe(1, "b", "exited"); exhausted.approve(); exhausted.observe(1, "c", "exited"); assert.match(exhausted.stopped ?? "", /exhausted/);
  const passed = new RepairAttempts("a"); passed.approve(); passed.observe(0, "pass", "exited"); assert.equal(passed.stopped, "Passed");
  const cancelled = new RepairAttempts("a"); cancelled.stop("cancelled"); assert.throws(() => cancelled.approve());
});

test("process test adapter observes success/failure, missing executable, timeout, cancellation, bounded output and child cleanup", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "pi-test-runner-"));
  try {
    const result = await runBoundedProcess(process.execPath, ["-e", "console.log('failure');process.exit(2)"], { cwd });
    assert.equal(result.exitCode, 2); assert.match(result.stdout.toString(), /failure/);
    assert.equal((await runBoundedProcess(process.execPath, ["-e", "console.log('pass')"], { cwd })).exitCode, 0);
    await assert.rejects(runBoundedProcess("/nonexistent/pi-test-executable", [], { cwd }), /Could not run/);
    const slow = "setInterval(() => {}, 1000)";
    assert.equal((await runBoundedProcess(process.execPath, ["-e", slow], { cwd, timeoutMs: 50 })).status, "timeout");
    const controller = new AbortController(); setTimeout(() => controller.abort(), 50);
    assert.equal((await runBoundedProcess(process.execPath, ["-e", slow], { cwd, signal: controller.signal })).status, "cancelled");
    const large = await runBoundedProcess(process.execPath, ["-e", "console.log('x'.repeat(10000))"], { cwd, maxBytes: 100 });
    assert.equal(large.status, "output-limit"); assert.ok(large.stdout.length <= 100);
    if (process.platform !== "win32") {
      const marker = path.join(cwd, "descendant-write");
      const script = `require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(`setTimeout(()=>require('fs').writeFileSync(${JSON.stringify(marker)},'escaped'),500)`)}], {stdio:'ignore'}); setInterval(()=>{},1000)`;
      await runBoundedProcess(process.execPath, ["-e", script], { cwd, timeoutMs: 100 });
      await new Promise(resolve => setTimeout(resolve, 600));
      await assert.rejects(readFile(marker), { code: "ENOENT" });
      // A deliberately escaped process may keep stdout open; the adapter must still finish.
      const escaped = await runBoundedProcess(process.execPath, ["-e", "const p=require('child_process').spawn(process.execPath,['-e','setTimeout(()=>process.exit(),5000)'],{detached:true,stdio:['ignore',1,2]});console.log(p.pid);p.unref();"], { cwd, timeoutMs: 200 });
      try { assert.equal(escaped.status, "timeout"); assert.match(escaped.cleanup, /could not be verified/); }
      finally { const pid = Number(escaped.stdout.toString().trim()); if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, "SIGKILL"); } catch { /* Already exited. */ } } }
    }
  } finally { await rm(cwd, { recursive: true, force: true }); }
});
