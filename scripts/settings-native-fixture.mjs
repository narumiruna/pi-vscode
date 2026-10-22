import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const settingKeys = [
  "sensitiveContextNames",
  "annotations.initialState",
  "inlineCompletions.enabled",
  "inlineCompletions.debounceMilliseconds",
  "inlineCompletions.minimumPrefixLength",
  "inlineCompletions.excludedLanguages",
  "approveProjectResources",
  "executablePath",
  "provider",
  "model",
  "thinkingLevel",
];

// This coordinator is installed only in the disposable development profile.
// It never opens Sessions, starts Pi, or performs Pi setting/file edits on behalf of the UI.
// Theme changes are test setup in the disposable profile.
export const settingsCoordinatorSource = `
const vscode = require("vscode");
const fs = require("node:fs/promises");
const path = require("node:path");
exports.activate = async () => {
  const directory = process.env.PI_VSCODE_UI_FIXTURE;
  const file = name => path.join(directory, name);
  try {
    await vscode.extensions.getExtension("narumi.narumi-pi")?.activate();
    await fs.writeFile(file("ready.json"), JSON.stringify({
      version: vscode.version, trusted: vscode.workspace.isTrusted,
      workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
      remoteName: vscode.env.remoteName ?? null,
    }));
    let last = 0;
    setInterval(async () => {
      const request = await fs.readFile(file("request.json"), "utf8").then(JSON.parse).catch(() => undefined);
      if (!request || request.id <= last) return;
      last = request.id;
      let result, error;
      try {
        if (request.action === "command") result = await vscode.commands.executeCommand(request.command, ...(request.args ?? []));
        else if (request.action === "settingsState") {
          const config = vscode.workspace.getConfiguration("pi");
          const values = Object.fromEntries(${JSON.stringify(settingKeys)}.map(key => [key, config.inspect(key)]));
          const nativeTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).map(tab => ({
            label: tab.label, webview: tab.input instanceof vscode.TabInputWebview,
          }));
          result = { values, nativeTabs, model: values.model,
            tabs: nativeTabs.filter(tab => tab.label === "Pi Configuration").length };
        } else if (request.action === "theme") {
          await vscode.workspace.getConfiguration("workbench").update("colorTheme", request.theme, vscode.ConfigurationTarget.Global);
        } else if (request.action === "finish") return;
        else throw new Error("Unexpected Settings fixture action");
      } catch (failure) { error = String(failure.stack); }
      await fs.writeFile(file("result.tmp"), JSON.stringify({ id: request.id, result, error }));
      await fs.rename(file("result.tmp"), file("result.json"));
    }, 50);
  } catch (error) { await fs.writeFile(file("coordinator-error.txt"), String(error.stack)); }
};
`;

export async function openNativeSetting({ page, invoke }, key, scope = "workspace") {
  await invoke("command", { command: "workbench.action.openSettings", args: [`@id:pi.${key}`] });
  const editor = page.locator(".settings-editor");
  await editor.waitFor({ state: "visible" });
  await editor.getByRole("tab", { name: scope === "workspace" ? /^Workspace/ : /^User/, exact: false }).click();
  const row = editor.locator(`[data-key="pi.${key}"]`);
  await row.waitFor({ state: "visible" });
  return row;
}

export async function resetNativeSetting(page, row) {
  // Settings applies its debounced configuration refresh after the API event.
  // Do not open a menu on the row that this refresh is about to replace.
  await page.waitForTimeout(1_000);
  await row.hover();
  await row.locator(".setting-toolbar-container .action-label").first().click();
  const reset = page.getByRole("menuitem", { name: /^Reset Setting/ });
  await reset.waitFor({ state: "visible" });
  await reset.click();
}

export async function selectNativeSetting(page, row, value) {
  const control = row.locator("select");
  if (await control.count()) await control.selectOption(value);
  else {
    await row.getByRole("combobox").click();
    await page.getByRole("option", { name: value, exact: true }).click();
  }
}

/** Open the native Pi title overflow, not the composer More menu. */
export async function openSettingsOverflow(page) {
  const sidebar = page.locator(".part.auxiliarybar");
  const titles = sidebar.locator(".title-actions, .pane-header");
  assert.equal(await titles.locator(".codicon-gear").count(), 0, "Settings must not have standalone title gears");
  const overflow = titles.getByRole("button", { name: /^(?:Views and )?More Actions\.\.\.$/ }).first();
  await overflow.focus();
  await overflow.press("Enter");
  const extension = page.getByRole("menuitem", { name: /^(?:Pi: )?Extension Settings$/ });
  const configuration = page.getByRole("menuitem", { name: /^(?:Pi: )?Pi Configuration$/ });
  await extension.waitFor({ state: "visible" });
  await configuration.waitFor({ state: "visible" });
  const labels = await page.locator(".context-view .action-label").allTextContents();
  const index = labels.findIndex((label) => label.trim() === "Extension Settings");
  assert.ok(index >= 0);
  assert.equal(labels[index + 1]?.trim(), "Pi Configuration", "Settings destinations must be adjacent and ordered");
  for (const item of [extension, configuration])
    assert.notEqual(await item.getAttribute("aria-haspopup"), "true", "Settings must not require another submenu");
  return { extension, configuration };
}

/** Real Settings controls and real configuration writes; passive routes do not start Pi. */
export async function assertNativeSettings({ page, directory, workspace, invoke, until, baseline = false, version }) {
  const read = (name) =>
    readFile(path.join(directory, name), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const before = { pids: await read("pids.jsonl"), prompts: await read("prompts.jsonl") };
  await invoke(
    "command",
    baseline
      ? { command: "workbench.action.openSettings", args: ["@ext:narumi.narumi-pi"] }
      : { command: "pi.openSettings" },
  );
  const editor = page.locator(".settings-editor");
  await editor.waitFor({ state: "visible" });
  assert.match(await editor.innerText(), /User/);
  assert.match(await editor.innerText(), /Workspace/);
  const openedState = await invoke("settingsState");
  assert.equal(
    openedState.nativeTabs.some((tab) => tab.webview && /Pi (Settings|Configuration)/.test(tab.label)),
    false,
    "Native Settings must not create a Pi webview",
  );
  const toc = editor.locator(".settings-toc-container");
  const extensions = toc.getByRole("treeitem").first();
  if ((await extensions.getAttribute("aria-expanded")) === "false")
    await extensions.locator(".monaco-tl-twistie").click();
  const piCategory = toc.getByRole("treeitem").filter({ hasText: /^Pi\b/ }).first();
  await piCategory.waitFor({ state: "visible" });
  if ((await piCategory.getAttribute("aria-expanded")) === "false")
    await piCategory.locator(".monaco-tl-twistie").click();
  const categories = await until(async () => {
    const text = await toc.innerText();
    return (
      (baseline ? text.includes("Pi") : ["General", "Permissions", "Editor"].every((label) => text.includes(label))) &&
      text
    );
  }, "native Pi categories");
  console.log("PI_NATIVE_SETTINGS_CATEGORIES", JSON.stringify({ baseline, categories }));
  for (const key of settingKeys) {
    const row = await openNativeSetting({ page, invoke }, key);
    assert.ok(
      await row.locator("input, select, [role=checkbox], [role=combobox], .setting-list-widget").count(),
      `${key} must have a native control`,
    );
    if (["sensitiveContextNames", "inlineCompletions.excludedLanguages"].includes(key)) {
      assert.ok(await row.locator(".setting-list-widget").count(), `${key} must use the native array editor`);
    }
  }
  for (const key of ["sensitiveContextNames", "inlineCompletions.excludedLanguages"]) {
    const row = await openNativeSetting({ page, invoke }, key);
    await row.getByRole("button", { name: "Add Item", exact: true }).click();
    await row.locator("input").fill("native-array-fixture");
    await row.getByRole("button", { name: "OK", exact: true }).click();
    await until(async () => {
      const state = await invoke("settingsState");
      return state.values[key].workspaceValue?.includes("native-array-fixture");
    }, `${key} native array save`);
  }
  for (const scope of ["user", "workspace"]) {
    const row = await openNativeSetting({ page, invoke }, "model", scope);
    await row.locator("input").fill(`native-${scope}-model`);
    await until(
      async () =>
        (await invoke("settingsState")).model[scope === "user" ? "globalValue" : "workspaceValue"] ===
        `native-${scope}-model`,
      `${scope} native save-on-edit`,
    );
  }
  const workspaceRow = await openNativeSetting({ page, invoke }, "model");
  await resetNativeSetting(page, workspaceRow);
  await until(async () => {
    const state = await invoke("settingsState");
    return state.model.workspaceValue === undefined && state.model.globalValue === "native-user-model";
  }, "Workspace Reset preserves User override");
  await resetNativeSetting(page, await openNativeSetting({ page, invoke }, "model", "user"));
  await until(async () => (await invoke("settingsState")).model.globalValue === undefined, "User Reset");
  const annotationRow = await openNativeSetting({ page, invoke }, "annotations.initialState");
  await selectNativeSetting(page, annotationRow, "expanded");
  await until(
    async () => (await invoke("settingsState")).values["annotations.initialState"].workspaceValue === "expanded",
    "Native annotation enum save-on-edit",
  );
  await resetNativeSetting(page, annotationRow);
  await until(
    async () => (await invoke("settingsState")).values["annotations.initialState"].workspaceValue === undefined,
    "Native annotation enum Reset",
  );
  assert.equal(await read("pids.jsonl"), before.pids, "Settings must not start or restart Pi");
  assert.equal(await read("prompts.jsonl"), before.prompts, "Settings must not submit a model prompt");
  await assertMissingNativeFiles(directory, workspace);
  if (!baseline) await assertPiConfiguration({ page, invoke, until, directory, workspace, version });
  assert.equal(await read("pids.jsonl"), before.pids, "Pi Configuration must not start or restart Pi");
  assert.equal(await read("prompts.jsonl"), before.prompts, "Pi Configuration must not submit a model prompt");
  if (!baseline) await assertSettingsOverflow({ page, invoke, until, directory, version });
  console.log(
    "PI_NATIVE_SETTINGS",
    JSON.stringify({
      version,
      baseline,
      keys: settingKeys.length,
      arrays: "native list controls and Add Item save-on-edit",
      scopes: "User/Workspace save-on-edit and scoped Reset",
      sideEffects: "passive settings routes start no Pi; title menu checks follow one sidebar fixture startup; no model prompt",
      remote: "not available in local host",
      virtual: "not exercised",
    }),
  );
}

async function assertSettingsOverflow({ page, invoke, until, directory, version }) {
  // Opening Sessions initializes the fixture runtime. Menu actions must not start another process.
  await invoke("command", { command: "pi.chatView.focus" });
  const sidebar = await until(async () => {
    for (const candidate of page.frames()) {
      try {
        const model = candidate.locator("#model-picker");
        if ((await model.count()) && (await model.isEnabled())) return candidate;
      } catch (error) {
        if (!candidate.isDetached()) throw error;
      }
    }
  }, "Pi sidebar fixture ready for title menu checks");
  assert.ok(sidebar);
  const read = (name) => readFile(path.join(directory, name), "utf8").catch(() => "");
  const pids = await read("pids.jsonl");
  const prompts = await read("prompts.jsonl");
  assert.ok(pids.trim(), "The menu test has an explicit sidebar startup baseline");
  let menu = await openSettingsOverflow(page);
  const screenshot = path.join(tmpdir(), `pi-settings-overflow-${version}.png`);
  await page.screenshot({ path: screenshot });
  await menu.extension.press("Escape");
  await menu.extension.waitFor({ state: "hidden" });
  await menu.configuration.waitFor({ state: "hidden" });
  menu = await openSettingsOverflow(page);
  await menu.extension.click();
  await page.locator(".settings-editor").waitFor({ state: "visible" });
  menu = await openSettingsOverflow(page);
  await menu.configuration.click();
  await until(async () => (await invoke("settingsState")).tabs === 1, "Pi Configuration from title overflow");
  assert.equal(await read("pids.jsonl"), pids, "Title menu actions must not start or restart Pi");
  assert.equal(await read("prompts.jsonl"), prompts, "Title menu actions must not submit a prompt");
  console.log("PI_SETTINGS_OVERFLOW", JSON.stringify({ version, screenshot, standaloneGears: 0, submenu: false }));
}

async function assertMissingNativeFiles(directory, workspace) {
  for (const target of [
    path.join(workspace, ".pi/settings.json"),
    path.join(workspace, ".pi/mcp.json"),
    path.join(directory, "pi/settings.json"),
    path.join(directory, "pi/mcp.json"),
  ]) {
    await assert.rejects(readFile(target), { code: "ENOENT" });
  }
}

async function assertPiConfiguration({ page, invoke, until, directory, workspace, version }) {
  const frame = () =>
    until(async () => {
      for (const candidate of page.frames()) {
        try {
          if (await candidate.locator("#native-settings").count()) return candidate;
        } catch (error) {
          if (!candidate.isDetached()) throw error;
        }
      }
    }, "Pi Configuration webview");
  await invoke("command", { command: "pi.openPiConfiguration" });
  await invoke("command", { command: "pi.openPiConfiguration" });
  const state = await invoke("settingsState");
  assert.equal(state.nativeTabs.filter((tab) => tab.label === "Pi Configuration").length, 1);
  let form = await frame();
  await form.locator("#native-defaultModel").waitFor({ state: "visible" });
  assert.equal(await form.locator("#target, #categories").count(), 0);
  assert.equal(await form.locator("#native-defaultModel-save").isVisible(), false);
  for (const [theme, cssClass] of [
    ["Default Dark Modern", "vscode-dark"],
    ["Default Light Modern", "vscode-light"],
    ["Default High Contrast", "vscode-high-contrast"],
  ]) {
    await invoke("theme", { theme });
    await form.waitForFunction((name) => document.body.classList.contains(name), cssClass);
    assert.ok(
      await form.evaluate(() => getComputedStyle(document.body).getPropertyValue("--vscode-editor-background").trim()),
    );
    await page.screenshot({ path: path.join(tmpdir(), `pi-configuration-${version}-${cssClass}.png`) });
  }
  await invoke("theme", { theme: "Default Dark Modern" });
  await form.waitForFunction(() => document.body.classList.contains("vscode-dark"));
  await form.locator("#native-scope").selectOption("project");
  await until(async () => await form.locator("#native-defaultModel").isEnabled(), "Project Pi snapshot");
  const input = () => form.locator("#native-defaultModel");
  await input().fill("native-configuration-draft");
  await form.locator("#native-defaultModel-save").waitFor({ state: "visible" });
  await form.locator("#native-defaultModel-actions").focus();
  await form.locator("#native-defaultModel-actions").press("Enter");
  await until(
    async () => (await form.locator("#native-defaultModel-actions").getAttribute("aria-expanded")) === "true",
    "keyboard row actions expanded",
  );
  await form.locator("#native-defaultModel-actions").press("Escape");
  assert.equal(await input().inputValue(), "native-configuration-draft");
  await until(
    async () => (await form.locator("#native-defaultModel-actions").getAttribute("aria-expanded")) === "false",
    "Escape closes row actions",
  );
  await assertMissingNativeFiles(directory, workspace);
  // The labelled cross-link must use the native Settings route and keep the unsaved Pi draft.
  await form.getByRole("button", { name: "Open Extension Settings", exact: true }).click();
  await page.locator(".settings-editor").waitFor({ state: "visible" });
  await invoke("command", { command: "pi.openPiConfiguration" });
  form = await frame();
  await until(async () => (await input().inputValue()) === "native-configuration-draft", "Pi file draft reveal");
  await form.locator("#native-defaultModel-save").click();
  await until(async () => !(await form.locator("#native-defaultModel-save").isVisible()), "Pi file Save acknowledged");
  assert.equal(
    await input().evaluate((element) => document.activeElement === element),
    true,
    "Save returns focus to its field",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8")).defaultModel,
    "native-configuration-draft",
  );
  await form.locator("#native-defaultModel-actions").click();
  await form.locator("#native-defaultModel-reset").click();
  await until(async () => {
    const saved = JSON.parse(await readFile(path.join(workspace, ".pi/settings.json"), "utf8"));
    return saved.defaultModel === undefined;
  }, "Pi file Reset override");
  assert.equal(await form.locator("#native-defaultModel-save").isVisible(), false);
  await invoke("command", { command: "workbench.action.closeActiveEditor" });
  console.log(
    "PI_NATIVE_CONFIGURATION singleton, immediate form, three native themes, separate scopes, draft-only edits, keyboard actions, hide/reveal, explicit Save/focus and Reset passed",
  );
}
