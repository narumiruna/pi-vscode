// Extract the supplied artifact, then run every runtime probe outside the checkout.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const yauzl = require("yauzl");
const archive = path.resolve(process.argv[2] ?? "pi.vsix");
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-vsix-offline-")));

async function extract() {
  const zip = await new Promise((resolve, reject) =>
    yauzl.open(archive, { lazyEntries: true, autoClose: false }, (error, value) =>
      error ? reject(error) : resolve(value),
    ),
  );
  const active = new Set();
  try {
    await new Promise((resolve, reject) => {
      zip.on("error", reject);
      zip.on("end", resolve);
      zip.on("entry", async (entry) => {
        try {
          const target = path.resolve(directory, entry.fileName);
          assert.ok(target.startsWith(`${directory}${path.sep}`), "archive path escapes extraction");
          assert.notEqual(
            (entry.externalFileAttributes >>> 16) & 0o170000,
            0o120000,
            "archive must not contain symlinks",
          );
          const task = (async () => {
            if (entry.fileName.endsWith("/")) await mkdir(target, { recursive: true });
            else {
              await mkdir(path.dirname(target), { recursive: true });
              const stream = await new Promise((accept, fail) =>
                zip.openReadStream(entry, (error, value) => (error ? fail(error) : accept(value))),
              );
              await pipeline(stream, createWriteStream(target, { flags: "wx" }));
            }
          })();
          active.add(task);
          task.then(() => active.delete(task), reject);
          if (active.size >= 32) await Promise.race(active);
          zip.readEntry();
        } catch (error) {
          reject(error);
        }
      });
      zip.readEntry();
    });
    await Promise.all(active);
  } finally {
    zip.close();
  }
}

async function snapshot(root) {
  const hash = createHash("sha256");
  const names = [];
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isDirectory()) continue;
    assert.ok(entry.isFile(), "extracted artifact contains only files and directories");
    names.push(path.relative(root, path.join(entry.parentPath, entry.name)));
  }
  names.sort();
  for (let offset = 0; offset < names.length; offset += 32) {
    const batch = names.slice(offset, offset + 32);
    const contents = await Promise.all(batch.map((name) => readFile(path.join(root, name))));
    for (let index = 0; index < batch.length; index++) {
      hash.update(batch[index]);
      hash.update(contents[index]);
    }
  }
  return hash.digest("hex");
}

let runtimeChild;
function stopRuntime() {
  if (!runtimeChild?.pid) return;
  if (process.platform === "win32") {
    spawnSync(
      path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
      ["/F", "/T", "/PID", String(runtimeChild.pid)],
      { shell: false, windowsHide: true, timeout: 5_000, stdio: "ignore" },
    );
  } else {
    try {
      process.kill(-runtimeChild.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
}
for (const [signal, status] of [
  ["SIGINT", 130],
  ["SIGTERM", 143],
]) {
  process.once(signal, () => {
    stopRuntime();
    process.exit(status);
  });
}
const deadline = setTimeout(() => {
  stopRuntime();
  console.error(`Artifact verification exceeded 240 seconds; retained extraction: ${directory}`);
  process.exit(1);
}, 240_000);
try {
  console.log("Extracting VSIX outside the checkout...");
  await extract();
  console.log("Checking extracted artifact bytes...");
  const extension = path.join(directory, "extension");
  const before = await snapshot(extension);
  const fixtures = path.join(directory, "probes");
  await cp(fileURLToPath(new URL("fixtures/bundled-runtime", import.meta.url)), fixtures, { recursive: true });
  const home = path.join(directory, "home");
  await mkdir(home);
  const env = {
    PATH: "",
    HOME: home,
    USERPROFILE: home,
    APPDATA: path.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: path.join(home, "AppData", "Local"),
    TMPDIR: directory,
    TMP: directory,
    TEMP: directory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
    NODE_OPTIONS: `--require=${JSON.stringify(path.join(fixtures, "network-guard.cjs"))}`,
  };
  for (const key of ["SystemRoot", "SYSTEMROOT", "ComSpec", "ProgramFiles", "ProgramFiles(x86)"]) {
    if (process.env[key]) env[key] = process.env[key];
  }
  const code = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(fixtures, "smoke.mjs"), extension], {
      cwd: directory,
      env,
      shell: false,
      detached: process.platform !== "win32",
      stdio: "inherit",
    });
    runtimeChild = child;
    const timer = setTimeout(() => {
      stopRuntime();
      reject(new Error("Extracted runtime smoke exceeded 180 seconds"));
    }, 180_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (status, signal) => {
      clearTimeout(timer);
      resolve(status ?? signal);
    });
  });
  assert.equal(code, 0, "extracted VSIX offline smoke failed");
  assert.equal(await snapshot(extension), before, "runtime smoke changed the extracted extension");
  console.log(
    JSON.stringify({
      artifact: path.basename(archive),
      bytes: (await stat(archive)).size,
      sha256: createHash("sha256")
        .update(await readFile(archive))
        .digest("hex"),
      extensionBytesUnchanged: true,
      platform: process.platform,
      arch: process.arch,
      node: process.versions.node,
    }),
  );
} finally {
  clearTimeout(deadline);
  stopRuntime();
  await rm(directory, { recursive: true, force: true });
}
