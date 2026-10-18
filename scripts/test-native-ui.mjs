import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { chromium } from "playwright-core";
import extensionUiFixture from "./fixtures/extension-ui.cjs";
import { assertExtensionEditorDialogs } from "./editor-dialog-fixture.mjs";
import toolFixture from "./fixtures/tool-activity.cjs";
import { assertRichContent, richFixture } from "./rich-content-fixture.mjs";
import { assertToolActivity } from "./tool-activity-fixture.mjs";
import { assertNativeFileCompletion } from "./completion-native-fixture.mjs";
import thinkingFixture from "./fixtures/thinking.cjs";
import { assertThinkingDisclosure } from "./thinking-fixture.mjs";

// Actual Quick Picks, modals, Problems, code actions and webview clicks; only Pi is simulated.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.106.0";
const workspaceAlias = process.argv[3] === "alias";
const packaged = process.argv.includes("packaged");
const evidenceLabel = `${version}${workspaceAlias ? "-alias" : ""}${packaged ? "-packaged" : ""}`;
if (process.platform !== "linux") throw new Error("The native UI runner currently supports Linux only.");
const directory = await mkdtemp(path.join(tmpdir(), "pi-native-ui-"));
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
  if (workspaceAlias) await symlink(workspace, openedWorkspace, "junction");
  await mkdir(path.join(userData, "User"), { recursive: true });
  const executableFixture = path.join(directory, "pi-fixture");
  await copyFile(path.join(repository, "scripts", "fixtures", "native-pi.cjs"), executableFixture);
  await chmod(executableFixture, 0o700);
  await respond("Native fixture explanation.");
  await writeFile(path.join(directory, "extension-ui.json"), JSON.stringify(extensionUiFixture));
  await writeFile(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "files.autoSave": "off",
      "telemetry.telemetryLevel": "off",
      "pi.executablePath": executableFixture,
      "workbench.startupEditor": "none",
      "window.dialogStyle": "custom",
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
  await writeFile(
    path.join(helper, "package.json"),
    JSON.stringify({
      name: "native-ui-coordinator",
      publisher: "fixture",
      version: "0.0.1",
      engines: { vscode: "^1.106.0" },
      activationEvents: ["onStartupFinished"],
      main: "./main.cjs",
    }),
  );
  await writeFile(
    path.join(helper, "main.cjs"),
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
      env: { ...process.env, PI_VSCODE_UI_FIXTURE: directory, PI_CODING_AGENT_DIR: path.join(directory, "pi") },
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
      async () => !(await input.isVisible()) || (await input.getAttribute("aria-label")) !== label,
      "Quick Pick accepted or advanced",
    );
  };
  // Start a session detail pane, then capture all five provider-backed attachment types.
  let pi = await frame();
  await until(async () => (await pi.locator("body").innerText()).includes("Ready"), "Pi runtime ready");
  if (!process.argv.includes("editor")) {
  const initial = await invoke("state");
  // Settings uses the real Extension Host configuration API and packaged webview.
  const settingsFrame = () =>
    until(async () => {
      for (const candidate of page.frames()) {
        try {
          if (await candidate.locator("#native-settings").count()) return candidate;
        } catch (error) {
          if (!candidate.isDetached()) throw error;
        }
      }
    }, "Settings webview");
  const pidsBeforeSettings = await readFile(path.join(directory, "pids.jsonl"), "utf8");
  const promptsBeforeSettings = await readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const gear = page
    .locator(
      '[aria-label="Open Settings"], [aria-label="Pi: Open Settings"], [title="Open Settings"], [title="Pi: Open Settings"]',
    )
    .first();
  await gear.click();
  let settings = await settingsFrame();
  await settings.locator('section[data-key="model"] input').waitFor();
  await invoke("command", { command: "pi.openSettings" });
  assert.equal((await invoke("settingsState")).tabs, 1);
  const settingsRow = () => settings.locator('section[data-key="model"]');
  await settingsRow().locator("input").fill("native-user-model");
  await settingsRow().getByRole("button", { name: "Save", exact: true }).click();
  await until(
    async () => (await invoke("settingsState")).model.globalValue === "native-user-model",
    "User setting saved",
  );
  await until(async () => (await settingsRow().innerText()).includes("Saved"), "User save acknowledged");
  await settings.locator("#target").selectOption("workspace");
  await settingsRow().locator("input").fill("native-workspace-model");
  await settingsRow().getByRole("button", { name: "Save", exact: true }).click();
  await until(
    async () => (await invoke("settingsState")).model.workspaceValue === "native-workspace-model",
    "Workspace setting saved",
  );
  await until(async () => (await settingsRow().innerText()).includes("Saved"), "Workspace save acknowledged");
  await settingsRow().getByRole("button", { name: "Reset", exact: true }).click();
  await until(async () => (await invoke("settingsState")).model.workspaceValue === undefined, "Workspace reset");
  await settings.locator("#target").selectOption("user");
  await settingsRow().getByRole("button", { name: "Reset", exact: true }).click();
  await until(async () => (await invoke("settingsState")).model.globalValue === undefined, "User reset");
  await page.screenshot({ path: path.join(tmpdir(), `pi-settings-native-${evidenceLabel}.png`) });
  await settingsRow().locator("input").fill("hidden-draft");
  await invoke("source");
  await delay(400);
  await invoke("command", { command: "pi.openSettings" });
  settings = await settingsFrame();
  await until(
    async () => (await settingsRow().locator("input").inputValue()) === "hidden-draft",
    "Draft survives hide/reveal",
  );
  assert.equal((await invoke("settingsState")).tabs, 1);
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
  console.log("PI_NATIVE_UI settings gear, singleton, scopes, reset, drafts and no Pi side effects passed");
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
  pi = await frame();
  const imagePreview = pi.locator(".transcript-image").first();
  await imagePreview.waitFor();
  await until(async () => imagePreview.isEnabled(), "native image payload");
  await imagePreview.focus();
  await page.keyboard.press("Enter");
  assert.equal(await pi.locator("#image-preview").evaluate((dialog) => dialog.open), true);
  await page.keyboard.press("Escape");
  assert.equal(await imagePreview.evaluate((element) => document.activeElement === element), true);
  await pi.locator("#session-details summary").focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("Tab");
  assert.equal(await pi.locator("#session").inputValue(), "native-ui-session");
  assert.equal(await pi.locator("#session").evaluate((element) => document.activeElement === element), true);
  await pi.locator("#session").selectText();
  assert.equal(await pi.locator("#session").evaluate((input) => input.selectionEnd - input.selectionStart), 17);
  await pi.locator("#session-details summary").click();
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
  await pi.locator("#extension-ui-above").waitFor();
  assert.match(await pi.locator("#extension-ui-above").innerText(), /second: Updated status/);
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
    assert.equal(await pi.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    for (const id of [
      "input",
      "add-context",
      "cancel",
      "after-this",
      "send",
      "status",
      "usage",
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
  assert.equal(await pi.locator("#recover-queue").isVisible(), true);
  await rm(path.join(directory, "interface-hold"));
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
  await pick("user: Hold this deterministic response");
  await pick("Navigate without summary");
  await branchComplete();
  assert.equal(await pi.locator("#input").inputValue(), retainedDraft, "A native branch selection must not overwrite a nonempty draft");
  branchComplete = await invoke("command", { command: "pi.browseSessionTree" }, false);
  await pick("user: Hold this deterministic response");
  await pick("Fork from user message");
  await branchComplete();
  const controlRecords = (await readFile(path.join(directory, "controls.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(controlRecords.map((record) => record.action), ["reload", "reload", "reload", "navigate"]);
  assert.equal((await readFile(path.join(directory, "prompts.jsonl"), "utf8")).trim().split("\n").length, prompts.length + 1);
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
  await invoke("closePiTerminal");
  await until(() => {
    try { process.kill(terminalPids.at(-1), 0); return false; } catch (error) { return error.code === "ESRCH"; }
  }, "fixture terminal stopped before explicit return");
  const returnComplete = await invoke("command", { command: "pi.returnFromTerminal" }, false);
  await page.getByRole("button", { name: "Return Ownership", exact: true }).click();
  await returnComplete();
  assert.equal((await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").length, terminalPids.length + 1);
  console.log("PI_NATIVE_CONTROL repeated reload, clone, no-summary navigation, fork, draft preservation and persistent terminal ownership passed");
  console.log("PI_NATIVE_INTERFACE both queue buttons, pending labels, Stop/recovery and deletion confirmation passed");
  await writeFile(path.join(directory, "thinking.json"), JSON.stringify(thinkingFixture));
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
  console.log(
    "PI_NATIVE_UI_EVIDENCE",
    JSON.stringify({
      version: ready.version,
      platform: process.platform,
      workspaceAlias,
      packaged,
      richContent: "Markdown, math fonts, flowchart and sequence SVG passed",
      thinkingTranscript: thinkingEvidence,
      settingsPanel: "gear, singleton, User/Workspace writes, reset, hide/reveal drafts, no Pi side effects passed",
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
      provider: "deterministic RPC fixture; no model calls",
      screenshot,
    }),
  );
  }
  await assertExtensionEditorDialogs({ page, directory, invoke, until, frame });
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
