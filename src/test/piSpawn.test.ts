import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildWindowsShellCommand, findWindowsExecutable, planPiSpawn, quoteWindowsCommandArgument } from "../piSpawn";

test("planPiSpawn leaves POSIX launches untouched", () => {
  const plan = planPiSpawn("pi", ["--mode", "rpc"], { platform: "posix", pathEnv: "/usr/bin" });
  assert.equal(plan.command, "pi");
  assert.deepEqual(plan.args, ["--mode", "rpc"]);
  assert.equal(plan.shell, false);
});

test("planPiSpawn passes unresolved Windows executables through for the original spawn error", () => {
  const plan = planPiSpawn("pi", ["--mode", "rpc"], { platform: "win32", pathEnv: "C:\\definitely-missing" });
  assert.equal(plan.command, "pi");
  assert.deepEqual(plan.args, ["--mode", "rpc"]);
  assert.equal(plan.shell, false);
});

test("quoteWindowsCommandArgument preserves cmd metacharacters and embedded quotes", () => {
  assert.equal(quoteWindowsCommandArgument(""), '""');
  assert.equal(quoteWindowsCommandArgument('a & b "c" <d> %FOO% ^f|g (h)'), '"a & b ""c"" <d> %FOO% ^f|g (h)"');
  assert.equal(quoteWindowsCommandArgument("C:\\dir\\"), '"C:\\dir\\\\"');
});

test("findWindowsExecutable prefers .exe, then .cmd, then .bat PATH shims", async () => {
  if (process.platform !== "win32") {
    return;
  }
  const root = await mkdtemp(path.join(tmpdir(), "pi-spawn-"));
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    await writeFile(path.join(bin, "pi.bat"), "@echo off\n");
    await writeFile(path.join(bin, "pi.cmd"), "@echo off\n");
    const pathEnv = `${bin};C:\\definitely-missing`;
    assert.equal(findWindowsExecutable("pi", pathEnv), path.join(bin, "pi.cmd"));
    const plan = planPiSpawn("pi", ["--mode", "rpc"], { platform: "win32", pathEnv });
    assert.equal(plan.shell, true);
    assert.deepEqual(plan.args, []);
    assert.equal(plan.command, buildWindowsShellCommand(path.join(bin, "pi.cmd"), ["--mode", "rpc"]));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
