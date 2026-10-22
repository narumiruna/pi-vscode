import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { chromium } from "playwright-core";
import extensionUiFixture from "./fixtures/extension-ui.cjs";
import { assertExtensionEditorDialogs } from "./editor-dialog-fixture.mjs";
import toolFixture from "./fixtures/tool-activity.cjs";
import { assertRichContent, richFixture } from "./rich-content-fixture.mjs";
import {
  assertComposerNavigation,
  assertComposerStatusContract,
  openConversationDetails,
} from "./composer-navigation-fixture.mjs";
import { assertDiscoveryWrap } from "./discovery-wrap-fixture.mjs";
import { assertNativeConversationHistory, historyFixtureMessages } from "./history-fixture.mjs";
import { assertSessionActions } from "./session-actions-fixture.mjs";
import { assertNativeSessionSwitch, seedSessionSwitch } from "./session-switch-fixture.mjs";
import { assertNativeDraftLocalCommands, assertNativeDraftRecovery } from "./draft-native-fixture.mjs";
import { assertToolActivity } from "./tool-activity-fixture.mjs";
import { assertNativeFileCompletion } from "./completion-native-fixture.mjs";
import thinkingFixture from "./fixtures/thinking.cjs";
import { assertThinkingDisclosure } from "./thinking-fixture.mjs";
import { assertNativeDirectShell } from "./direct-shell-fixture.mjs";
import { assertAuthTransferDialogs, seedTransferSession } from "./auth-transfer-native-fixture.mjs";
import { assertNativeAnnotationPrototype, assertNativeAnnotations } from "./annotation-native-fixture.mjs";
import { assertNativeOutputDiagnostics } from "./output-diagnostics-native-fixture.mjs";
import { assertNativeSettings, openSettingsOverflow, settingsCoordinatorSource } from "./settings-native-fixture.mjs";

// Actual Quick Picks, modals, Problems, code actions and webview clicks; only Pi is simulated.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.140.0";
const workspaceAlias = process.argv[3] === "alias";
const packaged = process.argv.includes("packaged");
const selectionOnly = process.argv.includes("selection");
const sessionSwitchOnly = process.argv.includes("session-switch");
const settingsBaseline = process.argv.includes("settings-baseline");
const settingsOnly = settingsBaseline || process.argv.includes("settings");
const outputDiagnosticsOnly = process.argv.includes("output-diagnostics");
if (outputDiagnosticsOnly && packaged) throw new Error("Output diagnostics uses a source development profile only.");
const annotationPrototypeOnly = process.argv.includes("annotation-prototype");
const annotationsOnly = process.argv.includes("annotations") || annotationPrototypeOnly;
const evidenceLabel = `${version}${workspaceAlias ? "-alias" : ""}${packaged ? "-packaged" : ""}${selectionOnly ? "-selection" : ""}${sessionSwitchOnly ? "-session-switch" : ""}${annotationsOnly ? "-annotations" : ""}${annotationPrototypeOnly ? "-prototype" : ""}${outputDiagnosticsOnly ? "-output-diagnostics" : ""}${settingsOnly ? settingsBaseline ? "-settings-baseline" : "-settings" : ""}`;
if (process.platform !== "linux" && !(process.platform === "darwin" && settingsOnly)) {
  throw new Error("The native UI runner supports Linux; focused Settings checks also support macOS.");
}
const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-native-ui-")));
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, description, timeout = 20_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}
const json = (name) =>
  readFile(path.join(directory, name), "utf8")
    .then(JSON.parse)
    .catch(() => undefined);
let sequence = 0;
async function invoke(action, extra = {}, wait = true) {
  const id = ++sequence;
  await writeFile(path.join(directory, "request.tmp"), JSON.stringify({ id, action, ...extra }));
  await rename(path.join(directory, "request.tmp"), path.join(directory, "request.json"));
  const complete = async () => {
    const value = await until(
      async () => {
        const value = await json("result.json");
        return value?.id === id && value;
      },
      `${action} ${extra.command ?? ""}`,
    );
    assert.equal(value.error, undefined);
    return value.result;
  };
  return wait ? complete() : complete;
}
const respond = (text) => writeFile(path.join(directory, "response.txt"), text);
let child;
let browser;
let page;
let exited;
let log = "";
try {
  const workspace = path.join(directory, "workspace");
  const openedWorkspace = workspaceAlias ? path.join(directory, "workspace-alias") : workspace;
  const userData = path.join(directory, "user");
  await mkdir(workspace);
  if (selectionOnly) await writeFile(path.join(directory, "selection-first-open"), "selection");
  if (annotationsOnly) await writeFile(path.join(directory, "annotations-only"), "annotations");
  if (outputDiagnosticsOnly) await writeFile(path.join(directory, "output-diagnostics-only"), "output-diagnostics");
  if (workspaceAlias) await symlink(workspace, openedWorkspace, "junction");
  await mkdir(path.join(userData, "User"), { recursive: true });
  const executableFixture = path.join(directory, "pi-fixture");
  const fixtureModule = pathToFileURL(path.join(repository, "src/test/fixtures/isolated-pi-fixture.mjs")).href;
  const fixtureSource = await readFile(path.join(repository, "scripts/fixtures/native-pi.cjs"), "utf8");
  await writeFile(executableFixture, fixtureSource.replace('import("../../src/test/fixtures/isolated-pi-fixture.mjs")', `import(${JSON.stringify(fixtureModule)})`));
  await chmod(executableFixture, 0o700);
  await seedTransferSession(directory, workspace);
  if (!selectionOnly && !annotationsOnly && !outputDiagnosticsOnly && !settingsOnly) {
    await seedSessionSwitch(directory, workspace);
  }
  const fixtureBin = path.join(directory, "bin");
  await mkdir(fixtureBin);
  // Fail closed even if an upload approval regression invokes gh. Never delegates to real gh.
  await writeFile(path.join(fixtureBin, "gh"), `#!/bin/sh\nprintf invoked >> '${path.join(directory, "gh-invoked")}'\nexit 91\n`, { mode: 0o700 });
  await respond("Native fixture explanation.");
  if (!selectionOnly && !annotationsOnly && !outputDiagnosticsOnly) await writeFile(path.join(directory, "extension-ui.json"), JSON.stringify(extensionUiFixture));
  await writeFile(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "files.autoSave": "off",
      "telemetry.telemetryLevel": "off",
      "pi.executablePath": executableFixture,
      "workbench.startupEditor": "none",
      "window.dialogStyle": "custom",
      ...(settingsOnly ? { "window.menuStyle": "custom" } : {}),
      "files.simpleDialog.enable": true,
      "window.zoomLevel": 0,
      "git.openRepositoryInParentFolders": "never",
      "extensions.ignoreRecommendations": true,
    }),
  );
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(gitEnv, {
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(directory, "empty-gitconfig"),
  });
  await writeFile(gitEnv.GIT_CONFIG_GLOBAL, "");
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: workspace, env: gitEnv, stdio: "pipe" });
  const source = `export function greet() { return 1; }\ngreet();\n${Array.from({ length: 12 }, (_, i) => `// unchanged ${i}`).join("\n")}\nexport const tail = 1;\n`;
  git("init", "-q");
  await writeFile(path.join(workspace, "source.ts"), source);
  await writeFile(path.join(workspace, "other.ts"), "export const other = 1;\n");
  await writeFile(path.join(workspace, "tsconfig.json"), "{}");
  git("add", "source.ts", "other.ts", "tsconfig.json");
  git("commit", "-qm", "test: base");
  git("branch", "base");
  await writeFile(path.join(workspace, "other.ts"), "export const other = 2;\n");
  git("add", "other.ts");
  git("commit", "-qm", "test: branch change");
  await writeFile(path.join(workspace, "other.ts"), "export const other = 3;\n");
  git("add", "other.ts");
  await writeFile(path.join(workspace, "other.ts"), "export const other = 4;\n");
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  // --extensionTestsPath suppresses modal dialogs. Use a disposable development-only
  // coordinator extension so this launch exercises the real confirmation UI.
  const helper = path.join(directory, "coordinator");
  await mkdir(helper);
  await copyFile(path.join(repository, "out", "test", "nativeUiWorkflow.js"), path.join(helper, "workflow.js"));
  await copyFile(path.join(repository, "out", "test", "annotationThreadPrototype.js"), path.join(helper, "annotationThreadPrototype.js"));
  await writeFile(
    path.join(helper, "package.json"),
    JSON.stringify({
      name: "native-ui-coordinator",
      publisher: "fixture",
      version: "0.0.1",
      engines: { vscode: "^1.140.0" },
      activationEvents: ["onStartupFinished"],
      main: "./main.cjs",
    }),
  );
  await writeFile(
    path.join(helper, "main.cjs"),
    settingsOnly ? settingsCoordinatorSource :
      `exports.activate = () => { require('./workflow.js').run().catch(error => { require('node:fs').writeFileSync(require('node:path').join(process.env.PI_VSCODE_UI_FIXTURE, 'coordinator-error.txt'), String(error.stack)); }); };`,
  );
  const executable = await downloadAndUnzipVSCode({
    version,
    cachePath: path.join(tmpdir(), "pi-vscode-native-cache"),
  });
  if (packaged) {
    execFileSync(
      path.join(path.dirname(executable), "bin", "code"),
      [
        "--no-sandbox",
        "--user-data-dir",
        userData,
        "--extensions-dir",
        path.join(directory, "extensions"),
        "--install-extension",
        path.join(repository, "pi.vsix"),
        "--force",
      ],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, DONT_PROMPT_WSL_INSTALL: "1" },
        stdio: "pipe",
        timeout: 60_000,
      },
    );
  }
  child = spawn(
    executable,
    [
      openedWorkspace,
      "--no-sandbox",
      "--disable-gpu",
      "--disable-updates",
      "--disable-workspace-trust",
      "--skip-welcome",
      "--skip-release-notes",
      "--user-data-dir",
      userData,
      "--shared-data-dir",
      path.join(directory, "shared"),
      "--extensions-dir",
      path.join(directory, "extensions"),
      ...(packaged ? [] : [`--extensionDevelopmentPath=${repository}`]),
      `--extensionDevelopmentPath=${helper}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PATH: `${fixtureBin}:${process.env.PATH}`, PI_VSCODE_UI_FIXTURE: directory, PI_CODING_AGENT_DIR: path.join(directory, "pi") },
    },
  );
  child.stdout.on("data", (chunk) => {
    log = (log + chunk).slice(-2_000_000);
  });
  child.stderr.on("data", (chunk) => {
    log = (log + chunk).slice(-2_000_000);
  });
  exited = new Promise((resolve) => {
    child.once("exit", resolve);
    child.once("error", (error) => {
      log += String(error);
      resolve();
    });
  });
  const endpoint = await until(
    async () =>
      fetch(`http://127.0.0.1:${port}/json/version`)
        .then((r) => r.json())
        .catch(() => undefined),
    "CDP endpoint",
  );
  browser = await chromium.connectOverCDP(endpoint.webSocketDebuggerUrl);
  page = await until(
    () =>
      browser
        .contexts()[0]
        .pages()
        .find((p) => p.url().includes("workbench")),
    "workbench page",
  );
  page.setDefaultTimeout(15_000);
  const ready = await until(() => json("ready.json"), "native coordinator ready", 40_000);
  assert.equal(ready.trusted, true);
  assert.equal(ready.workspace, openedWorkspace, "VS Code must retain the requested editor URI spelling");
  const frame = () =>
    until(async () => {
      for (const candidate of page.frames()) {
        try {
          if (await candidate.locator("#add-context").count()) return candidate;
        } catch (error) {
          if (!candidate.isDetached()) throw error;
        }
      }
    }, "Pi webview");
  const pick = async (text) => {
    const input = page.locator(".quick-input-widget input[type=text]");
    await input.waitFor({ state: "visible" });
    const label = await input.getAttribute("aria-label");
    // A chained Quick Pick can transfer native focus while Playwright inserts text.
    // Set only this input and dispatch its normal input event; never type into the editor.
    await input.evaluate((element, value) => {
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, text);
    await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: text }).first().click();
    // Current VS Code can reuse the input without a hidden frame between chained Quick Picks.
    await until(
      () => page.evaluate(({ label, text }) => {
        const element = document.querySelector('.quick-input-widget input[type=text]');
        return !element || !element.checkVisibility() || element.getAttribute("aria-label") !== label || element.value !== text;
      }, { label, text }),
      "Quick Pick accepted or advanced",
    );
  };
  if (settingsOnly) {
    await assertNativeSettings({ page, directory, workspace, invoke, until, baseline: settingsBaseline, version: ready.version });
  } else if (outputDiagnosticsOnly) {
    await assertNativeOutputDiagnostics({ page, directory, userData, invoke, until, frame, version: ready.version });
  } else if (annotationPrototypeOnly) {
    await assertNativeAnnotationPrototype({ page, workspace, invoke, until, version: ready.version, evidenceLabel });
  } else if (annotationsOnly) {
    await assertNativeAnnotations({ page, directory, workspace, invoke, until, frame, pick });
  } else if (sessionSwitchOnly) {
    const pi = await frame();
    await until(async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected",
      "session switch fixture runtime connected");
    await assertNativeSessionSwitch({ page, directory, workspace, invoke, until, frame });
  } else if (selectionOnly) {
    // No pi.openChat, view focus, or webview message may prepare this first-open command.
    for (const candidate of page.frames()) assert.equal(await candidate.locator("#add-context").count(), 0);
    await assert.rejects(readFile(path.join(directory, "pids.jsonl")), { code: "ENOENT" });
    const selected = await invoke("selection");
    const question = "Why does the selected greet function return 1?";
    const complete = await invoke("command", { command: "pi.askSelection" }, false);
    const input = page.locator(".quick-input-widget input[type=text]");
    await input.waitFor({ state: "visible" });
    assert.match(await page.locator(".quick-input-widget").innerText(), /Ask Pi About Selection/);
    await input.fill(question);
    await input.press("Enter");
    await complete();
    const pi = await frame();
    await until(
      async () => (await pi.locator("#messages .assistant").innerText()).includes("Native fixture explanation."),
      "selection fixture answer",
    );
    assert.equal(
      await pi.locator("#app").evaluate((element) => element.classList.contains("sessions-layer")),
      false,
      "First-open Ask must show the session detail, not Sessions",
    );
    assert.equal(await pi.locator("#messages").isVisible(), true);
    const turn = pi.locator("#messages .user").filter({ hasText: question });
    assert.equal(await turn.count(), 1);
    assert.equal(
      await turn.isVisible(),
      true,
      "The submitted selection question must be visible without opening a session",
    );
    assert.equal(await pi.locator("#messages .assistant").isVisible(), true);
    const prompts = (await readFile(path.join(directory, "prompts.jsonl"), "utf8"))
      .trim().split("\n").map(JSON.parse);
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].message.includes(question));
    assert.ok(prompts[0].message.includes(selected), "The actual editor selection must reach fixture Pi");
    assert.match(prompts[0].message, /read.only/i);
    assert.deepEqual((await invoke("state")).texts, [source, "export const other = 4;\n"]);
    console.log(
      "PI_NATIVE_SELECTION first-open pi.askSelection, native question input, visible session detail/question/answer " +
      "and unchanged source passed; fixture Pi only",
    );
  } else {
  // Start a session detail pane, then capture all five provider-backed attachment types.
  let pi = await frame();
  await until(async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected" &&
    (await pi.locator("#status").textContent()) === "", "Pi runtime idle with reserved empty status");
  await assertComposerStatusContract(pi);
  await assertNativeSessionSwitch({ page, directory, workspace, invoke, until, frame });
  // Inspect the VS Code-owned tab without changing shared bar presentation settings.
  const nativeTab = page.locator(".part.auxiliarybar .composite-bar").getByRole("tab", { name: "Pi", exact: true });
  await nativeTab.waitFor({ state: "visible" });
  assert.equal(await nativeTab.count(), 1);
  assert.equal(await nativeTab.getAttribute("aria-selected"), "true");
  const accessibleTab = await nativeTab.ariaSnapshot();
  assert.match(accessibleTab, /^- tab "Pi"/);
  const nativeLabel = nativeTab.locator(".action-label");
  assert.equal(await nativeLabel.getAttribute("aria-label"), "Pi");
  const brand = await nativeLabel.evaluate((element) => {
    const style = getComputedStyle(element);
    const range = document.createRange();
    range.selectNodeContents(element);
    return {
      text: element.textContent.trim(),
      textWidth: range.getBoundingClientRect().width,
      visible: element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }),
      fontSize: style.fontSize,
      backgroundImage: style.backgroundImage,
      maskImage: style.maskImage,
      before: getComputedStyle(element, "::before").content,
      after: getComputedStyle(element, "::after").content,
    };
  });
  assert.equal(brand.text, "Pi");
  assert.equal(brand.visible, true);
  assert.ok(brand.textWidth > 0 && Number.parseFloat(brand.fontSize) > 0, "Pi text must have visible geometry");
  assert.equal(await nativeTab.locator("img:visible, svg:visible, .codicon:visible").count(), 0);
  assert.equal(brand.backgroundImage, "none");
  assert.equal(brand.maskImage, "none");
  for (const content of [brand.before, brand.after]) assert.ok(["none", "normal", '""'].includes(content));
  await nativeTab.hover();
  const nativeTooltip = page.locator(".monaco-hover").filter({ hasText: /^Pi$/ }).last();
  await nativeTooltip.waitFor({ state: "visible" });
  const tooltip = (await nativeTooltip.innerText()).trim();
  assert.equal(tooltip, "Pi");
  const tabScreenshot = path.join(tmpdir(), `pi-native-tab-${evidenceLabel}.png`);
  await page.screenshot({ path: tabScreenshot });
  await page.mouse.move(0, 0);
  const wasSessions = await pi.locator("#app").evaluate((element) => element.classList.contains("sessions-layer"));
  const promptsBeforeSessions = await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  await invoke("command", { command: "pi.openChat" });
  pi = await frame();
  await until(() => pi.locator("#sessions").isVisible(), "Open Sessions from native Pi");
  assert.equal(await pi.locator("#app").evaluate((element) => element.classList.contains("sessions-layer")), true);
  assert.equal(await nativeTab.getAttribute("aria-selected"), "true");
  assert.equal(await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => ""), promptsBeforeSessions);
  if (!wasSessions) await pi.locator("#recent-session-list .current").click();
  console.log("PI_NATIVE_TAB", JSON.stringify({
    version: ready.version, platform: process.platform, accessibleTab, tooltip, brand,
    visibleBrandElements: "text Pi only; no rendered icon", openSessions: "pi.openChat passed; no prompt",
    presentation: "unchanged manifest and shared display settings; user acceptance pending",
    provider: "deterministic fixture; no live model", screenshot: tabScreenshot,
  }));
  if (!process.argv.includes("editor")) {
    await assertAuthTransferDialogs({ page, directory, workspace, invoke, pick, until, frame });
  }
  if (!process.argv.includes("editor") && !process.argv.includes("transfer")) {
  const initial = await invoke("state");
  // VS Code settings use the real native editor; Pi file drafts use their own panel.
  const pidsBeforeSettings = await readFile(path.join(directory, "pids.jsonl"), "utf8");
  const promptsBeforeSettings = await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const settingsMenu = await openSettingsOverflow(page);
  await settingsMenu.extension.click();
  await page.locator(".settings-editor").waitFor({ state: "visible" });
  await assertNativeSettings({ page, directory, workspace, invoke, until, version: ready.version });
  await page.screenshot({ path: path.join(tmpdir(), `pi-settings-native-${evidenceLabel}.png`) });
  assert.equal(
    await readFile(path.join(directory, "pids.jsonl"), "utf8"),
    pidsBeforeSettings,
    "Settings must not start or restart Pi",
  );
  assert.equal(
    await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => ""),
    promptsBeforeSettings,
    "Settings must not send prompts",
  );
  await invoke("command", { command: "workbench.action.closeActiveEditor" });
  await invoke("source");
  console.log("PI_NATIVE_UI settings overflow, native controls, scopes, reset and no Pi side effects passed");
  // Native file controls are separate host dialogs. Passive opens and saves must not launch Pi.
  const nativeSettingsDone = await invoke("command", { command: "pi.openNativeSettings" }, false);
  await pick("Project Pi");
  for (const label of ["Steering mode", "Follow-up mode", "Startup thinking level", "Scoped model patterns"]) {
    const filter = page.locator(".quick-input-widget input[type=text]");
    await filter.evaluate((element, value) => {
      element.focus();
      element.value = value;
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }, label);
    await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: label }).first().waitFor();
  }
  await pick("Startup model");
  await pick("Edit selected override");
  const nativeInput = page.locator(".quick-input-widget input[type=text]");
  await nativeInput.waitFor({ state: "visible" });
  await nativeInput.fill("native-file-fixture");
  await nativeInput.press("Enter");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  await nativeSettingsDone();
  assert.equal(JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8")).defaultModel, "native-file-fixture");
  const nativeResetDone = await invoke("command", { command: "pi.openNativeSettings" }, false);
  await pick("Project Pi");
  await pick("Startup model");
  await pick("Reset selected override only");
  await page.getByRole("button", { name: "Save only", exact: true }).click();
  await nativeResetDone();
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8")), {});
  assert.equal((await invoke("nativeSettingsDirty")).dirty, true);
  const nativeBlockedDone = await invoke("command", { command: "pi.openNativeSettings" }, false);
  // Dirty native targets now fail during loading, before a scope picker, editable row, or Save approval exists.
  await nativeBlockedDone();
  await page.getByText("Native Pi operation did not complete.", { exact: false }).first().waitFor();
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8")), {}, "Dirty native editor, including workspace aliases, blocks disk writes");
  const ordinarySave = await invoke("nativeSettingsSave");
  assert.equal(ordinarySave.saved, true);
  assert.deepEqual(JSON.parse(ordinarySave.text), { userDraft: "retained" });
  assert.deepEqual(JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8")), { userDraft: "retained" });
  await invoke("command", { command: "workbench.action.closeActiveEditor" });
  await mkdir(path.join(directory, "pi"), { recursive: true });
  await writeFile(path.join(directory, "pi/mcp.json"), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, enabled: false, env: { KEY: "native-fixture-secret" }, exposure: "hidden" } } }));
  const nativeMcpDone = await invoke("command", { command: "pi.openNativeMcp" }, false);
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "fixture" }).first().waitFor();
  assert.ok(!(await page.locator(".quick-input-widget").innerText()).includes("native-fixture-secret"));
  await page.keyboard.press("Escape");
  await nativeMcpDone();
  assert.equal(await readFile(path.join(directory, "pids.jsonl"), "utf8"), pidsBeforeSettings, "Native file surfaces and saves must not start Pi");
  assert.equal(await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => ""), promptsBeforeSettings, "Native management must not send model prompts");
  await rm(path.join(workspace, ".pi/settings.json"));
  await rm(path.join(directory, "pi/mcp.json"));
  console.log("PI_NATIVE_UI native settings targets, save/reset and passive secret-free MCP overview passed");
  for (const label of ["Definition", "References", "Callers", "Callees", "Document Symbols"]) {
    await invoke("source");
    pi = await frame();
    await pi.locator("#add-context").click();
    await pick(label);
  }
  await until(
    async () => /symbols/i.test(await pi.locator("#attachments").innerText()),
    "semantic attachments rendered",
  );
  assert.match(await pi.locator("#attachments").innerText(), /definition/i);
  assert.match(await pi.locator("#attachments").innerText(), /references/i);
  assert.match(await pi.locator("#attachments").innerText(), /callers/i);
  assert.match(await pi.locator("body").innerText(), /No callees were returned/);
  assert.match(await pi.locator("#attachments").innerText(), /documentSymbols|symbols/i);
  console.log("PI_NATIVE_UI semantic attachment picker passed");
  // Cancellation must not dispatch an RPC prompt.
  const cancelled = await invoke("command", { command: "pi.reviewChanges" }, false);
  await page.locator(".quick-input-widget input").first().waitFor({ state: "visible" });
  await page.keyboard.press("Escape");
  await cancelled();
  await assert.rejects(readFile(path.join(directory, "prompts.jsonl")), { code: "ENOENT" });
  for (const [scope, label] of [
    ["staged", "Staged Changes"],
    ["unstaged", "Unstaged Changes"],
    ["branch", "Current Branch vs Base"],
    ["workingTree", "All Working Tree Changes"],
  ]) {
    await invoke("command", { command: "notifications.clearAll" });
    await respond(
      JSON.stringify({
        incomplete: false,
        findings: [
          {
            path: "other.ts",
            side: "after",
            startLine: 1,
            endLine: 1,
            severity: "warning",
            message: `Native ${scope} finding`,
          },
        ],
      }),
    );
    const complete = await invoke("command", { command: "pi.reviewChanges" }, false);
    await pick(label);
    if (scope === "branch") await pick("base");
    await page
      .getByRole("button", { name: scope === "staged" ? "Send Staged Review" : "Send Review", exact: true })
      .click();
    // Follow the native notification into findings, then cancel navigation.
    await until(
      async () =>
        (await page.locator(".notifications-toasts").innerText()).includes(
          `1 ${scope === "workingTree" ? "working tree" : scope} findings`,
        ),
      `${scope} result notification`,
    );
    await complete(); // Review completes even while the notification is open.
    await page.getByRole("button", { name: "Findings", exact: true }).click();
    await page.locator(".quick-input-widget input[type=text]").waitFor({ state: "visible" });
    await page.keyboard.press("Escape");
  }
  let state = await invoke("state");
  assert.equal(state.findings.length, 4);
  await invoke("dirtyReviewTarget");
  await invoke("undo");
  assert.deepEqual((await invoke("state")).texts, initial.texts);
  console.log("PI_NATIVE_UI dirty finding buffer blocks Fix and direct command");
  await invoke("command", { command: "workbench.actions.view.problems" });
  const problem = page.getByRole("treeitem", { name: /Warning: Native workingTree/ });
  await problem.dblclick();
  await until(
    async () => /^pi-review:/.test((await invoke("state")).active ?? ""),
    "Problems captured-document navigation",
  );
  await respond(richFixture);
  await writeFile(
    path.join(directory, "interface-images.json"),
    JSON.stringify([
      { type: "image", mimeType: "image/gif", data: "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" },
    ]),
  );
  await writeFile(path.join(directory, "tools.json"), JSON.stringify(toolFixture.calls));
  await problem.click();
  await invoke("command", { command: "problems.action.showQuickFixes" });
  await page.getByRole("menuitem", { name: "Ask Pi About Finding", exact: true }).waitFor();
  await delay(300); // Native context menu positioning/focus settles after the command returns.
  await page.getByRole("menuitem", { name: "Ask Pi About Finding", exact: true }).click();
  await until(
    async () => (await (await frame()).locator("body").innerText()).includes("Native fixture explanation."),
    "Ask response in Sidebar",
  );
  const toolEvidence = await assertToolActivity(
    await frame(),
    page,
    invoke,
    async () => {
      await writeFile(path.join(directory, "tools-release"), "settle");
    },
    evidenceLabel,
  );
  console.log("PI_NATIVE_TOOL_ACTIVITY", JSON.stringify(toolEvidence));
  const richEvidence = await assertRichContent(await frame());
  console.log("PI_NATIVE_RICH_CONTENT", JSON.stringify({ packaged, ...richEvidence }));
  console.log("PI_NATIVE_COMPOSER_NAVIGATION", JSON.stringify(await assertComposerNavigation(await frame(), page)));
  const wrapFrame = await frame();
  const promptsBeforeWrap = await readFile(path.join(directory, "prompts.jsonl"), "utf8");
  const draftBeforeWrap = await wrapFrame.locator("#input").inputValue();
  const wrapped = () => wrapFrame.locator("#messages").evaluate((node) => node.classList.contains("wrap-code"));
  const toggleWrapping = async ({ key = "Enter" } = {}) => {
    const before = await wrapped();
    const openWrapping = async () => {
      await wrapFrame.locator("#more").focus();
      await wrapFrame.locator("#more").press(key);
      const filter = page.locator(".quick-input-widget input[type=text]");
      await filter.waitFor({ state: "visible" });
      await filter.fill("Word wrap");
      const row = page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Word wrap" });
      await row.waitFor();
      assert.match(await row.innerText(), before ? /Word wrap\s*On\b/ : /Word wrap\s*Off\b/);
      assert.match(await row.innerText(), /display only|display-only/i);
      return filter;
    };
    // Cancel one real picker first; its state and the unsent composer must remain unchanged.
    await openWrapping();
    await page.keyboard.press("Escape");
    await until(async () => !(await page.locator(".quick-input-widget").isVisible()), "Word wrap cancellation");
    assert.equal(await wrapped(), before);
    const filter = await openWrapping();
    await filter.press("Enter");
    await until(async () => (await wrapped()) === !before, "real Word wrap menu selection");
    assert.equal(await wrapFrame.locator("#input").inputValue(), draftBeforeWrap);
  };
  console.log("PI_NATIVE_DISCOVERY_WRAP", JSON.stringify(await assertDiscoveryWrap(wrapFrame, toggleWrapping)));
  assert.equal(await readFile(path.join(directory, "prompts.jsonl"), "utf8"), promptsBeforeWrap, "Word wrap must not request a model");
  await assertSessionActions({ page, frame, until });
  console.log("PI_NATIVE_SESSION_ACTIONS grouped filtering and keyboard selection/cancellation passed");
  pi = await frame();
  try {
    const evidence = await assertNativeConversationHistory({ pi, invoke: async () => {
      await writeFile(path.join(directory, "history.json"), JSON.stringify(historyFixtureMessages()));
      // Fixture setup uses the existing guarded refresh action; Latest is disabled at the tail.
      await pi.locator("#refresh-history").evaluate((node) => node.click());
    } });
    console.log("PI_NATIVE_HISTORY", JSON.stringify(evidence));
  } finally {
    await rm(path.join(directory, "history.json"), { force: true });
    await pi.locator("#refresh-history").evaluate((node) => node.click());
    await until(async () => !(await pi.locator("#messages").innerText()).includes("History 204"), "original native history restored");
  }
  const shellEvidence = await assertNativeDirectShell(frame, page, async () =>
    readFile(path.join(directory, "shell.jsonl"), "utf8").then((text) => text.trim().split("\n").filter(Boolean).length).catch(() => 0),
  );
  console.log("PI_NATIVE_SHELL", JSON.stringify({ packaged, shellEvidence }));
  pi = await frame();
  const imagePreview = pi.locator(".transcript-image").first();
  await imagePreview.waitFor();
  await until(async () => imagePreview.isEnabled(), "native image payload");
  await imagePreview.focus();
  await page.keyboard.press("Enter");
  assert.equal(await pi.locator("#image-preview").evaluate((dialog) => dialog.open), true);
  await page.keyboard.press("Escape");
  assert.equal(await imagePreview.evaluate((element) => document.activeElement === element), true);
  await openConversationDetails(pi, page);
  await pi.locator("#session-details summary").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(await pi.locator("#session").inputValue(), "native-import-authoritative");
  assert.equal(await pi.locator("#session").evaluate((element) => document.activeElement === element), true);
  await pi.locator("#session").selectText();
  assert.equal(await pi.locator("#session").evaluate((input) => input.selectionEnd - input.selectionStart), "native-import-authoritative".length);
  await pi.locator("#session-details summary").click();
  await pi.locator("#conversation-details-close").click();
  console.log(
    "PI_NATIVE_INTERFACE image keyboard preview, Escape/focus restoration and copyable session details passed",
  );
  // Restore the captured document through the legacy-independent findings command.
  const navigation = await invoke("command", { command: "pi.showReviewFindings" }, false);
  await pick("Native workingTree finding");
  await navigation();
  await respond("<<<PI_VSCODE_REPLACEMENT_START>>>\nexport const other = 40;\n\n<<<PI_VSCODE_REPLACEMENT_END>>>");
  await problem.click();
  await invoke("command", { command: "problems.action.showQuickFixes" });
  await page.getByRole("menuitem", { name: "Fix Finding with Pi (Preview)", exact: true }).waitFor();
  await delay(300);
  await page.getByRole("menuitem", { name: "Fix Finding with Pi (Preview)", exact: true }).click();
  pi = await frame();
  const findingCard = pi.locator(".proposal").filter({ hasText: "Review fix: other.ts" });
  await findingCard.waitFor();
  assert.equal(await findingCard.getByRole("button", { name: "Apply", exact: true }).isEnabled(), false);
  await findingCard.getByRole("button", { name: "Preview", exact: true }).click();
  await until(
    async () => findingCard.getByRole("button", { name: "Apply", exact: true }).isEnabled(),
    "finding Preview enables Apply",
  );
  assert.ok((await invoke("state")).tabs.some((tab) => tab.diff && tab.label === "Pi Edit Preview: other.ts"));
  await findingCard.getByRole("button", { name: "Apply", exact: true }).click();
  await until(async () => (await findingCard.innerText()).includes("Applied"), "finding Apply");
  assert.deepEqual((await invoke("state")).texts, [source, "export const other = 40;\n"]);
  await invoke("undo");
  console.log("PI_NATIVE_UI four scopes, Problems navigation and Ask/Fix Preview/Apply/Undo passed");
  // Two-file repair with three proposed hunks; omit the unrelated tail hunk.
  await invoke("diagnostics");
  await respond(
    JSON.stringify({
      files: [
        { path: "source.ts", content: source.replace("return 1", "return 10").replace("tail = 1", "tail = 100") },
        { path: "other.ts", content: "export const other = 40;\n" },
      ],
    }),
  );
  const repair = await invoke("command", { command: "pi.fixWorkspaceDiagnostics" }, false);
  await page.locator(".quick-input-widget input[type=text]").waitFor({ state: "visible" });
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Fixture diagnostic 1" }).click();
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Fixture diagnostic 2" }).click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await page.getByRole("button", { name: "Send Diagnostic Repair", exact: true }).click();
  await repair();
  pi = await frame();
  const repairCard = pi.locator(".proposal").filter({ hasText: "Repair 2 diagnostics" });
  await repairCard.waitFor();
  await repairCard.getByRole("button", { name: "Choose Hunks", exact: true }).click();
  await page
    .locator(".quick-input-list .monaco-list-row")
    .filter({ hasText: /source.ts.*15/ })
    .click();
  await page.getByRole("button", { name: "OK", exact: true }).click();
  await until(async () => (await repairCard.innerText()).includes("2/3 selected"), "partial hunk selection");
  await repairCard.getByRole("button", { name: "Preview", exact: true }).click();
  await until(
    async () => repairCard.getByRole("button", { name: "Apply", exact: true }).isEnabled(),
    "preview enables Apply",
  );
  state = await invoke("state");
  for (const file of ["source.ts", "other.ts"])
    assert.ok(state.tabs.some((tab) => tab.diff && tab.label === `Pi Edit Preview: ${file}`));
  await repairCard.getByRole("button", { name: "Apply", exact: true }).click();
  await until(async () => (await repairCard.innerText()).includes("Applied"), "batch Apply");
  state = await invoke("state");
  assert.deepEqual(state.texts, [source.replace("return 1", "return 10"), "export const other = 40;\n"]);
  assert.match(
    await page.locator(".notifications-toasts").innerText(),
    /1 disappeared, 1 still present, 0 not revalidated. This is not test evidence/,
  );
  await invoke("undo");
  assert.deepEqual((await invoke("state")).texts, initial.texts);
  console.log("PI_NATIVE_UI selected-hunk multi-file Preview/Apply/Undo passed");
  const screenshot = path.join(tmpdir(), `pi-native-ui-${evidenceLabel}.png`);
  await page.screenshot({ path: screenshot });
  await invoke("command", { command: "workbench.action.reloadWindow" }, false);
  await until(
    async () => {
      const next = await json("ready.json");
      return next && next.boot !== ready.boot;
    },
    "window reload",
    40_000,
  );
  state = await invoke("state");
  assert.equal(state.findings.length, 0);
  pi = await frame();
  assert.equal(await pi.locator(".proposal").count(), 0);
  assert.equal(
    await pi.locator("#extension-ui-above").isVisible(),
    false,
    "reload must not restore stale extension UI",
  );
  assert.equal(await pi.locator("#extension-ui-below").isVisible(), false);
  const pids = (await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").map(Number);
  await until(() => {
    try {
      process.kill(pids[0], 0);
      return false;
    } catch (error) {
      return error.code === "ESRCH";
    }
  }, "old RPC child stopped on reload");
  const prompts = (await readFile(path.join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.equal(prompts.length, 7);
  assert.ok(prompts.every((prompt) => /read.only/i.test(prompt.message)));
  await assertNativeFileCompletion({ pi, page, invoke, pick, until, directory, workspace });
  // Ordinary composer requests, unlike callback-owned review requests, accept both queue actions.
  await writeFile(path.join(directory, "interface-hold"), "hold");
  pi = await frame();
  await pi.locator("#input").fill("Hold this deterministic response");
  await pi.locator("#input").press("Enter");
  await pi.locator("#after-this").waitFor();
  assert.equal(await pi.locator("#cancel").isVisible(), true);
  assert.match(await pi.locator("#status").innerText(), /working|Sending/i);
  await assertComposerStatusContract(pi);
  await pi.locator("#extension-ui-above").waitFor();
  await openConversationDetails(pi, page);
  assert.match(await pi.locator("#extension-status").innerText(), /second: Updated status/);
  assert.match(await pi.locator("#usage").innerText(), /Context 12%/);
  await pi.locator("#conversation-details-close").click();
  assert.equal(await pi.locator(".extension-ui-block script, .extension-ui-block a").count(), 0);
  assert.equal(await pi.evaluate(() => window.extensionInjected), undefined);
  assert.equal(await pi.locator("#extension-ui-below > p").textContent(), "below");
  for (const [selector, text] of [
    ["#send", "Next native instruction"],
    ["#after-this", "After this native instruction"],
  ]) {
    await pi.locator("#input").fill(text);
    await pi.locator(selector).click();
    await until(async () => (await pi.locator("#input").inputValue()) === "", "accepted native queue input");
  }
  const queued = (await readFile(path.join(directory, "queued.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(
    queued.map((request) => request.type),
    ["steer", "follow_up"],
  );
  await until(async () => (await pi.locator(".pending-queue-item").count()) === 2, "both pending native queue rows");
  await pi.locator("#input").fill("A visible draft");
  for (const [theme, cssClass] of [
    ["Default Dark Modern", "vscode-dark"],
    ["Default Light Modern", "vscode-light"],
    ["Default High Contrast", "vscode-high-contrast"],
  ]) {
    await invoke("theme", { theme });
    await pi.waitForFunction((name) => document.body.classList.contains(name), cssClass);
    await invoke("zoom", { level: Math.log(2) / Math.log(1.2) });
    await delay(500);
    assert.equal(await pi.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true,
      JSON.stringify(await pi.evaluate(() => ({
        viewport: [innerWidth, innerHeight], scrollWidth: document.documentElement.scrollWidth,
        overflow: Array.from(document.querySelectorAll("body *")).filter((node) => {
          const rect = node.getBoundingClientRect();
          return rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1);
        }).slice(0, 20).map((node) => ({
          tag: node.tagName, id: node.id, className: node.className,
          rect: node.getBoundingClientRect().toJSON(),
        })),
      }))));
    for (const id of [
      "input",
      "add-context",
      "cancel",
      "after-this",
      "send",
      "status",
      "runtime",
      "model-picker",
      "extension-ui-above",
      "extension-ui-below",
    ]) {
      const geometry = await pi.locator(`#${id}`).evaluate((element) => ({
        rect: element.getBoundingClientRect().toJSON(),
        viewport: [innerWidth, innerHeight],
      }));
      assert.equal(
        await pi.locator(`#${id}`).evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const composer = element.closest(".composer-box")?.getBoundingClientRect();
          return (
            rect.width > 0 &&
            rect.left >= 0 &&
            rect.right <= innerWidth &&
            rect.top >= 0 &&
            rect.bottom <= innerHeight &&
            (!composer ||
              (rect.left >= composer.left &&
                rect.right <= composer.right &&
                rect.top >= composer.top &&
                rect.bottom <= composer.bottom))
          );
        }),
        true,
        `${cssClass} 200% ${id} must remain inside the native webview: ${JSON.stringify(geometry)}`,
      );
    }
    await openConversationDetails(pi, page);
    assert.equal(await pi.locator("#conversation-details").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight;
    }), true, "details stay within the native 200% viewport");
    await pi.locator("#usage").scrollIntoViewIfNeeded();
    assert.match(await pi.locator("#usage").innerText(), /Context 12%/);
    await page.keyboard.press("Escape");
    await until(async () => !(await pi.locator("#conversation-details").evaluate((dialog) => dialog.open)), "details closed at native zoom");
    // Electron CDP clips iframe screenshots at incorrect coordinates under native zoom.
    // Review native DOM/styles in an isolated viewport; the geometry check above stays native.
    const snapshotBrowser = await chromium.launch({ headless: true });
    try {
      const snapshot = await snapshotBrowser.newPage({
        viewport: await pi.evaluate(() => ({ width: innerWidth, height: innerHeight })),
      });
      await snapshot.route("**/*", (route) => route.abort());
      await snapshot.setContent((await pi.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ""));
      await snapshot.waitForTimeout(200);
      await snapshot
        .locator("#composer")
        .screenshot({ path: path.join(tmpdir(), `pi-interface-native-${evidenceLabel}-${cssClass}-200.png`) });
    } finally {
      await snapshotBrowser.close();
    }
    await invoke("zoom", { level: 0 });
  }
  await invoke("theme", { theme: "Default Dark Modern" });
  await pi.locator("#cancel").click();
  await until(async () => !(await pi.locator("#cancel").isVisible()), "native Stop settlement");
  await assertComposerStatusContract(pi);
  assert.equal(await pi.locator("#recover-queue").isVisible(), true);
  await rm(path.join(directory, "interface-hold"));
  await until(async () => await pi.locator("#send").isEnabled(), "foreground request owner released after Stop");
  // Merely choosing Delete must still require the native modal; cancellation keeps the session file.
  await pi.locator("#delete-session").click();
  await page.getByRole("button", { name: "Delete Session", exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.ok((await readFile(path.join(directory, "session.jsonl"), "utf8")).includes("native-ui-session"));
  // Host control commands have native dialogs, preserve drafts, and never enter the model fixture.
  const retainedDraft = await pi.locator("#input").inputValue();
  for (let index = 0; index < 3; index++) {
    const complete = await invoke("command", { command: "pi.reloadResources" }, false);
    await page.getByRole("button", { name: "Reload Resources", exact: true }).click();
    await complete();
    assert.equal(await pi.locator("#input").inputValue(), retainedDraft);
  }
  let branchComplete = await invoke("command", { command: "pi.browseSessionTree" }, false);
  await pick("Clone active branch into a new session");
  await branchComplete();
  branchComplete = await invoke("command", { command: "pi.browseSessionTree" }, false);
  await pick("Hold this deterministic response");
  await pick("Navigate without summary");
  await branchComplete();
  assert.equal(await pi.locator("#input").inputValue(), retainedDraft, "A native branch selection must not overwrite a nonempty draft");
  branchComplete = await invoke("command", { command: "pi.browseSessionTree" }, false);
  await pick("Hold this deterministic response");
  await pick("Fork from user message");
  await branchComplete();
  const controlRecords = (await readFile(path.join(directory, "controls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(controlRecords.filter((record) => record.action !== "session-location").map((record) => record.action), ["reload", "reload", "reload", "navigate"]);
  assert.equal((await readFile(path.join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").length, prompts.length + 2, "only completion Send and the held ordinary request add model prompts");
  // Integrated terminals survive EH reload. Persistent ownership must block automatic RPC startup.
  const handoffComplete = await invoke("command", { command: "pi.extensionUiCompatibility" }, false);
  await page.getByRole("button", { name: "Hand Off to Terminal", exact: true }).click();
  await page.getByText(/Hand this session to Pi in a terminal/).waitFor();
  await page.getByRole("button", { name: "Hand Off to Terminal", exact: true }).click();
  await handoffComplete();
  const terminalPids = await until(async () => {
    const rows = (await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").map(Number);
    return rows.length >= pids.length + 1 ? rows : undefined;
  }, "fixture terminal writer started");
  const previousBoot = (await json("ready.json")).boot;
  await invoke("command", { command: "workbench.action.reloadWindow" }, false);
  await until(async () => { const next = await json("ready.json"); return next && next.boot !== previousBoot; }, "ownership-preserving window reload", 40_000);
  pi = await frame();
  await until(async () => (await pi.locator("body").innerText()).includes("Reconnect"), "blocked sidebar after terminal handoff");
  await delay(500);
  assert.equal((await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").length, terminalPids.length, "EH reload must not start a second session writer");
  const closedTerminal = await invoke("closePiTerminal", { pid: terminalPids.at(-1) });
  // Terminal restoration can replace its API handle with a default shell. Simulate the required
  // manual inspection/stop of this known fixture writer, never an arbitrary process.
  if (process.platform === "linux") {
    try {
      const commandLine = await readFile(`/proc/${terminalPids.at(-1)}/cmdline`, "utf8");
      if (commandLine) {
        assert.ok(commandLine.split("\0").includes(executableFixture), "only the captured disposable fixture may be stopped");
        process.kill(terminalPids.at(-1), "SIGTERM");
      }
    } catch (error) {
      if (error.code !== "ENOENT" && error.code !== "ESRCH") throw error;
    }
  } else assert.equal(closedTerminal.closed, 1, JSON.stringify(closedTerminal));
  await until(async () => {
    try {
      process.kill(terminalPids.at(-1), 0);
      // Container init can retain an exited terminal root as a zombie; it cannot write session data.
      if (process.platform === "linux") {
        const stat = await readFile(`/proc/${terminalPids.at(-1)}/stat`, "utf8");
        return stat.slice(stat.lastIndexOf(")") + 1).trimStart().startsWith("Z");
      }
      return false;
    } catch (error) { return error.code === "ESRCH" || error.code === "ENOENT"; }
  }, "fixture terminal stopped before explicit return");
  const returnComplete = await invoke("command", { command: "pi.returnFromTerminal" }, false);
  await page.getByRole("button", { name: "Return Ownership", exact: true }).click();
  await returnComplete();
  assert.equal((await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").length, terminalPids.length + 1);
  console.log("PI_NATIVE_CONTROL repeated reload, clone, no-summary navigation, fork, draft preservation and persistent terminal ownership passed");
  console.log("PI_NATIVE_INTERFACE both queue buttons, pending labels, Stop/recovery and deletion confirmation passed");
  await writeFile(path.join(directory, "thinking.json"), JSON.stringify(thinkingFixture));
  await pi.locator("#input").fill("");
  await pi.locator("#input").fill("Show the deterministic thinking transcript.");
  await pi.locator("#send").click();
  await pi.locator(".thinking-transcript").waitFor();
  const thinkingSummary = pi.locator(".thinking-transcript summary");
  assert.equal(await pi.locator(".thinking-transcript").evaluate((element) => element.open), false);
  await thinkingSummary.focus();
  await thinkingSummary.press("Enter");
  assert.ok((await pi.locator(".thinking-transcript").innerText()).includes("Authoritative visible thinking."));
  await thinkingSummary.press("Space");
  await writeFile(path.join(directory, "thinking-release"), "settle");
  await until(async () => !(await pi.locator("#cancel").isVisible()), "thinking history replacement");
  const thinkingEvidence = await assertThinkingDisclosure(pi);
  assert.equal(await pi.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const thinkingBoot = (await json("ready.json")).boot;
  await invoke("command", { command: "workbench.action.reloadWindow" }, false);
  await until(
    async () => {
      const next = await json("ready.json");
      return next && next.boot !== thinkingBoot;
    },
    "thinking reload",
    40_000,
  );
  pi = await frame();
  await until(
    async () => (await pi.locator(".thinking-transcript").count()) === 2,
    "thinking restored from Pi after reconnect",
  );
  if (!(await pi.locator(".thinking-transcript summary").first().isVisible())) {
    await pi.locator("#recent-session-list .current").click();
  }
  await assertThinkingDisclosure(pi);
  console.log("PI_NATIVE_THINKING", JSON.stringify({ ...thinkingEvidence, reconnect: "restored from fixture history" }));
  await assertNativeDraftLocalCommands({ pi, page, until, directory });
  pi = await assertNativeDraftRecovery({ pi, page, until, directory, reload: async () => {
    const boot = (await json("ready.json")).boot;
    await invoke("command", { command: "workbench.action.reloadWindow" }, false);
    await until(async () => {
      const next = await json("ready.json");
      return next && next.boot !== boot;
    }, "text draft actual window reload", 40_000);
    const next = await frame();
    await until(async () => (await next.locator("#runtime").getAttribute("data-connection")) === "connected" &&
      (await next.locator("#status").textContent()) === "", "draft reload runtime idle");
    await assertComposerStatusContract(next);
    return next;
  } });
  console.log(
    "PI_NATIVE_UI_EVIDENCE",
    JSON.stringify({
      version: ready.version,
      platform: process.platform,
      workspaceAlias,
      packaged,
      richContent: "Markdown, math fonts, flowchart and sequence SVG passed",
      thinkingTranscript: thinkingEvidence,
      settingsPanel: "gear opens native Settings; all controls, arrays, User/Workspace writes, scoped Reset; separate singleton Pi Configuration drafts and no Pi side effects passed",
      semanticAttachmentPicker: "passed",
      composerFileCompletion: "search, dirty snapshot, inspection, path-only Tab, failed capture, stale draft and explicit single Send passed",
      interface:
        "image preview/focus, session details, both queue actions, status/Stop, recovered drafts, deletion modal and native 200% zoom geometry in dark/light/high-contrast passed",
      fourReviewScopes: "passed",
      nativeProblemsAndAskFix: "passed",
      dirtyFindingBufferGuard: "passed",
      findingPreviewApplyUndo: "passed",
      selectedHunkBatchPreviewApplyUndo: "passed",
      cancellation: "passed",
      reloadCleanup: "passed",
      sessionControls: "3 handled reloads, clone, no-summary navigate, fork, native dialogs, unchanged draft, and terminal ownership across EH reload passed",
      sessionQuickSwitch: "native title/ID search, cancellation/current no-op, three-session fixed cycle, editor/composer chords, terminal/Quick Pick exclusion and changed-cwd rejection",
      provider: "deterministic RPC fixture; no model calls",
      screenshot,
    }),
  );
  }
  if (!process.argv.includes("transfer")) await assertExtensionEditorDialogs({ page, directory, invoke, until, frame });
  }
  await invoke("finish", {}, false);
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(tmpdir(), `pi-native-ui-${evidenceLabel}-failure.png`) }).catch(() => {});
    console.error(
      (
        await page
          .locator("body")
          .innerText()
          .catch(() => "")
      ).slice(-15_000),
    );
    for (const candidate of page.frames())
      if (await candidate.locator("#add-context").count()) console.error(await candidate.locator("body").innerText());
  }
  console.error(await readFile(path.join(directory, "coordinator-error.txt"), "utf8").catch(() => ""));
  console.error(log.slice(-10_000));
  console.error(`Native UI fixture (removed during cleanup): ${directory}`);
  throw error;
} finally {
  await browser?.close().catch(() => {});
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(5_000)]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
}
