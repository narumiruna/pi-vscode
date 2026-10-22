import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolvePiRuntime, supportsBundledPi } from "../piRuntimeSelection";
import { buildPiProcessEnvironment } from "../piSpawn";

async function fixture(action: (root: string, pkg: string) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi runtime selection ")));
  const pkg = path.join(root, "node_modules", "@earendil-works", "pi-coding-agent");
  await mkdir(path.join(pkg, "dist", "bundle"), { recursive: true });
  await mkdir(path.join(root, "resources"));
  await writeFile(
    path.join(pkg, "package.json"),
    JSON.stringify({
      name: "@earendil-works/pi-coding-agent",
      version: "1.3.0",
      type: "module",
      bin: { pi: "dist/bundle/cli.js" },
      exports: { ".": { import: "./dist/index.js" } },
    }),
  );
  await writeFile(path.join(pkg, "dist", "index.js"), "export {};\n");
  await writeFile(
    path.join(pkg, "dist", "bundle", "cli.js"),
    `console.log(JSON.stringify({
    args: process.argv.slice(2), runAsNode: process.env.ELECTRON_RUN_AS_NODE,
    packageDir: process.env.PI_PACKAGE_DIR, managedRoot: process.env.PI_MANAGED_INSTALL_ROOT,
    skip: process.env.PI_SKIP_VERSION_CHECK, agentDir: process.env.PI_CODING_AGENT_DIR,
    provider: process.env.RUNTIME_PROVIDER_SENTINEL, path: process.env.PATH
  }));\n`,
  );
  await copyFile(
    path.resolve("resources/pi-runtime-bootstrap.cjs"),
    path.join(root, "resources", "pi-runtime-bootstrap.cjs"),
  );
  try {
    await action(root, pkg);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("runtime selection uses packaged paths with spaces and no PATH or inherited package lookup", async () => {
  await fixture(async (root, pkg) => {
    for (const setting of ["", " ", "\t\n"]) {
      const result = resolvePiRuntime(setting, root, {
        execPath: process.execPath,
        nodeVersion: "22.19.0",
        electron: "43.7.3",
      });
      assert.equal(result.executablePath, process.execPath);
      assert.deepEqual(result.executableArgs, [
        path.join(root, "resources", "pi-runtime-bootstrap.cjs"),
        path.join(pkg, "dist", "bundle", "cli.js"),
      ]);
      assert.equal(result.env?.ELECTRON_RUN_AS_NODE, "1");
      const env = buildPiProcessEnvironment(
        { PATH: "", PI_PACKAGE_DIR: "unrelated global", PI_MANAGED_INSTALL_ROOT: "wrong" },
        result.env,
        result.unsetEnv,
      );
      assert.equal(env.PATH, "");
      assert.equal(env.PI_PACKAGE_DIR, undefined);
      assert.equal(env.PI_MANAGED_INSTALL_ROOT, undefined);
    }
    const node = resolvePiRuntime("", root, { execPath: process.execPath, nodeVersion: "24.21.0" });
    assert.ok(node.unsetEnv?.includes("ELECTRON_RUN_AS_NODE"));
    assert.equal(node.env?.ELECTRON_RUN_AS_NODE, undefined);
  });
});

test("installation aliases use canonical prefix paths accepted by the bootstrap", async () => {
  await fixture(async (root) => {
    const alias = path.join(root, "installation alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    const launch = resolvePiRuntime("", alias);
    assert.equal(launch.executableArgs?.[0], path.join(root, "resources", "pi-runtime-bootstrap.cjs"));
    const child = spawnSync(launch.executablePath, [...(launch.executableArgs ?? []), "--version"], {
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(child.status, 0, child.stderr);
    assert.deepEqual(JSON.parse(child.stdout).args, ["--version"]);
  });
});

test("explicit saved pi and absolute/relative external paths never inspect packaged assets or host runtime", () => {
  for (const configured of [
    "pi",
    "./bin/pi",
    "../tools/pi with spaces",
    path.resolve("external pi"),
    "C:\\Tools With Spaces\\pi.cmd",
  ]) {
    assert.deepEqual(
      resolvePiRuntime(` ${configured} `, undefined, { execPath: "unavailable", nodeVersion: "18.0.0" }),
      { executablePath: configured },
    );
  }
});

test("packaged failures reject invalid metadata, missing entries and escaped assets without PATH fallback", async () => {
  assert.throws(() => resolvePiRuntime("", undefined), /missing or invalid.*No PATH fallback/);
  await fixture(async (root, pkg) => {
    const metadata = path.join(pkg, "package.json");
    await writeFile(metadata, '{"name":"spoof","version":"1.3.0"}');
    assert.throws(() => resolvePiRuntime("", root), /missing or invalid/);
  });
  await fixture(async (root, pkg) => {
    await rm(path.join(pkg, "dist", "index.js"));
    assert.throws(() => resolvePiRuntime("", root), /missing or invalid/);
  });
  await fixture(async (root, pkg) => {
    const entry = path.join(pkg, "dist", "bundle", "cli.js");
    await rm(entry);
    assert.throws(() => resolvePiRuntime("", root), /missing or invalid/);
    // File symlinks require extra privilege on Windows; that platform still runs missing-asset rejection.
    if (process.platform !== "win32") {
      await symlink(path.resolve("resources/pi-runtime-bootstrap.cjs"), entry);
      assert.throws(() => resolvePiRuntime("", root), /missing or invalid/);
    }
  });
});

test("packaged runtime requires Node 22.19 without imposing a runtime requirement on external Pi", () => {
  for (const value of ["18.20.0", "22.18.9", "22.19.0-pre", "unknown"]) assert.equal(supportsBundledPi(value), false);
  for (const value of ["22.19.0", "22.20.1", "23.0.0", "24.21.0", "26.5.0"])
    assert.equal(supportsBundledPi(value), true);
  assert.throws(
    () => resolvePiRuntime("", undefined, { execPath: process.execPath, nodeVersion: "22.18.0" }),
    /Update VS Code or select external Pi/,
  );
});

test("bootstrap removes startup-only flags before Pi and preserves user store/provider environment", async () => {
  await fixture(async (root) => {
    const launch = resolvePiRuntime("", root);
    const env = buildPiProcessEnvironment(process.env, {
      PATH: "",
      PI_PACKAGE_DIR: "redirected",
      PI_MANAGED_INSTALL_ROOT: "redirected",
      ELECTRON_RUN_AS_NODE: "1",
      RUNTIME_PROVIDER_SENTINEL: "provider retained",
      PI_CODING_AGENT_DIR: "shared user store",
    });
    const result = spawnSync(
      launch.executablePath,
      [...launch.executableArgs!, "--mode", "rpc", "--model", "model with spaces"],
      { env, encoding: "utf8", timeout: 10_000 },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      args: ["--mode", "rpc", "--model", "model with spaces"],
      skip: "1",
      agentDir: "shared user store",
      provider: "provider retained",
      path: "",
    });
    const update = spawnSync(launch.executablePath, [...launch.executableArgs!, "update", "--self"], {
      env,
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(update.status, 1);
    assert.equal(update.stdout, "", "The CLI was not imported, including any configured npmCommand");
    assert.match(update.stderr, /updates are provided by extension releases/);
  });
});
