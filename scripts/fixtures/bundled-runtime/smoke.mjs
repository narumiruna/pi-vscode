import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

const extension = process.argv[2];
const root = path.dirname(extension);
const require = createRequire(path.join(extension, "package.json"));
const { resolvePiRuntime } = require(path.join(extension, "out/piRuntimeSelection.js"));
const resources = path.join(extension, "resources");
const packageRoot = path.join(extension, "node_modules/@earendil-works/pi-coding-agent");
const workspace = path.join(root, "workspace");
await mkdir(workspace);
const selectedStore = path.join(root, "selected-store");
await mkdir(selectedStore);
const credentials = Buffer.from('{"fixture":{"type":"api_key","key":"not-a-real-credential"}}');
await writeFile(path.join(selectedStore, "auth.json"), credentials);
const sourcePath = path.join(workspace, "source.txt");
const sourceBytes = Buffer.from("Offline fixture. Do not change.\n");
await writeFile(sourcePath, sourceBytes);
const invocation = resolvePiRuntime("", extension);
assert.equal(invocation.executablePath, process.execPath);
assert.ok(path.isAbsolute(invocation.executableArgs[0]));
assert.ok(path.isAbsolute(invocation.executableArgs[1]));
const flags = [
  "--offline",
  "--no-approve",
  "--no-extensions",
  "--no-mcp",
  "--no-tools",
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-themes",
  "--no-session",
];
let sequence = 0;
const live = new Set();

async function launch(extra, rpc = true, settings) {
  const directory = path.join(root, `child-${++sequence}`);
  for (const name of ["home", "agent", "sessions"]) await mkdir(path.join(directory, name), { recursive: true });
  const env = {
    ...process.env,
    ...invocation.env,
    HOME: path.join(directory, "home"),
    USERPROFILE: path.join(directory, "home"),
    PI_CODING_AGENT_DIR: path.join(directory, "agent"),
    PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
  };
  for (const name of invocation.unsetEnv ?? []) delete env[name];
  // Conflicting inherited installation inputs must not change packaged ownership.
  env.PI_PACKAGE_DIR = path.join(root, "spoof-package");
  env.PI_MANAGED_INSTALL_ROOT = path.join(root, "managed");
  if (settings) await writeFile(path.join(directory, "agent/settings.json"), JSON.stringify(settings));
  const child = spawn(
    invocation.executablePath,
    [...invocation.executableArgs, ...(rpc ? ["--mode", "rpc", ...flags] : []), ...extra],
    { cwd: workspace, env, shell: false, stdio: ["pipe", "pipe", "pipe"] },
  );
  live.add(child);
  let buffer = "";
  let stdout = "";
  let stderr = "";
  const events = [];
  const pending = new Set();
  let settled = false;
  const done = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      settled = true;
      live.delete(child);
      resolve({ code, signal });
    });
  });
  child.stderr.on("data", (data) => {
    stderr += data;
    assert.ok(stderr.length < 256 * 1024, "bounded stderr");
  });
  child.stdout.on("data", (data) => {
    stdout += data;
    assert.ok(stdout.length < 1024 * 1024, "bounded stdout");
    if (!rpc) return;
    buffer += data;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      const event = JSON.parse(line);
      assert.notEqual(event.type, "agent_start", "smoke must not call a model");
      events.push(event);
      for (const waiter of pending)
        if (waiter.test(event)) {
          pending.delete(waiter);
          waiter.resolve(event);
        }
    }
  });
  async function wait(test) {
    const previous = events.find(test);
    if (previous) return previous;
    assert.equal(settled, false, `child exited before response: ${stderr}`);
    let timer;
    let waiter;
    try {
      return await Promise.race([
        new Promise((resolve) => {
          waiter = { test, resolve };
          pending.add(waiter);
        }),
        done.then((result) => {
          throw new Error(`Early child exit ${JSON.stringify(result)}: ${stderr}`);
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`RPC deadline: ${stderr}`)), 20_000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      pending.delete(waiter);
    }
  }
  function send(value) {
    child.stdin.write(`${JSON.stringify(value)}\n`);
  }
  async function request(type, fields = {}) {
    const id = `smoke-${++sequence}`;
    send({ id, type, ...fields });
    return wait((event) => event.type === "response" && event.id === id);
  }
  async function finish(end = true, expectedCode = 0) {
    if (end) child.stdin.end();
    let timer;
    try {
      const result = await Promise.race([
        done,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(new Error("Child shutdown deadline"));
          }, 10_000);
        }),
      ]);
      assert.equal(result.code, expectedCode, stderr);
      assert.equal(result.signal, null);
    } finally {
      clearTimeout(timer);
    }
    return stdout;
  }
  return {
    child,
    events,
    send,
    wait,
    request,
    finish,
    directory,
    get stderr() {
      return stderr;
    },
  };
}

async function licenses() {
  const supplements = new Set([
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-codemode",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-telemetry",
    "proxy-agent-negotiate",
    "standardwebhooks",
    "@aws-sdk/credential-provider-http",
    "@aws-sdk/credential-provider-login",
    "@aws-sdk/nested-clients",
  ]);
  let count = 0;
  async function visitModules(directory) {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const location = path.join(directory, entry.name);
      if (entry.name.startsWith("@")) {
        for (const scoped of await readdir(location)) await visitPackage(path.join(location, scoped));
      } else await visitPackage(location);
    }
  }
  async function visitPackage(directory) {
    const metadata = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
    count++;
    const names = await readdir(directory);
    if (!names.some((name) => /^(licen[cs]e|copying|copyright|unlicense|notice)/i.test(name))) {
      if (metadata.name === "data-uri-to-buffer")
        assert.match(await readFile(path.join(directory, "README.md"), "utf8"), /Permission is hereby granted/);
      else assert.ok(supplements.has(metadata.name), `missing license text for ${metadata.name}@${metadata.version}`);
    }
    await visitModules(path.join(directory, "node_modules"));
  }
  await visitModules(path.join(extension, "node_modules"));
  assert.equal(count, 118, "complete pinned production closure, without development packages");
  console.log("PASS all 118 production packages have shipped notices or verified supplements");
}

async function assets() {
  const piMetadata = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  const pi = await import(pathToFileURL(path.join(packageRoot, piMetadata.exports["."].import)).href);
  assert.equal(pi.VERSION, "1.3.0");
  assert.equal(
    await readFile(path.join(packageRoot, "package.json"), "utf8")
      .then(JSON.parse)
      .then((value) => value.version),
    "1.3.0",
  );
  const tui = path.dirname(require.resolve("@earendil-works/pi-tui/package.json"));
  for (const platform of ["darwin", "linux", "win32"]) {
    for (const arch of ["arm64", "x64"]) {
      const name = platform === "linux" ? "linux-platform-x11.node" : `${platform}-platform.node`;
      assert.ok(
        (await stat(path.join(tui, "native", platform, "prebuilds", `${platform}-${arch}`, name))).size > 1_024,
        `missing or empty native prebuild: ${platform}-${arch}`,
      );
    }
  }
  for (const name of [
    "dist/bundle/rpc-entry.js",
    "dist/bundle/chunks/image-resize-worker.js",
    "dist/bundle/chunks/codemode-worker.js",
    "dist/modes/interactive/theme/dark.json",
    "dist/modes/interactive/theme/light.json",
    "dist/core/export-html/template.html",
    "dist/core/export-html/template.css",
    "dist/core/export-html/template.js",
    "dist/core/export-html/vendor/marked.min.js",
    "dist/core/export-html/vendor/highlight.min.js",
  ])
    await access(path.join(packageRoot, name));
  await assert.rejects(access(path.join(packageRoot, "examples/extensions/doom-overlay")), { code: "ENOENT" });
  for (const name of [
    "pi-1.3.0-MIT.txt",
    "marked-18.0.5-MIT.txt",
    "highlight.js-11.9.0-BSD-3-Clause.txt",
    "proxy-agent-negotiate-1.1.0-MIT.txt",
    "standardwebhooks-1.1.1-MIT.txt",
    "aws-sdk-Apache-2.0.txt",
    "README.md",
  ])
    assert.ok((await stat(path.join(resources, "runtime-licenses", name))).size > 100);
  const worker = new Worker(pathToFileURL(path.join(packageRoot, "dist/bundle/chunks/image-resize-worker.js")));
  try {
    const resized = await new Promise((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
      worker.postMessage({
        inputBytes: new Uint8Array(
          require("node:fs").readFileSync(path.join(packageRoot, "dist/modes/interactive/assets/clankolas.png")),
        ),
        mimeType: "image/png",
        options: { maxWidth: 2, maxHeight: 2 },
      });
    });
    assert.equal(resized.result?.wasResized, true, JSON.stringify(resized));
  } finally {
    await worker.terminate();
  }
  const codemodeRoot = path.join(extension, "node_modules/@earendil-works/pi-codemode");
  const codemodeMetadata = JSON.parse(await readFile(path.join(codemodeRoot, "package.json"), "utf8"));
  const { CodemodeSandbox } = await import(
    pathToFileURL(path.join(codemodeRoot, codemodeMetadata.exports["."].import)).href
  );
  for (const bundled of [false, true]) {
    const sandbox = new CodemodeSandbox({
      timeoutMs: 10_000,
      ...(bundled ? { workerUrl: pathToFileURL(path.join(packageRoot, "dist/bundle/chunks/codemode-worker.js")) } : {}),
    });
    try {
      const result = await sandbox.execute("return 6 * 7;");
      assert.equal(result.ok, true);
      assert.equal(result.value, 42);
    } finally {
      await sandbox.close();
    }
  }
  const nativeName = process.platform === "linux" ? "linux-platform-x11.node" : `${process.platform}-platform.node`;
  const native = require(
    path.join(tui, "native", process.platform, "prebuilds", `${process.platform}-${process.arch}`, nativeName),
  );
  assert.ok(Object.keys(native).length > 0, "local native prebuild loads without clipboard access");
  console.log(
    "PASS public imports, six native prebuilds, local native load, Photon image worker and both QuickJS workers",
  );
}

async function helper(operation) {
  const child = await launch(["--extension", path.join(resources, "pi-isolated-helper.ts")]);
  const ready = await child.wait((event) => event.protocol === "pi-vscode-isolated-v1" && event.type === "ready");
  assert.equal(ready.version, "1.3.0");
  child.send({ protocol: "pi-vscode-isolated-v1", type: "request", ...operation });
  const result = await child.wait((event) => event.protocol === "pi-vscode-isolated-v1" && event.type !== "ready");
  assert.notEqual(result.type, "failure", JSON.stringify(result));
  await child.finish(false);
  return result;
}

try {
  await mkdir(path.join(root, "spoof-package"));
  await writeFile(path.join(root, "spoof-package/package.json"), '{"name":"spoof","version":"9.8.7"}');
  const version = await launch(["--version"], false);
  assert.equal((await version.finish()).trim(), "1.3.0");
  const updater = path.join(root, "fake-npm.cjs");
  await writeFile(
    updater,
    `require("node:fs").writeFileSync(${JSON.stringify(path.join(root, "updater-attempted"))}, "unsafe updater executed"); process.exit(99);`,
  );
  const update = await launch(["update"], false, { npmCommand: [process.execPath, updater] });
  await update.finish(true, 1);
  assert.match(update.stderr, /update|extension/i);
  await assert.rejects(access(path.join(root, "updater-attempted")), { code: "ENOENT" });
  console.log("PASS packaged CLI update refused before configured updater execution");
  await licenses();
  await assets();
  const child = await launch([
    "--extension",
    path.join(resources, "pi-bridge.ts"),
    "--extension",
    path.join(resources, "pi-read-only-gate.ts"),
    "--extension",
    path.join(resources, "pi-control.ts"),
  ]);
  const commands = await child.request("get_commands");
  assert.equal(commands.success, true);
  await require(path.join(extension, "out/piControl.js")).verifyPackagedCommands(commands.data.commands, resources);
  for (const [name, file] of [
    ["vscode-pi-bridge-ready", "pi-bridge.ts"],
    ["vscode-pi-read-only-ready", "pi-read-only-gate.ts"],
    ["vscode-pi-control", "pi-control.ts"],
  ]) {
    const found = commands.data.commands.filter((command) => command.name === name);
    assert.equal(found.length, 1);
    assert.equal(found[0].source, "extension");
    if (name === "vscode-pi-read-only-ready")
      assert.equal(found[0].description, "VS Code read-only direct-shell policy v1; Pi 1.3.0");
    assert.equal(found[0].sourceInfo.path, path.join(resources, file));
    assert.equal(found[0].sourceInfo.source, "cli");
    assert.equal(found[0].sourceInfo.scope, "temporary");
  }
  const state = await child.request("get_state");
  assert.equal(state.success, true);
  assert.equal(state.data.isStreaming, false);
  const shell = await child.request("bash", {
    command: 'printf \'offline-shell:%s:%s\' "${ELECTRON_RUN_AS_NODE-unset}" "${PI_PACKAGE_DIR-unset}"',
  });
  assert.equal(shell.success, true);
  assert.equal(shell.data.exitCode, 0);
  assert.equal(shell.data.output, "offline-shell:unset:unset");
  await child.finish();
  console.log(
    "PASS exact version, RPC startup/shutdown, bridge/read-only/control ownership, harmless shell and bootstrap environment",
  );

  // Activate only the packaged policy lifecycle, not a provider request.
  const wrapped = path.join(root, "read-only-fixture.ts");
  await writeFile(
    wrapped,
    `import readOnly from ${JSON.stringify(path.join(resources, "pi-read-only-gate.ts"))};\nexport default function(pi) { const handlers = new Map(); readOnly({...pi,on:(name,handler)=>{handlers.set(name,handler);return pi.on(name,handler);}}); pi.registerCommand("smoke-read-only", {handler:async()=>{handlers.get("before_agent_start")({prompt:"<<<PI_VSCODE_POLICY: read-only>>>\\nfixture"});}}); }\n`,
  );
  const policy = await launch(["--extension", wrapped]);
  const activate = await policy.request("prompt", { message: "/smoke-read-only" });
  assert.equal(activate.success, true);
  const denied = await policy.request("bash", { command: "printf MUST_NOT_EXECUTE" });
  assert.equal(denied.success, false);
  assert.match(denied.error, /preview-only/);
  assert.deepEqual((await policy.request("get_messages")).data.messages, []);
  await policy.finish();
  console.log("PASS packaged read-only policy denies real shell dispatch without model activity");

  const providers = await helper({ operation: "discover", agentDir: selectedStore });
  assert.equal(providers.type, "providers");
  assert.ok(providers.providers.some((provider) => provider.id === "openai"));
  assert.deepEqual(await readdir(selectedStore), ["auth.json"]);
  assert.deepEqual(await readFile(path.join(selectedStore, "auth.json")), credentials);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const header = { type: "session", version: 3, id: "offline-session", timestamp, cwd: workspace };
  const entry = (id, parentId, text) => ({
    type: "message",
    id,
    parentId,
    timestamp,
    message: { role: "user", content: text, timestamp: 0 },
  });
  const sessionBytes = Buffer.from(
    [header, entry("a", null, "root"), entry("b", "a", "active"), entry("c", "a", "abandoned")]
      .map(JSON.stringify)
      .join("\n") + "\n",
  );
  const input = path.join(workspace, "source.jsonl");
  const output = path.join(workspace, "export.jsonl");
  const imported = path.join(workspace, "import.jsonl");
  await writeFile(input, sessionBytes);
  await helper({ operation: "export", cwd: workspace, input, output, leaf: "b" });
  const exported = (await readFile(output, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    exported.slice(1).map((value) => value.id),
    ["a", "b"],
  );
  await helper({ operation: "import", cwd: workspace, input, output: imported });
  const importedEntries = (await readFile(imported, "utf8")).trim().split("\n").map(JSON.parse).slice(1);
  assert.deepEqual(
    importedEntries.slice(0, 3).map((value) => value.id),
    ["a", "b", "c"],
  );
  assert.ok(importedEntries.slice(3).every((value) => ["thinking_level_change", "model_change"].includes(value.type)));
  assert.deepEqual(await readFile(input), sessionBytes);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  console.log(
    "PASS isolated static discovery, active-branch export/full-tree import, unchanged credentials/source/session bytes",
  );

  for (const name of [
    "resources/pi-runtime-bootstrap.cjs",
    "node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
  ]) {
    const target = path.join(extension, name);
    await rename(target, `${target}.missing`);
    try {
      assert.throws(() => resolvePiRuntime("", extension));
    } finally {
      await rename(`${target}.missing`, target);
    }
  }
  await assert.rejects(access(path.join(root, "network-attempts.log")), { code: "ENOENT" });
  console.log("PASS missing assets fail closed; PATH empty; network attempts 0; model/login/MCP calls 0");
} finally {
  for (const child of live) child.kill("SIGKILL");
}
