// Real Linux Orca/AT-SPI validation. Never replaces Orca speech or navigation code.
// After compile: node scripts/test-screen-reader.mjs /path/to/extracted-debs/root [1.106.0|stable]
// Requires system Python GI, at-spi2-core, uv, dbus-run-session, Xvfb and extracted Orca/GI/xdotool
// dependencies. The prefix contains usr/bin/orca and usr/lib/python3/dist-packages/orca.
// Speech Dispatcher is deliberately unavailable: assertions use Orca's actual SPEECH OUTPUT logs,
// not audio, a human usability review, DOM accessible-name assertions, or a CDP accessibility tree.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { chromium } from "playwright-core";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const isolated = process.argv[2] === "--isolated";
const prefix = path.resolve(process.argv[isolated ? 4 : 2] ?? "");
const version = process.argv[isolated ? 5 : 3] ?? "1.106.0";
assert.equal(process.platform, "linux", "This runner checks Linux desktop only.");
assert.equal(process.arch, "x64", "The extracted dependency layout is Linux x64 only.");
assert.ok(process.argv[isolated ? 4 : 2], "Supply the extracted Orca dependency prefix.");
await readFile(path.join(prefix, "usr/bin/orca"));
const directory = isolated ? process.argv[3] : await mkdtemp(path.join(tmpdir(), "pi-screen-reader-"));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const ledgerPath = path.join(directory, "owned-processes.json");
function processIdentity(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1].trim().split(/\s+/);
    return { pid: Number(pid), group: Number(stat[2]), session: Number(stat[3]), start: stat[19] };
  } catch {
    return undefined;
  }
}
function recordChild(child, kind = "application") {
  assert.ok(child.pid, "Owned subprocess did not spawn.");
  const identity = processIdentity(child.pid);
  assert.ok(identity && identity.group === child.pid && identity.session === child.pid);
  const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
  ledger.push({ ...identity, kind });
  writeFileSync(ledgerPath, JSON.stringify(ledger));
}
async function cleanupOwnedGroups(includeSession = false) {
  const recorded = await readFile(ledgerPath, "utf8")
    .then(JSON.parse)
    .catch(() => []);
  const ledger = recorded.filter((entry) => includeSession || entry.kind !== "session");
  const verifiedGroups = new Set();
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const owned of ledger) {
      const leader = processIdentity(owned.pid);
      let verified = leader?.start === owned.start && leader.group === owned.group && leader.session === owned.session;
      // A detached leader can exit before its children. Require an owned-directory command line
      // in the original session/group before signalling those remaining descendants.
      if (!leader) {
        for (const pid of await readdir("/proc")) {
          if (!/^\d+$/.test(pid)) continue;
          const member = processIdentity(pid);
          if (
            member?.group !== owned.group ||
            member.session !== owned.session ||
            BigInt(member.start) < BigInt(owned.start)
          )
            continue;
          const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
          if (command.includes(directory) || verifiedGroups.has(owned.group)) {
            verified = true;
            break;
          }
        }
      }
      if (verified) {
        verifiedGroups.add(owned.group);
        try {
          process.kill(-owned.group, signal);
        } catch {}
      }
    }
    await delay(500);
  }
}

if (!isolated) {
  // Do not inherit the real display, D-Bus, profile, provider credentials or clipboard.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ["PATH", "LANG", "LC_ALL", "TZ"].includes(key)),
  );
  for (const [key, name] of Object.entries({
    HOME: "home",
    XDG_CONFIG_HOME: "config",
    XDG_CACHE_HOME: "cache",
    XDG_DATA_HOME: "data",
    XDG_RUNTIME_DIR: "runtime",
    UV_CACHE_DIR: "uv-cache",
  })) {
    env[key] = path.join(directory, name);
    await mkdir(env[key], { recursive: true, mode: 0o700 });
  }
  Object.assign(env, {
    LD_LIBRARY_PATH: path.join(prefix, "usr/lib/x86_64-linux-gnu"),
    GI_TYPELIB_PATH: path.join(prefix, "usr/lib/x86_64-linux-gnu/girepository-1.0"),
    PYTHONPATH: path.join(prefix, "usr/lib/python3/dist-packages"),
    GSETTINGS_BACKEND: "memory",
    GSETTINGS_SCHEMA_DIR: path.join(prefix, "usr/share/glib-2.0/schemas"),
    XDG_DATA_DIRS: `${path.join(prefix, "usr/share")}:/usr/share`,
    NO_AT_BRIDGE: "0",
    ACCESSIBILITY_ENABLED: "1",
    SPEECHD_ADDRESS: `unix_socket:${path.join(directory, "no-speech-dispatcher.sock")}`,
    SPEECHD_CMD: "/bin/false",
  });
  await writeFile(ledgerPath, "[]");
  console.log(`Screen-reader evidence: ${directory}`);
  const child = spawn(
    "dbus-run-session",
    [
      "--",
      "xvfb-run",
      "-a",
      "-s",
      "-screen 0 1440x1000x24",
      process.execPath,
      fileURLToPath(import.meta.url),
      "--isolated",
      directory,
      prefix,
      version,
    ],
    { env, stdio: "inherit", detached: true },
  );
  child.once("error", () => {});
  recordChild(child, "session");
  let timedOut = false;
  let interrupted = false;
  let escalation;
  const terminate = () => {
    if (!child.pid) return;
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {}
    escalation ??= setTimeout(() => {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {}
    }, 1500);
  };
  const interrupt = () => {
    interrupted = true;
    terminate();
  };
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const timer = setTimeout(() => {
    timedOut = true;
    terminate();
  }, 150_000);
  try {
    const result = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code ?? 1));
    });
    assert.ok(!timedOut, "Screen-reader validation exceeded 150 seconds.");
    assert.ok(!interrupted, "Screen-reader validation was interrupted.");
    process.exitCode = result;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    process.removeListener("SIGINT", interrupt);
    process.removeListener("SIGTERM", interrupt);
    await cleanupOwnedGroups(true);
  }
} else {
  assert.ok(process.env.DISPLAY && !/^:0(?:\.0)?$/.test(process.env.DISPLAY), "Use only disposable Xvfb.");
  assert.ok(process.env.DBUS_SESSION_BUS_ADDRESS);
  const debug = path.join(directory, "orca-debug.log");
  const steps = [];
  let code;
  let orca;
  let browser;
  let codeLog = "";
  let orcaLog = "";
  async function until(fn, label, timeout = 35_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) {
      const value = await fn();
      if (value) return value;
      await delay(150);
    }
    throw new Error(`Timed out: ${label}`);
  }
  const debugText = () => readFile(debug, "utf8").catch(() => "");
  const xdotool = path.join(prefix, "usr/bin/xdotool");
  const key = (...keys) => {
    for (const name of keys) {
      const chord = { "shift+h": ["Shift_L", "h"], "Insert+a": ["Insert", "a"] }[name];
      if (!chord) {
        execFileSync(xdotool, ["key", "--clearmodifiers", "--delay", "150", name], { timeout: 5000 });
        continue;
      }
      // Keep the modifier held through the letter's release. Otherwise Orca can treat
      // Shift+H's unshifted key-up as a second, forward-heading command.
      execFileSync(xdotool, ["keydown", chord[0]], { timeout: 5000 });
      try {
        execFileSync(xdotool, ["key", "--delay", "150", chord[1]], { timeout: 5000 });
      } finally {
        execFileSync(xdotool, ["keyup", chord[0]], { timeout: 5000 });
      }
    }
  };
  async function step(name, action, speechPattern, target) {
    const before = await debugText();
    await action();
    await until(async () => speechPattern.test((await debugText()).slice(before.length)), name, 6000);
    await delay(650);
    const delta = (await debugText()).slice(before.length);
    const utterances = delta.split("\n").filter((line) => line.includes("SPEECH OUTPUT:"));
    const navigation = delta
      .split("\n")
      .filter((line) =>
        /COMMAND:|FOCUS MANAGER: (?:Changing locus|Request to set locus|Region of interest|Switching object)|WEB: Presenting object/.test(
          line,
        ),
      );
    steps.push({ name, utterances, navigation });
    await writeFile(path.join(directory, "utterances.json"), JSON.stringify(steps, null, 2));
    assert.ok(
      utterances.some((line) => speechPattern.test(line)),
      `${name}: actual Orca speech required`,
    );
    if (target) {
      assert.ok(
        navigation.some((line) => line.includes(`Request to set locus of focus to [heading: '${target}'`)),
        `${name}: Orca must place its locus of focus on ${target}, not a decorative child`,
      );
    }
    console.log(`${name}: ${utterances.map((line) => line.split(" - ")[1]).join(" | ")}`);
  }
  try {
    const workspace = path.join(directory, "workspace");
    const userData = path.join(directory, "user");
    const helper = path.join(directory, "coordinator");
    await mkdir(workspace);
    await mkdir(path.join(userData, "User"), { recursive: true });
    await mkdir(helper);
    await writeFile(path.join(workspace, "source.ts"), "export const source = 1;\n");
    const fixture = path.join(directory, "pi-fixture");
    await writeFile(fixture, await readFile(path.join(repository, "scripts/fixtures/native-pi.cjs")), { mode: 0o700 });
    await writeFile(path.join(directory, "response.txt"), "Screen-reader fixture response.");
    const now = new Date().toISOString();
    const messages = [
      { role: "user", content: "First fixture request." },
      { role: "assistant", content: [{ type: "text", text: "First fixture answer." }] },
      { role: "user", content: "Second fixture request." },
      { role: "assistant", content: [{ type: "text", text: "Second fixture answer." }] },
    ];
    const entries = messages.map((message, index) => ({
      type: "message",
      id: `entry-${index}`,
      parentId: index ? `entry-${index - 1}` : null,
      timestamp: now,
      message,
    }));
    await writeFile(
      path.join(directory, "session.jsonl"),
      [{ type: "session", version: 3, id: "screen-reader-fixture", cwd: workspace, timestamp: now }, ...entries]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    await writeFile(
      path.join(userData, "User/settings.json"),
      JSON.stringify({
        "security.workspace.trust.startupPrompt": "never",
        "telemetry.telemetryLevel": "off",
        "pi.executablePath": fixture,
        "workbench.startupEditor": "none",
        "extensions.ignoreRecommendations": true,
        "accessibility.support": "on",
        "update.mode": "none",
        "git.enabled": false,
      }),
    );
    await writeFile(
      path.join(helper, "package.json"),
      JSON.stringify({
        name: "screen-reader-coordinator",
        publisher: "fixture",
        version: "0.0.1",
        engines: { vscode: "^1.106.0" },
        activationEvents: ["onStartupFinished"],
        main: "./main.cjs",
      }),
    );
    await writeFile(
      path.join(helper, "main.cjs"),
      `exports.activate = async () => {
      const vscode = require("vscode");
      await vscode.extensions.getExtension("narumi.narumi-pi").activate();
      await vscode.commands.executeCommand("pi.openChat");
      require("node:fs").writeFileSync(${JSON.stringify(path.join(directory, "ready.json"))}, JSON.stringify({ version: vscode.version }));
    };`,
    );
    const pythonArgs = [
      "run",
      "--no-project",
      "--python",
      "/usr/bin/python3",
      "python",
      path.join(repository, "scripts/fixtures/orca-entry.py"),
      path.join(prefix, "usr/bin/orca"),
    ];
    const orcaVersion = execFileSync("uv", [...pythonArgs, "--version"], { encoding: "utf8", timeout: 10_000 }).trim();
    orca = spawn("uv", [...pythonArgs, `--debug-file=${debug}`], { stdio: ["ignore", "pipe", "pipe"], detached: true });
    orca.once("error", (error) => {
      orcaLog += String(error);
    });
    recordChild(orca);
    for (const stream of [orca.stdout, orca.stderr])
      stream.on("data", (chunk) => {
        orcaLog = (orcaLog + chunk).slice(-100_000);
      });
    await until(async () => (await debugText()).includes("Starting Atspi main event loop"), "real Orca startup");
    const executable = await downloadAndUnzipVSCode({
      version,
      cachePath: path.join(tmpdir(), "pi-vscode-native-cache"),
    });
    code = spawn(
      executable,
      [
        workspace,
        "--no-sandbox",
        "--disable-gpu",
        "--disable-updates",
        "--disable-workspace-trust",
        "--skip-welcome",
        "--skip-release-notes",
        "--user-data-dir",
        userData,
        "--extensions-dir",
        path.join(directory, "extensions"),
        `--extensionDevelopmentPath=${repository}`,
        `--extensionDevelopmentPath=${helper}`,
        "--remote-debugging-port=0",
        "--remote-debugging-address=127.0.0.1",
        "--force-renderer-accessibility",
      ],
      {
        env: { ...process.env, PI_VSCODE_UI_FIXTURE: directory, PI_CODING_AGENT_DIR: path.join(directory, "pi") },
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
      },
    );
    code.once("error", (error) => {
      codeLog += String(error);
    });
    recordChild(code);
    for (const stream of [code.stdout, code.stderr])
      stream.on("data", (chunk) => {
        codeLog = (codeLog + chunk).slice(-200_000);
      });
    const endpoint = await until(() => /DevTools listening on (ws:\/\/[^\s]+)/.exec(codeLog)?.[1], "loopback CDP");
    browser = await chromium.connectOverCDP(endpoint);
    const page = await until(
      () =>
        browser
          .contexts()[0]
          .pages()
          .find((item) => item.url().includes("workbench")),
      "workbench",
    );
    const ready = await until(
      () =>
        readFile(path.join(directory, "ready.json"), "utf8")
          .then(JSON.parse)
          .catch(() => null),
      "extension",
    );
    const frame = await until(async () => {
      for (const candidate of page.frames())
        if (
          await candidate
            .locator("#input")
            .count()
            .catch(() => 0)
        )
          return candidate;
    }, "Pi webview");
    await until(
      async () =>
        (await frame.locator("#runtime").getAttribute("data-connection")) === "connected" &&
        (await frame.locator("#status").textContent()) === "",
      "fixture runtime idle",
    );
    await frame.locator("#recent-session-list .current").click();
    await frame.locator("h2.role").first().waitFor({ state: "visible" });
    const window = execFileSync(xdotool, ["search", "--onlyvisible", "--class", "Code"], { encoding: "utf8" })
      .trim()
      .split("\n")
      .at(-1);
    execFileSync(xdotool, ["windowfocus", "--sync", window]);
    // CDP enters the composer only. Every structural-navigation action uses real X11 keys.
    await step(
      "initial file hint",
      () => frame.locator("#input").click(),
      /SPEECH OUTPUT:.*@ selects a file snapshot.*Tab on a visible path suggestion inserts only its path/,
    );
    await step(
      "Orca sticky browse mode",
      async () => {
        execFileSync(xdotool, ["keydown", "Insert"]);
        try {
          execFileSync(xdotool, ["key", "--delay", "80", "a", "a", "a"]);
        } finally {
          execFileSync(xdotool, ["keyup", "Insert"]);
        }
      },
      /SPEECH OUTPUT: 'Browse mode is sticky\.'/,
    );
    await step("previous Pi heading", async () => key("shift+h"), /SPEECH OUTPUT: 'heading 2/, "Pi message 4");
    await step("previous You heading", async () => key("shift+h"), /SPEECH OUTPUT: 'heading 2/, "You message 3");
    await step("previous earlier Pi heading", async () => key("shift+h"), /SPEECH OUTPUT: 'heading 2/, "Pi message 2");
    await step("next You heading", async () => key("h"), /SPEECH OUTPUT: 'heading 2/, "You message 3");
    const refocusComposer = async () => {
      for (let attempt = 0; attempt < 20; attempt++) {
        key("Tab");
        await delay(400);
        if (await frame.locator("#input").evaluate((node) => document.activeElement === node)) return;
      }
      throw new Error("Keyboard navigation did not return to the composer.");
    };
    await step(
      "return to composer",
      async () => {
        key("Insert+a");
        await refocusComposer();
      },
      /SPEECH OUTPUT: 'entry'/,
    );
    const refocusHint = async () => {
      await delay(800);
      await frame.locator("#add-context").focus();
      await delay(800);
      await frame.locator("#input").focus();
    };
    await frame.locator("#input").fill("");
    await step(
      "shell unavailable hint",
      async () => {
        key("exclam");
        await delay(350);
        await refocusHint();
      },
      /SPEECH OUTPUT:.*File completion is unavailable for shell input and slash commands/,
    );
    await frame.locator("#input").fill("/");
    key("Escape");
    await step(
      "slash unavailable hint",
      refocusHint,
      /SPEECH OUTPUT:.*File completion is unavailable for shell input and slash commands/,
    );
    await frame.locator("#input").fill("");
    await step(
      "restored file hint",
      refocusHint,
      /SPEECH OUTPUT:.*@ selects a file snapshot.*Tab on a visible path suggestion inserts only its path/,
    );
    assert.equal(await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => ""), "", "No model prompt");
    assert.equal(await frame.locator("#attachments > *").count(), 0, "No file capture");
    assert.ok(!(await debugText()).includes("VALIDATION LOG LIMIT EXCEEDED"), "Debug log must remain bounded");
    const metadata = {
      result: "passed",
      vscode: ready.version,
      orca: orcaVersion,
      platform: execFileSync("uname", ["-srm"], { encoding: "utf8" }).trim(),
      display: process.env.DISPLAY,
      speech: "Actual Orca-generated text; Speech Dispatcher unavailable. Audio and human usability not tested.",
      steps: steps.length,
    };
    await writeFile(path.join(directory, "result.json"), JSON.stringify(metadata, null, 2));
    console.log(JSON.stringify(metadata));
  } catch (error) {
    await writeFile(path.join(directory, "failure.txt"), String(error.stack));
    throw error;
  } finally {
    await browser?.close().catch(() => {});
    await cleanupOwnedGroups();
    await writeFile(path.join(directory, "vscode.log"), codeLog);
    await writeFile(path.join(directory, "orca-console.log"), orcaLog);
  }
}
