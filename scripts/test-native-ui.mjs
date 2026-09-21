import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { chromium } from "playwright-core";

// Actual Quick Picks, modals, Problems, code actions and webview clicks; only Pi is simulated.
const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.106.0";
const workspaceAlias = process.argv[3] === "alias";
const evidenceLabel = `${version}${workspaceAlias ? "-alias" : ""}`;
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
  await writeFile(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "files.autoSave": "off",
      "telemetry.telemetryLevel": "off",
      "picode.executablePath": executableFixture,
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
    `exports.activate = () => { require('./workflow.js').run().catch(error => { require('node:fs').writeFileSync(require('node:path').join(process.env.PICODE_UI_FIXTURE, 'coordinator-error.txt'), String(error.stack)); }); };`,
  );
  const executable = await downloadAndUnzipVSCode({
    version,
    cachePath: path.join(tmpdir(), "pi-vscode-native-cache"),
  });
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
      `--extensionDevelopmentPath=${repository}`,
      `--extensionDevelopmentPath=${helper}`,
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, PICODE_UI_FIXTURE: directory, PI_CODING_AGENT_DIR: path.join(directory, "pi") },
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
    await input.fill(text);
    await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: text }).first().click();
    await input.waitFor({ state: "hidden" });
  };
  // Start a session detail pane, then capture all five provider-backed attachment types.
  let pi = await frame();
  await until(async () => (await pi.locator("body").innerText()).includes("Ready"), "Pi runtime ready");
  const initial = await invoke("state");
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
  const cancelled = await invoke("command", { command: "picode.reviewChanges" }, false);
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
    const complete = await invoke("command", { command: "picode.reviewChanges" }, false);
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
  await invoke("command", { command: "workbench.actions.view.problems" });
  const problem = page.getByRole("treeitem", { name: /Warning: Native workingTree/ });
  await problem.dblclick();
  await until(
    async () => /^picode-review:/.test((await invoke("state")).active ?? ""),
    "Problems captured-document navigation",
  );
  await respond("Native fixture explanation.");
  await problem.click();
  await invoke("command", { command: "problems.action.showQuickFixes" });
  await page.getByRole("menuitem", { name: "Ask Pi About Finding", exact: true }).waitFor();
  await delay(300); // Native context menu positioning/focus settles after the command returns.
  await page.getByRole("menuitem", { name: "Ask Pi About Finding", exact: true }).click();
  await until(
    async () => (await (await frame()).locator("body").innerText()).includes("Native fixture explanation."),
    "Ask response in Sidebar",
  );
  // Restore the captured document through the legacy-independent findings command.
  const navigation = await invoke("command", { command: "picode.showReviewFindings" }, false);
  await pick("Native workingTree finding");
  await navigation();
  await respond("<<<PICODE_REPLACEMENT_START>>>\nexport const other = 40;\n<<<PICODE_REPLACEMENT_END>>>");
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
  await findingCard.getByRole("button", { name: "Reject", exact: true }).click();
  console.log("PI_NATIVE_UI four scopes, Problems navigation and Ask/Fix passed");
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
  const repair = await invoke("command", { command: "picode.fixWorkspaceDiagnostics" }, false);
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
  console.log(
    "PI_NATIVE_UI_EVIDENCE",
    JSON.stringify({
      version: ready.version,
      platform: process.platform,
      workspaceAlias,
      semanticAttachmentPicker: "passed",
      fourReviewScopes: "passed",
      nativeProblemsAndAskFix: "passed",
      selectedHunkBatchPreviewApplyUndo: "passed",
      cancellation: "passed",
      reloadCleanup: "passed",
      provider: "deterministic RPC fixture; no model calls",
      screenshot,
    }),
  );
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
