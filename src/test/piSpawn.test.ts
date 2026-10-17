import assert from "node:assert/strict";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { buildPiProcessEnvironment, findWindowsExecutable, planPiSpawn } from "../piSpawn";
import { launchFixture, npmNodeShim } from "./piLaunchFixtures";

const windows = test.skipIf(process.platform !== "win32");

test("POSIX planning preserves command and arguments", () => {
  const args = ["--mode", "rpc", "%TEMP%", "a\nb"];
  assert.deepEqual(planPiSpawn("pi", args, { platform: "linux", env: {} }), { command: "pi", args, shell: false });
});

test("Windows environment merges and removes logical keys; POSIX remains case-sensitive", () => {
  const base = { Path: "A", PATH: "duplicate", TOKEN: "secret", KEEP: "yes" };
  assert.deepEqual(buildPiProcessEnvironment(base, { path: "B", token: "override" }, ["Token"], "win32"), {
    PATH: "B",
    KEEP: "yes",
    NO_COLOR: "1",
  });
  assert.deepEqual(buildPiProcessEnvironment({ Path: "A" }, { PATH: "B" }, ["path"], "linux"), {
    Path: "A",
    PATH: "B",
    NO_COLOR: "1",
  });
  assert.equal(buildPiProcessEnvironment({ Path: "A" }, { PATH: undefined }, [], "win32").PATH, undefined);
  assert.equal(buildPiProcessEnvironment({ Path: "A" }, { PATH: "" }, [], "win32").PATH, "");
});

windows("Windows resolution uses child PATH, directory order, cwd, and extension preference", async () => {
  const f = await launchFixture();
  try {
    const later = path.join(f.root, "later");
    await mkdir(later);
    await writeFile(path.join(later, "pi.exe"), "");
    assert.equal(findWindowsExecutable("pi", `${f.bin};${later}`, f.root), f.shim);
    await writeFile(path.join(f.bin, "pi.bat"), npmNodeShim("fixture.cjs"));
    await writeFile(path.join(f.bin, "pi.exe"), "");
    assert.equal(findWindowsExecutable("pi", f.bin, f.root), path.join(f.bin, "pi.exe"));
    await rm(path.join(f.bin, "pi.exe"));
    assert.equal(findWindowsExecutable("pi", f.bin, f.root), f.shim);
    await rm(f.shim);
    assert.equal(findWindowsExecutable("pi", f.bin, f.root), path.join(f.bin, "pi.bat"));
    await rename(path.join(f.bin, "pi.bat"), f.shim);
    const relative = path.relative(f.root, f.shim);
    for (const name of [relative, `.\\${relative}`, relative.replaceAll("\\", "/"), f.shim]) {
      assert.equal(planPiSpawn(name, [], { cwd: f.root, env: { PATH: later } }).args[0], f.script);
    }
    assert.equal(findWindowsExecutable("pi", `;"${path.relative(f.root, f.bin)}";;`, f.root), f.shim);
    assert.equal(findWindowsExecutable("pi", "", f.bin), undefined);
    assert.equal(findWindowsExecutable("pi", ';""; ;', f.bin), undefined);
    assert.throws(() => findWindowsExecutable("pi", "C:bin", f.root), /PATH directories/);
    assert.throws(() => findWindowsExecutable("pi", "\\bin", f.root), /PATH directories/);
    await mkdir(path.join(f.bin, "directory.exe"));
    assert.equal(findWindowsExecutable("directory.exe", f.bin, f.root), undefined);
    assert.throws(() => planPiSpawn("pi", [], { cwd: f.root, env: {} }), /not found/);
    assert.throws(() => planPiSpawn("pi", [], { cwd: f.root, env: { PATH: "" } }), /not found/);
    assert.throws(
      () => planPiSpawn(path.join(f.root, "missing.cmd"), [], { cwd: f.root, env: { PATH: f.bin } }),
      /not found/,
    );
    for (const name of ["C:pi.cmd", "C:", "\\tools\\pi.cmd"]) {
      assert.throws(() => findWindowsExecutable(name, f.bin, f.root), /drive-qualified/);
    }
  } finally {
    await f.cleanup();
  }
});

windows("npm Node shims launch without a shell and preserve real argv and stdin", async () => {
  const f = await launchFixture();
  let child: ChildProcessWithoutNullStreams | undefined;
  let timer: NodeJS.Timeout | undefined;
  const args = [
    "",
    "a b",
    'a "b" c',
    "C:\\dir\\",
    "%TEMP%",
    "%UNDEFINED%",
    "!NAME!",
    "^ & | < > ( )",
    "漢字",
    "line\none\r\ntwo",
  ];
  try {
    const env = buildPiProcessEnvironment(process.env, {
      ...f.env,
      PI_REVIEW_VALUE: '" & echo PI_REVIEW_INJECTED & rem "',
    });
    const plan = planPiSpawn(f.shim, [...args, "%PI_REVIEW_VALUE%"], { cwd: f.root, env });
    assert.equal(plan.shell, false);
    assert.equal(plan.command, path.join(f.bin, "node.exe"));
    child = spawn(plan.command, plan.args, { cwd: f.root, env, shell: false, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stdin.end("stdin only");
    const running = child;
    const code = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Argv fixture deadline reached.")), 5_000);
      running.once("error", reject);
      running.once("close", resolve);
    });
    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(output), { args: [...args, "%PI_REVIEW_VALUE%"], input: "stdin only" });
  } finally {
    clearTimeout(timer);
    child?.kill();
    await f.cleanup();
  }
});

windows("only exact npm Node templates are accepted, with explicit Node lookup", async () => {
  const f = await launchFixture();
  try {
    const original = await readFile(f.shim, "utf8");
    const nodeDirectory = path.join(f.root, "node runtime");
    await mkdir(nodeDirectory);
    await rename(path.join(f.bin, "node.exe"), path.join(nodeDirectory, "node.exe"));
    assert.equal(
      planPiSpawn(f.shim, [], { cwd: f.root, env: { Path: nodeDirectory } }).command,
      path.join(nodeDirectory, "node.exe"),
    );
    assert.throws(() => planPiSpawn(f.shim, [], { cwd: f.root, env: {} }), /requires node.exe/);
    for (const text of [
      `${original}echo changed\r\n`,
      original.replace('"%_prog%"  ', '"%_prog%" --inspect '),
      "@echo off\r\nnode x.js %*\r\n",
      "x".repeat(16_385),
    ]) {
      await writeFile(f.shim, text);
      assert.throws(
        () => planPiSpawn(f.shim, [], { cwd: f.root, env: { PATH: nodeDirectory } }),
        /Unsupported|exceeds/,
      );
    }
    const malformedTarget = npmNodeShim("invalid-�.cjs");
    await writeFile(path.join(f.bin, "invalid-�.cjs"), "");
    await writeFile(
      f.shim,
      Buffer.from(malformedTarget).map((byte) => (byte === 0xef ? 0xff : byte)),
    );
    assert.throws(() => planPiSpawn(f.shim, [], { cwd: f.root, env: {} }), /encoded data/);
    await writeFile(f.shim, original);
    await rm(f.script);
    assert.throws(() => planPiSpawn(f.shim, [], { cwd: f.root, env: {} }), /entry point is missing/);
  } finally {
    await f.cleanup();
  }
});
