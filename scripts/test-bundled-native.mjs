import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

// Compile first. No installation, model request, credential access, or existing profile is required.
// Evidence and disposable profiles are retained, including on failure.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.140.0";
const trusted = process.argv[3] !== "untrusted";
assert.ok(process.argv.length <= 4, "Usage: node scripts/test-bundled-native.mjs [version] [untrusted]");
assert.ok(process.argv[3] === undefined || process.argv[3] === "untrusted", "Only untrusted is a valid mode");
// Never run an app with a fabricated HOME: macOS can prompt to reset the login Keychain.
assert.equal(
  await realpath(process.env.HOME ?? homedir()),
  await realpath(userInfo().homedir),
  "Native validation requires the actual account HOME; do not use a temporary HOME",
);
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-bundled-native-")));
console.log(`Retained native evidence: ${directory}`);
const workspace = path.join(directory, "workspace");
const userData = path.join(directory, "user");
const agent = path.join(directory, "pi-agent");
for (const name of [workspace, path.join(userData, "User"), path.join(agent, "extensions")])
  await mkdir(name, { recursive: true });
await writeFile(path.join(workspace, "fixture.txt"), "Offline bundled runtime fixture.\n");
await writeFile(path.join(agent, "settings.json"), JSON.stringify({ packages: [] }));
await writeFile(
  path.join(agent, "extensions", "native-evidence.ts"),
  `import { appendFileSync } from "node:fs";
export default function (pi) {
  pi.on("before_agent_start", () => { throw new Error("Native fixture forbids model requests"); });
  pi.on("session_start", (_event, ctx) => {
    process.title = process.env.PI_VSCODE_BUNDLED_OWNER;
    appendFileSync(process.env.PI_VSCODE_BUNDLED_EVENTS, JSON.stringify({
      pid: process.pid, tty: Boolean(process.stdin.isTTY),
      sessionId: ctx.sessionManager.getSessionId(), sessionFile: ctx.sessionManager.getSessionFile(),
      home: process.env.HOME, path: process.env.PATH, execPath: process.execPath,
      electronRunAsNode: process.env.ELECTRON_RUN_AS_NODE ?? null,
      packageDir: process.env.PI_PACKAGE_DIR ?? null,
      argv: process.argv.slice(2),
    }) + "\\n");
  });
}
`,
);
await writeFile(
  path.join(userData, "User", "settings.json"),
  JSON.stringify({
    "security.workspace.trust.startupPrompt": "never",
    "workbench.startupEditor": "none",
    "workbench.enableExperiments": false,
    "telemetry.telemetryLevel": "off",
    "update.mode": "none",
    "extensions.autoUpdate": false,
    "extensions.autoCheckUpdates": false,
    "chat.disableAIFeatures": true,
    "git.enabled": false,
    "terminal.integrated.enablePersistentSessions": false,
    "terminal.integrated.shellIntegration.enabled": false,
    "window.restoreWindows": "none",
    "files.hotExit": "off",
    "pi.approveProjectResources": false,
  }),
);
const executable = await downloadAndUnzipVSCode({
  version,
  cachePath: path.join(tmpdir(), "pi-vscode-native-cache"),
});
const application =
  process.platform === "darwin"
    ? path.resolve(executable, "../../Resources/app")
    : path.join(path.dirname(executable), "resources", "app");
// Fail closed before launch if the supported flag or its keychain bypass cannot be verified.
const cli = await readFile(path.join(application, "out", "cli.js"), "utf8");
const workbench = await readFile(path.join(application, "out", "vs", "workbench", "workbench.desktop.main.js"), "utf8");
assert.match(cli, /"use-inmemory-secretstorage":\{type:"boolean"/);
assert.match(workbench, /super\(!!\w+\.useInMemorySecretStorage,/);
assert.match(workbench, /!this\._useInMemoryStorage&&await this\._encryptionService\.isEncryptionAvailable\(\)/);
const disabled = ["vscode.github-authentication", "vscode.microsoft-authentication", "GitHub.copilot-chat"];
const args = [
  workspace,
  "--new-window",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-updates",
  "--disable-telemetry",
  "--disable-experiments",
  "--disable-crash-reporter",
  "--skip-welcome",
  "--skip-release-notes",
  "--skip-add-to-recently-opened",
  "--force-disable-user-env",
  "--use-inmemory-secretstorage",
  "--sync=off",
  "--user-data-dir",
  userData,
  "--shared-data-dir",
  path.join(directory, "shared"),
  "--extensions-dir",
  path.join(directory, "extensions"),
  ...disabled.map((id) => `--disable-extension=${id}`),
  `--extensionDevelopmentPath=${repository}`,
  `--extensionTestsPath=${path.join(repository, "out", "test", "nativeBundledRuntime.js")}`,
];
if (trusted) args.push("--disable-workspace-trust");
const environment = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    /^(HOME|USER|LOGNAME|SHELL|PATH|TMPDIR|TMP|TEMP|LANG|LC_.*|DISPLAY|WAYLAND_DISPLAY|XAUTHORITY|XDG_RUNTIME_DIR|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|USERPROFILE)$/i.test(
      key,
    ),
  ),
);
Object.assign(environment, {
  PATH: "",
  PI_CODING_AGENT_DIR: agent,
  PI_VSCODE_BUNDLED_OWNER: `pi-native-${path.basename(directory)}`,
  PI_CODING_AGENT_SESSION_DIR: path.join(directory, "sessions"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
  PI_VSCODE_BUNDLED_DIRECTORY: directory,
  PI_VSCODE_BUNDLED_EVENTS: path.join(directory, "events.jsonl"),
  PI_VSCODE_BUNDLED_EXPECT_TRUST: String(trusted),
  PI_VSCODE_BUNDLED_ORIGINAL_HOME: process.env.HOME ?? homedir(),
});
await writeFile(
  path.join(directory, "launch.json"),
  JSON.stringify(
    {
      executable,
      args,
      requestedVersion: version,
      trusted,
      originalHomePreserved: true,
      secretStorage: "in-memory; installed source bypass verified",
      disabledExtensions: disabled,
    },
    null,
    2,
  ),
);
const log = createWriteStream(path.join(directory, "native.log"), { flags: "wx" });
const child = spawn(executable, args, {
  env: environment,
  stdio: ["ignore", "pipe", "pipe"],
  shell: false,
  detached: process.platform !== "win32",
});
child.stdout.on("data", (chunk) => {
  log.write(chunk);
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  log.write(chunk);
  process.stderr.write(chunk);
});
const signalOwned = (signal) => {
  if (!child.pid) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
const interrupt = () => signalOwned("SIGTERM");
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  await new Promise((resolve, reject) => {
    let killTimer;
    const timer = setTimeout(() => {
      signalOwned("SIGTERM");
      killTimer = setTimeout(() => {
        signalOwned("SIGKILL");
        reject(new Error("Native bundled validation exceeded 120 seconds"));
      }, 3_000);
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      code === 0 ? resolve() : reject(new Error(`Native bundled validation exited ${code ?? signal}`));
    });
  });
  console.log(await readFile(path.join(directory, "evidence.json"), "utf8"));
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
  signalOwned("SIGKILL");
  // A deadline can bypass fixture finally. Kill only PIDs whose current process title proves ownership.
  // Never scan by app name or read credential stores. Keep failure profiles and logs intact.
  if (process.platform !== "win32") {
    let events = [];
    try {
      events = (await readFile(environment.PI_VSCODE_BUNDLED_EVENTS, "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    } catch (error) {
      if (error.code !== "ENOENT") {
        console.error("Owned Pi cleanup evidence could not be read; inspect the retained profile.");
        process.exitCode = 1;
      }
    }
    for (const pid of new Set(events.map((event) => event.pid))) {
      if (!Number.isSafeInteger(pid) || pid <= 1) continue;
      let title;
      try {
        title = execFileSync("/bin/ps", ["-p", String(pid), "-o", "command="], {
          encoding: "utf8",
          timeout: 2_000,
          stdio: ["ignore", "pipe", "ignore"],
        }).trim();
      } catch {
        continue;
      }
      if (title !== environment.PI_VSCODE_BUNDLED_OWNER) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") {
          console.error("Owned Pi cleanup could not be verified; inspect the retained profile.");
          process.exitCode = 1;
        }
      }
    }
  }
  await new Promise((resolve) => log.end(resolve));
}
