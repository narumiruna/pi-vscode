import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { openConversationDetails } from "./composer-navigation-fixture.mjs";

// Real VS Code Server + remote Node Extension Host. No live Pi provider or user profile is used.
const server = process.argv[2];
assert.equal(process.platform, "linux", "This remote draft runner currently checks Linux only.");
if (!server || !path.isAbsolute(server)) throw new Error("Supply an absolute VS Code Server bin/code-server path.");
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(path.join(tmpdir(), "pi-remote-drafts-"));
const workspace = path.join(directory, "workspace");
const extensions = path.join(directory, "extensions");
const data = path.join(directory, "server-data");
const profile = path.join(directory, "browser-profile");
const home = path.join(directory, "home");
const token = randomBytes(24).toString("hex");
const tokenFile = path.join(directory, "connection-token");
const marker = `unsent-remote-draft-${randomBytes(12).toString("hex")}`;
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
let interrupted;
let interrupt;
const interruption = new Promise((resolve) => {
  interrupt = resolve;
});
const checkInterrupted = () => {
  if (interrupted) throw new Error(`Interrupted by ${interrupted}`);
};
const onSignal = (signal) => {
  interrupted ??= signal;
  process.exitCode = interrupted === "SIGINT" ? 130 : 143;
  interrupt();
};
process.on("SIGINT", onSignal);
process.on("SIGTERM", onSignal);
async function bounded(operation, label, timeout = 2000) {
  let timer;
  try {
    return await Promise.race([
      operation,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function until(probe, label, timeout = 45_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    checkInterrupted();
    const value = await probe();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const json = (name) =>
  readFile(path.join(directory, name), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
let child;
let context;
let output = "";
let cleanupPromise;
// Verify the random owned environment and session/group before each group signal.
// Do not signal an unrelated group if the original numeric PID has been reused.
async function ownsServerGroup() {
  if (!child?.pid) return false;
  for (const pid of await readdir("/proc")) {
    if (!/^\d+$/.test(pid)) continue;
    try {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (Number(fields[2]) !== child.pid || Number(fields[3]) !== child.pid) continue;
      const environment = await readFile(`/proc/${pid}/environ`, "utf8");
      if (environment.split("\0").includes(`PI_VSCODE_UI_FIXTURE=${directory}`)) return true;
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
  return false;
}
function cleanup() {
  if (cleanupPromise) return cleanupPromise;
  cleanupPromise = (async () => {
    const attempt = async (operation, label, timeout) => {
      try {
        await bounded(operation(), label, timeout);
      } catch (error) {
        if (error.code === "ESRCH") return;
        process.exitCode ||= 1;
        console.error(`Cleanup ${label}: ${error}`);
      }
    };
    await attempt(async () => context?.close(), "browser close");
    await attempt(async () => {
      if (await ownsServerGroup()) process.kill(-child.pid, "SIGTERM");
    }, "owned server TERM");
    await delay(500);
    await attempt(async () => {
      if (await ownsServerGroup()) process.kill(-child.pid, "SIGKILL");
      const end = Date.now() + 1500;
      while (await ownsServerGroup()) {
        if (Date.now() >= end) throw new Error("Owned server group did not stop");
        await delay(50);
      }
    }, "owned server KILL");
    child?.stdout?.destroy();
    child?.stderr?.destroy();
    await attempt(() => rm(directory, { recursive: true, force: true }), "owned temporary directory removal", 5000);
  })();
  return cleanupPromise;
}
try {
  await Promise.all([mkdir(path.join(workspace, ".vscode"), { recursive: true }), mkdir(extensions), mkdir(home)]);
  await mkdir(path.join(home, "runtime"), { mode: 0o700 });
  const ownedEnv = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TZ", "TMPDIR"].includes(key)),
    ),
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, "config"),
    XDG_CACHE_HOME: path.join(home, "cache"),
    XDG_DATA_HOME: path.join(home, "data"),
    XDG_RUNTIME_DIR: path.join(home, "runtime"),
    PI_CODING_AGENT_DIR: path.join(directory, "pi"),
    PI_VSCODE_UI_FIXTURE: directory,
  };
  await writeFile(tokenFile, token, { mode: 0o600 });
  const pi = path.join(extensions, "narumi.narumi-pi-0.5.1");
  await mkdir(pi);
  for (const name of ["package.json", "out", "resources"])
    await cp(path.join(repository, name), path.join(pi, name), { recursive: true });
  const fixture = path.join(directory, "pi-fixture");
  await cp(path.join(repository, "scripts/fixtures/native-pi.cjs"), fixture);
  await chmod(fixture, 0o700);
  await writeFile(
    path.join(workspace, ".vscode/settings.json"),
    JSON.stringify({
      "pi.executablePath": fixture,
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "telemetry.telemetryLevel": "off",
      "files.autoSave": "off",
      "extensions.ignoreRecommendations": true,
    }),
  );
  await writeFile(path.join(workspace, "source.ts"), "export const fixture = true;\n");
  const coordinator = path.join(extensions, "fixture.remote-draft-probe-0.0.1");
  await mkdir(coordinator);
  await writeFile(
    path.join(coordinator, "package.json"),
    JSON.stringify({
      name: "remote-draft-probe",
      publisher: "fixture",
      version: "0.0.1",
      engines: { vscode: "^1.140.0" },
      main: "./main.cjs",
      extensionKind: ["workspace"],
      activationEvents: ["onStartupFinished"],
    }),
  );
  await writeFile(
    path.join(coordinator, "main.cjs"),
    `
const vscode = require('vscode'), fs = require('node:fs'), path = require('node:path');
exports.activate = async context => {
  const root = process.env.PI_VSCODE_UI_FIXTURE;
  const pi = vscode.extensions.getExtension('narumi.narumi-pi');
  await pi.activate();
  await vscode.commands.executeCommand('pi.openChat');
  fs.writeFileSync(path.join(root, 'remote-ready.json'), JSON.stringify({
    version: vscode.version, remoteName: vscode.env.remoteName, uiKind: vscode.env.uiKind,
    scheme: vscode.workspace.workspaceFolders[0].uri.scheme, workspace: vscode.workspace.workspaceFolders[0].uri.toString(),
    pid: process.pid, home: process.env.HOME, extension: pi.extensionUri.toString(),
    storage: context.storageUri?.toString(), globalStorage: context.globalStorageUri.toString(),
  }));
};`,
  );
  checkInterrupted();
  child = spawn(
    server,
    [
      "--start-server",
      "--host",
      "127.0.0.1",
      "--port",
      "0",
      "--connection-token-file",
      tokenFile,
      "--server-data-dir",
      data,
      "--extensions-dir",
      extensions,
      "--disable-workspace-trust",
      "--telemetry-level",
      "off",
      "--accept-server-license-terms",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
      env: ownedEnv,
    },
  );
  const log = (chunk) => {
    output = (output + chunk.toString()).slice(-100_000);
  };
  child.stdout.on("data", log);
  child.stderr.on("data", log);
  child.on("error", (error) => {
    output += String(error);
  });
  const port = await until(() => /Extension host agent listening on (\d+)/.exec(output)?.[1], "remote server listen");
  const origin = `http://127.0.0.1:${port}`;
  checkInterrupted();
  context = await chromium.launchPersistentContext(profile, {
    timeout: 15_000,
    headless: true,
    env: ownedEnv,
    viewport: { width: 1200, height: 900 },
  });
  checkInterrupted();
  // Setup and browser launch settle before cleanup can remove their owned files.
  // Once the browser exists, interruption can stop even a pending browser operation.
  await Promise.race([
    (async () => {
      // Block telemetry/provider traffic. Only the loopback server and VS Code's static webview bootstrap are needed.
      await context.route("**/*", (route) => {
        const url = new URL(route.request().url());
        if (
          url.origin === origin ||
          (url.hostname.endsWith(".vscode-cdn.net") &&
            url.pathname.includes("/out/vs/workbench/contrib/webview/browser/pre/"))
        ) {
          return route.continue();
        }
        return route.abort();
      });
      const page = context.pages()[0];
      page.setDefaultTimeout(20_000);
      await page.goto(`${origin}/?tkn=${token}&folder=${encodeURIComponent(workspace)}`);
      const ready = await until(() => json("remote-ready.json"), "remote workspace Extension Host", 60_000);
      assert.equal(ready.uiKind, 2, "web client must connect to the remote Node Extension Host");
      // The remote Node host receives file URIs through VS Code's remote URI transformer.
      assert.equal(ready.scheme, "file");
      assert.equal(fileURLToPath(ready.extension), pi);
      assert.ok(ready.remoteName, "a real remote authority is required, not a mocked host");
      assert.notEqual(ready.pid, process.pid);
      assert.equal(ready.home, home, "only disposable host state is allowed");
      const frame = () =>
        until(async () => {
          for (const candidate of page.frames()) {
            try {
              if (await candidate.locator("#input").count()) return candidate;
            } catch (error) {
              if (!candidate.isDetached()) throw error;
            }
          }
          return undefined;
        }, "Pi webview frame");
      let current = await frame();
      await current.locator("#input").waitFor();
      const expand = async () => {
        await openConversationDetails(current, page);
        const details = current.locator("#text-draft-recovery");
        if (!(await details.evaluate((node) => node.open))) await details.locator("summary").click();
      };
      const retained = () =>
        page.evaluate(async (marker) => {
          const matches = [];
          for (const entry of await indexedDB.databases()) {
            if (!entry.name) continue;
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open(entry.name);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            for (const name of Array.from(db.objectStoreNames)) {
              const store = db.transaction(name, "readonly").objectStore(name);
              const read = (request) =>
                new Promise((resolve, reject) => {
                  request.onsuccess = () => resolve(request.result);
                  request.onerror = () => reject(request.error);
                });
              // VS Code versions can store a string value under an out-of-line IndexedDB key.
              const [keys, values] = await Promise.all([read(store.getAllKeys()), read(store.getAll())]);
              for (let index = 0; index < values.length; index += 1) {
                const value = values[index];
                const serialized = typeof value === "string" ? value : value?.value;
                if (typeof serialized !== "string" || !serialized.includes(marker)) continue;
                let state;
                try {
                  state = JSON.parse(serialized);
                } catch {
                  continue;
                }
                if (
                  keys[index] === "narumi.narumi-pi" &&
                  state?.["pi.sidebar.drafts.v1"]?.records?.some((record) => record.text === marker)
                ) {
                  matches.push({ database: entry.name, store: name, key: keys[index], serialized });
                }
              }
            }
            db.close();
          }
          return matches;
        }, marker);
      await current.locator("#input").fill(marker);
      await current.locator("#input").press("Tab");
      await delay(750);
      assert.deepEqual(await retained(), [], "retention is off before explicit consent");
      await expand();
      await current.locator("#enable-text-drafts:not([disabled])").click();
      await page.getByRole("button", { name: "Enable Draft Recovery", exact: true }).click();
      await until(async () => await current.locator("#disable-text-drafts").isVisible(), "explicit retention approval");
      await current.locator("#conversation-details-close").click();
      await current.locator("#input").focus();
      await current.locator("#input").press("Tab");
      const stored = await until(async () => {
        const locations = await retained();
        return locations.length ? locations : undefined;
      }, "actual draft envelope in the client browser workspace database");
      const serverDraftRows = [];
      const scanServer = async (root) => {
        for (const entry of await readdir(root, { withFileTypes: true })) {
          const filename = path.join(root, entry.name);
          if (entry.isDirectory()) await scanServer(filename);
          else if (entry.isFile() && entry.name === "state.vscdb") {
            const database = new DatabaseSync(filename, { readOnly: true });
            try {
              const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get("narumi.narumi-pi");
              if (row && Buffer.from(row.value).toString("utf8").includes(marker)) serverDraftRows.push(filename);
            } finally {
              database.close();
            }
          }
        }
      };
      await scanServer(data);
      assert.deepEqual(
        serverDraftRows,
        [],
        "the remote server's active storage rows do not retain this workspaceState draft",
      );
      await page.reload();
      current = await frame();
      await current.locator("#text-draft-notice").waitFor({ state: "visible" });
      assert.equal(await current.locator("#conversation-details").evaluate((node) => node.open), false);
      assert.equal(await current.locator("#input").inputValue(), "");
      await expand();
      await current.locator("#restore-text-draft").click();
      await until(
        async () => (await current.locator("#input").inputValue()) === marker,
        "explicit remote text Restore",
      );
      assert.equal(
        await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => ""),
        "",
        "recovery must not call a model",
      );
      await expand();
      await current.locator("#disable-text-drafts").click();
      const disabled = await until(async () => {
        const states = await page.evaluate(async (locations) => {
          const databases = await indexedDB.databases();
          const states = [];
          for (const { database, store, key } of locations) {
            if (!databases.some((entry) => entry.name === database))
              throw new Error(`Missing observed database: ${database}`);
            const db = await new Promise((resolve, reject) => {
              const request = indexedDB.open(database);
              request.onsuccess = () => resolve(request.result);
              request.onerror = () => reject(request.error);
            });
            try {
              const value = await new Promise((resolve, reject) => {
                const request = db.transaction(store, "readonly").objectStore(store).get(key);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
              });
              const serialized = typeof value === "string" ? value : value?.value;
              if (value !== undefined && typeof serialized !== "string")
                throw new Error("Invalid observed extension row");
              const state = value === undefined ? {} : JSON.parse(serialized);
              if (!state || typeof state !== "object" || Array.isArray(state))
                throw new Error("Invalid extension state");
              states.push({
                database,
                store,
                key,
                draftKeyPresent: Object.hasOwn(state, "pi.sidebar.drafts.v1"),
                serialized,
              });
            } finally {
              db.close();
            }
          }
          return states;
        }, stored);
        return states.every((state) => !state.draftKeyPresent) ? states : undefined;
      }, "Disable removes the own pi.sidebar.drafts.v1 property at each observed client database/store/key");
      assert.ok(disabled.every((state) => state.draftKeyPresent === false));
      console.log(
        "PI_REMOTE_DRAFT_EVIDENCE",
        JSON.stringify({
          version: ready.version,
          platform: process.platform,
          remoteName: ready.remoteName,
          hostWorkspaceScheme: ready.scheme,
          host: "separate remote Node Extension Host; loopback VS Code Server",
          storage: stored,
          client: "disposable Chromium IndexedDB workspace state",
          serverDraftRows: serverDraftRows.length,
          consent: "off before explicit approval",
          reload: "actual web workbench reload",
          restore: "explicit, text-only",
          disable: "own pi.sidebar.drafts.v1 property absent at each observed client database/store/key",
          disabledStorage: disabled,
          modelCalls: 0,
        }),
      );
    })(),
    interruption,
  ]);
} catch (error) {
  if (!interrupted) {
    console.error(output.replaceAll(token, "[connection token redacted]").slice(-15_000));
    if (context)
      console.error(
        (await bounded(context.pages()[0].locator("body").innerText(), "failure diagnostics").catch(() => "")).slice(
          -4000,
        ),
      );
    throw new Error(String(error).replaceAll(token, "[connection token redacted]"));
  }
} finally {
  await cleanup();
  process.off("SIGINT", onSignal);
  process.off("SIGTERM", onSignal);
  if (interrupted) process.exit(process.exitCode);
}
