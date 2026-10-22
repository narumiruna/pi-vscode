import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { getSettingsHtml } = require("../out/settingsHtml.js");
const { nativeSettingControls, mcpExposures } = require("../out/nativePiModel.js");
let origin;
const server = http.createServer(async (request, response) => {
  try {
    if (request.url === "/") {
      response.setHeader("Content-Type", "text/html");
      response.end(
        getSettingsHtml({ source: origin, script: `${origin}/settings.js`, style: `${origin}/settings.css` }),
      );
    } else if (["/settings.js", "/settings.css"].includes(request.url)) {
      response.setHeader("Content-Type", request.url.endsWith("js") ? "text/javascript" : "text/css");
      response.end(await readFile(`out/settings${request.url}`));
    } else {
      response.writeHead(404);
      response.end();
    }
  } catch (error) {
    response.writeHead(500);
    response.end(String(error));
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const errors = [];
  const requests = [];
  const messages = [];
  const snapshot = { type: "snapshot", nativeFilesAvailable: true };
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("request", (request) => requests.push(request.url()));
  await page.exposeFunction("fixturePost", (message) => messages.push(message));
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({
      postMessage: (message) => window.fixturePost(message),
      getState: () => JSON.parse(localStorage.getItem("fixtureState") ?? "null"),
      setState: (state) => localStorage.setItem("fixtureState", JSON.stringify(state)),
    });
  });
  const send = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const push = () => send(snapshot);
  const waitMessage = async (type, after = -1) => {
    for (let i = 0; i < 100; i++) {
      const result = messages.slice(after + 1).findLast((message) => message.type === type);
      if (result) return result;
      await page.waitForTimeout(10);
    }
    throw new Error(`Missing ${type} request`);
  };
  const nativeRow = (key) => page.locator(`section[data-native-key="${key}"]`);
  const field = (row) => row.locator("input,select,textarea");
  const rowId = (row) => field(row).getAttribute("id");
  const saveButton = (row) => row.locator('button[id$="-save"]');
  const recoverButton = (row) => row.locator('button[id$="-recover"]');
  const menu = (row) => row.locator("details.setting-actions");
  const summary = (row) => menu(row).locator("summary");
  const openActions = async (row) => {
    if (!(await menu(row).evaluate((node) => node.open))) {
      await summary(row).click();
    }
    await page.waitForFunction(
      (id) => document.getElementById(id)?.getAttribute("aria-expanded") === "true",
      await summary(row).getAttribute("id"),
    );
  };
  const cleanRow = async (row) => {
    assert.equal(await saveButton(row).count(), 1, "Clean rows retain a hidden Save button");
    assert.equal(await saveButton(row).isVisible(), false);
    assert.equal(await recoverButton(row).isVisible(), false, "Inline recovery is visible only for conflicts");
    assert.equal(await menu(row).evaluate((node) => node.open), false);
    assert.equal(await row.getByRole("button", { name: "Reset override", exact: true }).isVisible(), false);
    assert.equal(await row.getByRole("button", { name: "Reload row", exact: true }).isVisible(), false);
    assert.equal(await summary(row).isVisible(), true, "Actions must not require pointer hover");
  };
  const nativeOverrides = { global: {}, project: {} };
  const mcpOverrides = { global: {}, project: {} };
  let nativeRevision = 1;
  let nativeOrigin = "a".repeat(64);
  const project = (key, fallback, scope, overrides) => {
    const own = overrides[scope][key];
    const inherited = scope === "project" ? (overrides.global[key] ?? fallback) : fallback;
    return {
      key,
      ...(own !== undefined ? { own } : {}),
      inherited,
      value: own ?? inherited,
      source:
        own !== undefined ? scope : scope === "project" && overrides.global[key] !== undefined ? "global" : "default",
      hasOverride: own !== undefined,
      invalid: false,
      inheritedInvalid: false,
    };
  };
  const nativeProjection = (request) => ({
    type: "nativeSnapshot",
    id: request.id,
    scope: request.scope,
    origin: nativeOrigin,
    revision: nativeRevision.toString(16).padStart(64, "0"),
    approved: false,
    entries: [
      ...nativeSettingControls.map((control) =>
        project(control.key, control.defaultValue, request.scope, nativeOverrides),
      ),
      { key: "unknownNative", value: "UNKNOWN_NATIVE_CANARY" },
    ],
    unknown: "UNKNOWN_NATIVE_CANARY",
    servers: [
      {
        name: "fixture-server",
        type: "stdio",
        source: "global",
        enabled: true,
        exposure: "codemode",
        state: "unknown",
        command: "TRANSPORT_CANARY",
        env: { SECRET: "AUTH_CANARY" },
        fields: [
          project("enabled", true, request.scope, mcpOverrides),
          project("exposure", "codemode", request.scope, mcpOverrides),
        ],
      },
    ],
  });
  const loadNative = async (after = -1) => {
    const request = await waitMessage("nativeLoad", after);
    await send(nativeProjection(request));
    await send({ type: "nativeResult", id: request.id, ok: true });
    return request;
  };
  const acceptNative = async (request) => {
    const overrides = request.server === undefined ? nativeOverrides : mcpOverrides;
    if (request.type === "nativeReset") delete overrides[request.scope][request.key];
    else overrides[request.scope][request.key] = request.value;
    nativeRevision++;
    await send(nativeProjection(request));
    await send({ type: "nativeResult", id: request.id, ok: true });
  };
  const writeCount = () => messages.filter((message) => ["nativeSave", "nativeReset"].includes(message.type)).length;
  const assertGuard = (request) => {
    assert.ok(request.id.length <= 80 && /^[a-zA-Z0-9_-]+$/.test(request.id));
    assert.equal(request.revision, nativeRevision.toString(16).padStart(64, "0"));
    assert.ok(!Object.hasOwn(request, "path") && !Object.hasOwn(request, "target"));
  };
  const refresh = async () => {
    const after = messages.length - 1;
    await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
    return loadNative(after);
  };
  const reloadRow = async (row, conflict = false) => {
    const after = messages.length - 1;
    if (conflict) {
      assert.equal(await recoverButton(row).isVisible(), true);
      await recoverButton(row).click();
    } else {
      await openActions(row);
      await row.locator('button[id$="-reload"]').click();
    }
    await loadNative(after);
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      await rowId(row),
      "Row reload restores field focus after loading, including removed stale recovery actions",
    );
  };
  const selectNativeScope = async (scope) => {
    const after = messages.length - 1;
    await page.locator("#native-scope").selectOption(scope);
    await loadNative(after);
  };
  const editNative = async (row, value) => {
    const control = field(row);
    if (typeof value === "boolean") await control.setChecked(value);
    else if (await control.evaluate((element) => element.tagName === "SELECT")) await control.selectOption(value);
    else await control.fill(Array.isArray(value) ? value.join("\n") : value);
  };

  // The shell edits Pi files only; native VS Code Settings is one fixed IPC route.
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("#native-settings") !== null);
  assert.equal(await page.locator("h1").innerText(), "Pi Configuration");
  assert.equal(await page.locator("nav,#target,[data-key]").count(), 0);
  assert.equal(await page.locator("#native-settings").innerText(), "Open VS Code Settings");
  assert.equal(messages.filter((message) => message.type === "nativeLoad").length, 0);
  await push();
  await loadNative();
  assert.equal(await page.locator("[data-native-key]").count(), 10);
  assert.deepEqual(await page.locator("#native-scope option").allTextContents(), ["Global Pi", "Project Pi"]);
  assert.match(await page.locator("body").innerText(), /starts no Pi process|does not start Pi|never starts Pi/i);
  assert.doesNotMatch(await page.locator("body").innerText(), /General, Permissions, and Editor edit|Pi Files/);
  const details = page.locator("details:not(.setting-actions)").first();
  assert.equal(await details.evaluate((node) => node.open), false, "Introduction details start collapsed");
  await details.locator("summary").click();
  assert.match(await page.locator("body").innerText(), /~\/\.pi\/agent\/settings\.json/);
  assert.match(await page.locator("body").innerText(), /\.pi\/settings\.json/);
  await details.locator("summary").click();
  let after = messages.length - 1;
  await page.locator("#native-settings").click();
  assert.deepEqual(await waitMessage("openNative", after), { type: "openNative" });
  for (const row of await page.locator("[data-native-key]").all()) await cleanRow(row);
  assert.equal(writeCount(), 0, "Opening, loading and introduction details never write files");
  const providerRow = nativeRow("defaultProvider");
  const modelRow = nativeRow("defaultModel");
  assert.equal(await summary(providerRow).getAttribute("id"), "native-defaultProvider-actions");
  assert.equal(await summary(providerRow).getAttribute("aria-label"), "Actions for Startup provider");

  // Opening, keyboard navigation, Escape and outside dismissal never write or discard drafts.
  await field(providerRow).fill("menu-draft");
  const menuWrites = writeCount();
  await summary(providerRow).focus();
  await page.keyboard.press("Enter");
  await page.waitForFunction(
    () => document.getElementById("native-defaultProvider-actions")?.getAttribute("aria-expanded") === "true",
  );
  assert.equal(await providerRow.locator('button[id$="-reset"]').isDisabled(), true);
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider-reload");
  await page.keyboard.press("Escape");
  assert.equal(await menu(providerRow).evaluate((node) => node.open), false);
  assert.equal(await summary(providerRow).getAttribute("aria-expanded"), "false");
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider-actions");
  await page.keyboard.press("Space");
  await page.waitForFunction(
    () => document.getElementById("native-defaultProvider-actions")?.getAttribute("aria-expanded") === "true",
  );
  await page.locator("h1").click();
  assert.equal(await menu(providerRow).evaluate((node) => node.open), false);
  assert.equal(await field(providerRow).inputValue(), "menu-draft");
  assert.equal(writeCount(), menuWrites);
  await reloadRow(providerRow);
  assert.equal(await field(providerRow).inputValue(), "");
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider");
  await cleanRow(providerRow);

  // An explicit edit back to the inherited value still permits an override save.
  await field(providerRow).fill("temporary");
  await field(providerRow).fill("");
  assert.equal(await saveButton(providerRow).isVisible(), true);
  after = messages.length - 1;
  await saveButton(providerRow).click();
  const equalOverride = await waitMessage("nativeSave", after);
  assert.equal(equalOverride.value, "");
  await acceptNative(equalOverride);
  assert.equal(Object.hasOwn(nativeOverrides.global, "defaultProvider"), true);
  await cleanRow(providerRow);

  const values = {
    defaultProvider: "fixture-provider",
    defaultModel: "fixture-model",
    defaultThinkingLevel: "high",
    enabledModels: ["provider/second:high", "provider/first"],
    steeringMode: "all",
    followUpMode: "all",
    "compaction.enabled": false,
    "retry.enabled": false,
  };
  // Every common field and MCP field uses explicit Save at both scopes.
  for (const scope of ["global", "project"]) {
    if (scope !== "global") await selectNativeScope(scope);
    if (scope === "project") assert.match(await page.locator("main").innerText(), /Project overrides remain inactive/);
    for (const descriptor of nativeSettingControls) {
      const row = nativeRow(descriptor.key);
      assert.equal(await row.locator("label").getAttribute("for"), `native-${descriptor.key}`);
      await cleanRow(row);
      const before = writeCount();
      const value =
        scope === "global"
          ? values[descriptor.key]
          : typeof descriptor.defaultValue === "boolean"
            ? true
            : Array.isArray(descriptor.defaultValue)
              ? ["project/model", "project/*:low"]
              : descriptor.choices
                ? descriptor.choices[0]
                : `project-${descriptor.key}`;
      await editNative(row, value);
      assert.equal(writeCount(), before, `${descriptor.key}: editing alone must not save`);
      assert.equal(await saveButton(row).isVisible(), true);
      assert.equal(await recoverButton(row).isVisible(), false);
      after = messages.length - 1;
      await saveButton(row).click();
      const request = await waitMessage("nativeSave", after);
      assertGuard(request);
      assert.equal(request.scope, scope);
      assert.equal(request.key, descriptor.key);
      assert.equal(request.server, undefined);
      assert.deepEqual(request.value, value);
      assert.equal(await field(row).isDisabled(), true);
      assert.equal(await saveButton(row).isVisible(), true);
      assert.equal(await saveButton(row).isDisabled(), true);
      assert.equal(await row.locator('button[id$="-reset"]').isDisabled(), true);
      assert.equal(await row.locator('button[id$="-reload"]').isDisabled(), true);
      await acceptNative(request);
      assert.match(await row.innerText(), /Saved/);
      assert.equal(await page.evaluate(() => document.activeElement.id), `native-${descriptor.key}`);
      assert.match(await row.locator(".meta").innerText(), /Selected-scope override:/);
      await cleanRow(row);
    }
    for (const [kind, name] of [
      ["settings", "Native settings management"],
      ["mcp", "Native MCP management"],
    ]) {
      after = messages.length - 1;
      await page.getByRole("button", { name, exact: true }).click();
      assert.deepEqual(await waitMessage("openPiFile", after), { type: "openPiFile", kind, scope });
    }
    const server = page.locator('[data-server="fixture-server"]');
    assert.match(await server.innerText(), /Transport: stdio.*Source: global.*Connection: unknown/s);
    for (const key of ["enabled", "exposure"]) {
      const row = server.locator(`[data-native-key="${key}"]`);
      const value = key === "enabled" ? scope === "project" : scope === "global" ? "direct" : "hidden";
      await cleanRow(row);
      const before = writeCount();
      await editNative(row, value);
      assert.equal(writeCount(), before, "MCP drafts do not auto-save");
      assert.equal(await saveButton(row).isVisible(), true);
      if (key === "exposure") assert.deepEqual(await row.locator("option").allTextContents(), mcpExposures);
      after = messages.length - 1;
      await saveButton(row).click();
      const request = await waitMessage("nativeSave", after);
      assertGuard(request);
      assert.equal(request.server, "fixture-server");
      assert.equal(request.scope, scope);
      assert.equal(request.key, key);
      assert.equal(request.value, value);
      assert.equal(await saveButton(row).isDisabled(), true);
      await acceptNative(request);
      assert.equal(await page.evaluate(() => document.activeElement.id), await rowId(row));
      await cleanRow(row);
    }
  }

  // Reset removes only the selected override and returns focus to the field after acknowledgement.
  for (const scope of ["project", "global"]) {
    await selectNativeScope(scope);
    for (const descriptor of nativeSettingControls) {
      const row = nativeRow(descriptor.key);
      await openActions(row);
      assert.equal(await row.locator('button[id$="-reset"]').isDisabled(), false);
      after = messages.length - 1;
      await row.locator('button[id$="-reset"]').focus();
      await page.keyboard.press("Enter");
      const request = await waitMessage("nativeReset", after);
      assertGuard(request);
      assert.equal(request.scope, scope);
      assert.equal(request.key, descriptor.key);
      assert.ok(!Object.hasOwn(request, "value"));
      assert.equal(await saveButton(row).isVisible(), true);
      assert.equal(await saveButton(row).isDisabled(), true);
      assert.equal(await field(row).isDisabled(), true);
      await acceptNative(request);
      assert.match(await row.locator(".meta").innerText(), /Selected-scope override: None/);
      assert.equal(await row.locator('button[id$="-reset"]').isDisabled(), true);
      assert.equal(await page.evaluate(() => document.activeElement.id), `native-${descriptor.key}`);
      if (scope === "project") assert.deepEqual(nativeOverrides.global[descriptor.key], values[descriptor.key]);
      await cleanRow(row);
    }
    for (const key of ["enabled", "exposure"]) {
      const row = page.locator(`[data-server] [data-native-key="${key}"]`);
      await openActions(row);
      after = messages.length - 1;
      await row.locator('button[id$="-reset"]').click();
      const request = await waitMessage("nativeReset", after);
      assertGuard(request);
      assert.equal(request.server, "fixture-server");
      assert.equal(request.scope, scope);
      await acceptNative(request);
      assert.match(await row.locator(".meta").innerText(), /Selected-scope override: None/);
      assert.equal(await page.evaluate(() => document.activeElement.id), `native-mcp-0-${key}`);
      await cleanRow(row);
    }
  }

  // MCP drafts bind to the whole opaque file revision, even when safe metadata stays equal.
  const exposureRow = page.locator('[data-server] [data-native-key="exposure"]');
  const mcpWritesBefore = writeCount();
  await field(exposureRow).selectOption("direct");
  nativeRevision++;
  await refresh();
  assert.equal(await field(exposureRow).inputValue(), "direct");
  assert.equal(await saveButton(exposureRow).isDisabled(), true);
  await openActions(exposureRow);
  assert.equal(await exposureRow.locator('button[id$="-reset"]').isDisabled(), true);
  await page.keyboard.press("Escape");
  await reloadRow(exposureRow, true);
  await field(exposureRow).selectOption("hidden");
  await selectNativeScope("project");
  nativeRevision++;
  await selectNativeScope("global");
  assert.equal(await field(exposureRow).inputValue(), "hidden");
  assert.equal(await saveButton(exposureRow).isDisabled(), true);
  await reloadRow(exposureRow, true);
  assert.equal(await field(exposureRow).inputValue(), "codemode");
  assert.equal(writeCount(), mcpWritesBefore);

  // Unsolicited and missing-ID projections cannot replace the loaded scope.
  await send(nativeProjection({ scope: "project", id: "unsolicited" }));
  await send({ ...nativeProjection({ scope: "project", id: "unsolicited" }), id: undefined });
  assert.equal(await page.locator("#native-scope").inputValue(), "global");
  // A page refresh retains unrelated drafts and only changed rows require recovery.
  await field(providerRow).fill("unrelated-provider-draft");
  await field(modelRow).fill("local-model-draft");
  nativeOverrides.global.defaultModel = "external-model";
  nativeRevision++;
  await refresh();
  assert.equal(await field(providerRow).inputValue(), "unrelated-provider-draft");
  assert.equal(await saveButton(providerRow).isDisabled(), false);
  assert.equal(await recoverButton(providerRow).isVisible(), false);
  assert.equal(await field(modelRow).inputValue(), "local-model-draft");
  assert.equal(await saveButton(modelRow).isVisible(), true);
  assert.equal(await saveButton(modelRow).isDisabled(), true);
  assert.match(await modelRow.innerText(), /Draft retained/);
  await reloadRow(modelRow, true);
  assert.equal(await field(modelRow).inputValue(), "external-model");
  assert.equal(await field(providerRow).inputValue(), "unrelated-provider-draft");
  await cleanRow(modelRow);
  // Native values are inert text, never HTML or external requests.
  nativeOverrides.global.defaultModel = '<img src="https://invalid.example/attack" onerror="window.injected=true">';
  nativeRevision++;
  await refresh();
  assert.equal(await field(modelRow).inputValue(), nativeOverrides.global.defaultModel);
  assert.equal(await page.locator("img").count(), 0);
  delete nativeOverrides.global.defaultModel;
  nativeRevision++;
  await refresh();

  // Non-conflict failures permit retry with the same value and current revision.
  await field(providerRow).fill("unsaved-global");
  after = messages.length - 1;
  await saveButton(providerRow).click();
  let failedNative = await waitMessage("nativeSave", after);
  await send({
    type: "nativeResult",
    id: failedNative.id,
    ok: false,
    error: "Native configuration is unavailable. Try again.",
  });
  assert.equal(await field(providerRow).inputValue(), "unsaved-global");
  assert.equal(await saveButton(providerRow).isVisible(), true);
  assert.equal(await saveButton(providerRow).isDisabled(), false);
  assert.equal(await recoverButton(providerRow).isVisible(), false);
  assert.match(await providerRow.innerText(), /unavailable/);
  await selectNativeScope("project");
  await field(providerRow).fill("unsaved-project");
  await selectNativeScope("global");
  assert.equal(await field(providerRow).inputValue(), "unsaved-global");
  after = messages.length - 1;
  await saveButton(providerRow).click();
  const retryNative = await waitMessage("nativeSave", after);
  assertGuard(retryNative);
  assert.notEqual(retryNative.id, failedNative.id);
  assert.equal(retryNative.value, failedNative.value);
  assert.equal(retryNative.scope, failedNative.scope);
  await acceptNative(retryNative);
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider");
  await cleanRow(providerRow);
  await field(providerRow).fill("stale-global");
  after = messages.length - 1;
  await saveButton(providerRow).click();
  failedNative = await waitMessage("nativeSave", after);
  await send({
    type: "nativeResult",
    id: failedNative.id,
    ok: false,
    error: "Native configuration changed. Reload this row.",
  });
  assert.equal(await saveButton(providerRow).isDisabled(), true);
  assert.match(await providerRow.innerText(), /Draft retained/);
  await reloadRow(providerRow, true);
  assert.equal(await field(providerRow).inputValue(), "unsaved-global");
  await cleanRow(providerRow);

  // Replaced loads and saves cannot change scope or leave a pending row.
  await field(providerRow).fill("superseded-draft");
  after = messages.length - 1;
  await saveButton(providerRow).click();
  const lateSave = await waitMessage("nativeSave", after);
  after = messages.length - 1;
  await page.locator("#native-scope").selectOption("project");
  const lateLoad = await waitMessage("nativeLoad", after);
  after = messages.length - 1;
  await page.locator("#native-scope").selectOption("global");
  await loadNative(after);
  await send(nativeProjection(lateLoad));
  await send({ type: "nativeResult", id: lateLoad.id, ok: true });
  await send(nativeProjection(lateSave));
  await send({ type: "nativeResult", id: lateSave.id, ok: true });
  assert.equal(await page.locator("#native-scope").inputValue(), "global");
  assert.equal(await field(providerRow).isDisabled(), false);
  assert.equal(await field(providerRow).inputValue(), "superseded-draft");
  assert.equal(await saveButton(providerRow).isDisabled(), true);
  // Pi Configuration is always active: invalidation reloads immediately, without category toggles.
  after = messages.length - 1;
  await send({ type: "nativeInvalidated" });
  await loadNative(after);
  assert.equal(await saveButton(providerRow).isDisabled(), true);
  await reloadRow(providerRow, true);
  // Load failures need an explicit reload and never start an automatic retry loop.
  after = messages.length - 1;
  await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
  const failedLoad = await waitMessage("nativeLoad", after);
  await send({ type: "nativeResult", id: failedLoad.id, ok: false, error: "Native configuration is unavailable." });
  assert.match(await page.locator("main").innerText(), /unavailable/);
  assert.equal(await page.locator("[data-native-key]").count(), 0);
  const loadCount = messages.filter((message) => message.type === "nativeLoad").length;
  await page.waitForTimeout(50);
  assert.equal(messages.filter((message) => message.type === "nativeLoad").length, loadCount);
  await refresh();

  // Common drafts and scope recover; MCP, native projections and secrets never persist.
  await selectNativeScope("project");
  await field(providerRow).fill("restored-project-draft");
  await details.locator("summary").click();
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  assert.equal(await page.locator("#native-scope").inputValue(), "project");
  assert.equal(await field(providerRow).inputValue(), "restored-project-draft");
  assert.equal(await details.evaluate((node) => node.open), true);
  await selectNativeScope("global");
  await field(providerRow).fill("restored-common-draft");
  await field(exposureRow).selectOption("hidden");
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureState")));
  assert.equal(recovered.native.drafts["global:defaultProvider"].raw, "restored-common-draft");
  assert.ok(Object.keys(recovered.native.drafts).every((key) => !key.includes("mcp:")));
  assert.ok(Object.keys(recovered).every((key) => ["native", "detailsOpen"].includes(key)));
  assert.doesNotMatch(
    JSON.stringify(recovered),
    /UNKNOWN_NATIVE_CANARY|TRANSPORT_CANARY|AUTH_CANARY|nativeSnapshot|revision/,
  );
  assert.doesNotMatch(await page.locator("main").innerText(), /UNKNOWN_NATIVE_CANARY|TRANSPORT_CANARY|AUTH_CANARY/);
  const writesBeforeRestore = writeCount();
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  assert.equal(await field(providerRow).inputValue(), "restored-common-draft");
  assert.equal(await field(exposureRow).inputValue(), "codemode");
  assert.equal(writeCount(), writesBeforeRestore);
  assert.equal(await saveButton(providerRow).isDisabled(), false);
  nativeOrigin = "b".repeat(64);
  await refresh();
  assert.equal(await field(providerRow).inputValue(), "restored-common-draft");
  assert.equal(await saveButton(providerRow).isDisabled(), true);

  // Legacy category, target and pi.* drafts are ignored; valid bounded native drafts survive migration.
  const previousNative = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fixtureState"));
    const changed = structuredClone(state);
    changed.category = "Pi Files";
    changed.target = "workspace";
    changed.drafts = { "workspace:provider": { raw: "LEGACY_RECOVERY_CANARY", base: "legacy" } };
    changed.native.drafts["global:unknown"] = { raw: "UNKNOWN_RECOVERY_CANARY", base: "12345678", origin: "origin" };
    changed.native.drafts["global:defaultModel"] = { raw: "x".repeat(257), base: "12345678", origin: "origin" };
    changed.native.drafts["global:defaultProvider"].unknown = "UNKNOWN_RECOVERY_CANARY";
    localStorage.setItem("fixtureState", JSON.stringify(changed));
    return state.native;
  });
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  await details.locator("summary").click();
  const restoredState = await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureState")));
  assert.deepEqual(restoredState.native, previousNative);
  assert.ok(Object.keys(restoredState).every((key) => ["native", "detailsOpen"].includes(key)));
  assert.doesNotMatch(JSON.stringify(restoredState), /UNKNOWN_RECOVERY_CANARY|LEGACY_RECOVERY_CANARY/);
  assert.equal(await page.locator("nav,#target,[data-key]").count(), 0);
  assert.equal(writeCount(), writesBeforeRestore);
  // Legacy-only recovery must not replay a VS Code configuration save or select a category.
  const nativeState = restoredState.native;
  await page.evaluate(() =>
    localStorage.setItem(
      "fixtureState",
      JSON.stringify({
        category: "Editor",
        target: "workspace",
        drafts: { "workspace:provider": { raw: "LEGACY_ONLY_CANARY", base: "legacy" } },
      }),
    ),
  );
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  assert.equal(await page.locator("#native-scope").inputValue(), "global");
  assert.equal(await field(providerRow).inputValue(), "unsaved-global");
  assert.equal(writeCount(), writesBeforeRestore);
  await page.evaluate((native) => localStorage.setItem("fixtureState", JSON.stringify({ native })), nativeState);
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);

  // Labelled fields and Save remain keyboard accessible; acknowledgement focuses the field.
  await reloadRow(providerRow, true);
  await field(providerRow).focus();
  await page.keyboard.type("keyboard-draft");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider-save");
  after = messages.length - 1;
  await page.keyboard.press("Enter");
  await acceptNative(await waitMessage("nativeSave", after));
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider");
  await cleanRow(providerRow);

  // Two individually valid lists exceed recovery bounds but remain editable in memory.
  const largePatterns = Array.from(
    { length: 100 },
    (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(253)}`,
  ).join("\n");
  const beforeLargeDrafts = writeCount();
  await field(nativeRow("enabledModels")).fill(largePatterns);
  let boundedState = await page.evaluate(() => localStorage.getItem("fixtureState"));
  assert.ok(JSON.parse(boundedState).native.drafts["global:enabledModels"]);
  await selectNativeScope("project");
  await field(nativeRow("enabledModels")).fill(largePatterns);
  assert.match(await page.locator("#status").innerText(), /28 KiB recovery limit.*will not be restored/);
  boundedState = await page.evaluate(() => localStorage.getItem("fixtureState"));
  assert.ok(Buffer.byteLength(boundedState) <= 32 * 1024);
  assert.deepEqual(JSON.parse(boundedState).native.drafts, {});
  await push();
  assert.match(await page.locator("#status").innerText(), /28 KiB recovery limit/);
  await selectNativeScope("global");
  assert.equal(await field(nativeRow("enabledModels")).inputValue(), largePatterns);
  await field(nativeRow("enabledModels")).fill("global/*");
  assert.doesNotMatch(await page.locator("#status").innerText(), /exceed/);
  await selectNativeScope("project");
  await field(nativeRow("enabledModels")).fill("project/*");
  await selectNativeScope("global");
  assert.equal(writeCount(), beforeLargeDrafts);

  // Availability gates every native action, but leaves the native Settings route available.
  snapshot.nativeFilesAvailable = false;
  await push();
  for (const button of await page.locator("main button").all()) assert.equal(await button.isDisabled(), true);
  assert.equal(await page.locator("#native-scope").isDisabled(), true);
  assert.equal(await page.locator("#native-settings").isDisabled(), false);
  assert.match(await page.locator("main").innerText(), /trusted, file-backed workspace/);
  after = messages.length - 1;
  await page.locator("#native-settings").click();
  assert.deepEqual(await waitMessage("openNative", after), { type: "openNative" });
  after = messages.length - 1;
  snapshot.nativeFilesAvailable = true;
  await push();
  await loadNative(after);
  assert.equal(await saveButton(nativeRow("enabledModels")).isDisabled(), true);
  await reloadRow(nativeRow("enabledModels"), true);
  await reloadRow(providerRow);

  // Theme tokens, reduced motion and open menus must fit narrow and wide viewports.
  const layoutWrites = writeCount();
  for (const theme of ["light", "dark", "high-contrast"]) {
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
      reducedMotion: "reduce",
      forcedColors: theme === "high-contrast" ? "active" : "none",
    });
    for (const width of [280, 400, 650, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      for (const expanded of [false, true]) {
        if (expanded) await openActions(providerRow);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${theme} ${width} menu=${expanded}: overflow`,
        );
        assert.equal(await summary(providerRow).isVisible(), true);
        if (expanded) await page.keyboard.press("Escape");
      }
    }
  }
  assert.equal(writeCount(), layoutWrites, "Layout and actions-menu checks never write files");
  // Real CSP rejects inline scripts and network requests.
  await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.injected=true";
    document.body.append(script);
    await fetch("https://invalid.example/blocked").catch(() => {});
  });
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.ok(!requests.some((url) => url.includes("invalid.example")));
  assert.equal(
    messages.filter((message) => ["save", "reset"].includes(message.type)).length,
    0,
    "The Pi panel never writes VS Code configuration",
  );
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    "Settings browser: Pi-only shell/native route, eight fields at both scopes, MCP, explicit Save/reset, menu keyboard/dismissal, focus, immediate invalidation, failures, superseded replies, conflicts, recovery migration/bounds, 24 layouts/themes, CSP and teardown passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
