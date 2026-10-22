import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { getSettingsHtml } = require("../out/settingsHtml.js");
const { settingsDescriptors } = require("../out/settingsModel.js");
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
  const snapshot = {
    type: "snapshot",
    revision: 1,
    workspace: true,
    trusted: true,
    nativeFilesAvailable: true,
    remote: false,
    entries: settingsDescriptors.map((item) => ({
      key: item.key,
      defaultValue: item.default,
      effective: item.default,
    })),
  };
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
  const push = async () =>
    page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), snapshot);
  const row = (key) => page.locator(`section[data-key="${key}"]`);
  const lastRequest = async () => {
    await page.waitForFunction(() => document.querySelector(".row-status")?.textContent !== undefined);
    for (let i = 0; i < 50; i++) {
      const message = messages.at(-1);
      if (["save", "reset"].includes(message?.type)) return message;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error("Settings request missing");
  };
  const accept = async (message) => {
    const entry = snapshot.entries.find((entry) => entry.key === message.key);
    if (message.type === "reset") delete entry[message.target];
    else entry[message.target] = message.value;
    entry.effective = entry.workspace ?? entry.user ?? entry.defaultValue;
    snapshot.revision++;
    await push();
    await page.evaluate(
      (id) => window.dispatchEvent(new MessageEvent("message", { data: { type: "result", id, ok: true } })),
      message.id,
    );
  };
  const send = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const waitMessage = async (type, after = -1) => {
    for (let i = 0; i < 100; i++) {
      const result = messages.slice(after + 1).findLast((message) => message.type === type);
      if (result) return result;
      await page.waitForTimeout(10);
    }
    throw new Error(`Missing ${type} request`);
  };
  const nativeRow = (key) => page.locator(`section[data-native-key="${key}"]`);
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
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("nav button") !== null);
  assert.match(await page.locator("body").innerText(), /General, Permissions, and Editor edit VS Code pi\.\* settings/);
  assert.match(await page.locator("body").innerText(), /Pi Configuration/);
  assert.match(await page.locator("body").innerText(), /Opening this page starts no Pi process or connection/);
  assert.doesNotMatch(await page.locator("body").innerText(), /Pi Files/);
  await push();
  assert.equal(await page.locator("section").count(), 4);
  assert.match(await page.locator("main").innerText(), /Used when a Pi process starts; running sessions are unchanged/);
  const runtime = row("executablePath");
  assert.equal(await runtime.locator("input").inputValue(), "");
  assert.match(await runtime.innerText(), /Empty uses packaged Pi 1\.3\.0/);
  await runtime.locator("input").fill("pi");
  await runtime.getByRole("button", { name: "Save", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await runtime.locator("input").inputValue(), "pi");
  await page.locator("#target").selectOption("workspace");
  await runtime.locator("input").fill("   ");
  await runtime.getByRole("button", { name: "Save", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await runtime.locator("input").inputValue(), "   ");
  await runtime.getByRole("button", { name: "Reset", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await runtime.locator("input").inputValue(), "pi");
  await page.locator("#target").selectOption("user");
  await runtime.getByRole("button", { name: "Reset", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await runtime.locator("input").inputValue(), "");
  await row("model").locator("input").fill("test-model");
  await row("model").getByRole("button", { name: "Save", exact: true }).click();
  const first = await lastRequest();
  assert.equal(first.target, "user");
  assert.equal(first.value, "test-model");
  assert.equal(await row("model").locator("input").isDisabled(), true);
  await accept(first);
  assert.match(await row("model").innerText(), /Saved/);
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "user:model-save",
    "Save acknowledgement preserves keyboard focus",
  );
  await page.locator("#target").selectOption("workspace");
  await row("model").locator("input").fill("workspace-model");
  await row("model").getByRole("button", { name: "Save", exact: true }).click();
  await accept(await lastRequest());
  await page.locator("#target").selectOption("user");
  assert.equal(await row("model").locator("input").inputValue(), "test-model");
  assert.match(await row("model").locator(".meta").innerText(), /workspace-model/);
  await row("model").getByRole("button", { name: "Reset", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(snapshot.entries.find((entry) => entry.key === "model").workspace, "workspace-model");
  // External changes keep drafts and require an explicit row reload.
  await row("provider").locator("input").fill("unsaved");
  const provider = snapshot.entries.find((entry) => entry.key === "provider");
  provider.user = "external";
  provider.effective = "external";
  snapshot.revision++;
  await push();
  assert.equal(
    await page.evaluate(() => document.activeElement.id),
    "provider",
    "External refresh preserves field focus",
  );
  assert.equal(await row("provider").locator("input").inputValue(), "unsaved");
  assert.equal(await row("provider").getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  assert.match(await row("provider").innerText(), /Draft retained/);
  await row("provider").getByRole("button", { name: "Reload row" }).click();
  assert.equal(await row("provider").locator("input").inputValue(), "external");
  // Values are DOM text, never HTML.
  provider.user = '<img src="https://invalid.example/attack" onerror="window.injected=true">';
  provider.effective = provider.user;
  snapshot.revision++;
  await push();
  assert.equal(await page.locator("img").count(), 0);
  assert.equal(await row("provider").locator("input").inputValue(), provider.user);
  await page.getByRole("button", { name: "Editor", exact: true }).click();
  assert.equal(await page.locator("section").count(), 5);
  const initialState = row("annotations.initialState");
  assert.equal(await initialState.locator("select").inputValue(), "collapsed");
  assert.deepEqual(await initialState.locator("option").allTextContents(), ["collapsed", "expanded"]);
  assert.match(await initialState.innerText(), /VS Code API default/);
  assert.match(await initialState.innerText(), /only new or replaced annotations/);
  await initialState.locator("select").selectOption("expanded");
  const annotationSave = await lastRequest();
  assert.equal(annotationSave.key, "annotations.initialState");
  assert.equal(annotationSave.value, "expanded");
  assert.equal(annotationSave.target, "user");
  await accept(annotationSave);
  assert.equal(await initialState.locator("select").inputValue(), "expanded");
  await page.locator("#target").selectOption("workspace");
  await initialState.locator("select").selectOption("collapsed");
  const annotationWorkspace = await lastRequest();
  assert.equal(annotationWorkspace.target, "workspace");
  await accept(annotationWorkspace);
  await initialState.getByRole("button", { name: "Reset", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await initialState.locator("select").inputValue(), "expanded");
  await page.locator("#target").selectOption("user");
  await initialState.getByRole("button", { name: "Reset", exact: true }).click();
  await accept(await lastRequest());
  assert.equal(await initialState.locator("select").inputValue(), "collapsed");
  await row("inlineCompletions.minimumPrefixLength").locator("input").fill("0");
  await row("inlineCompletions.minimumPrefixLength").getByRole("button", { name: "Save", exact: true }).click();
  assert.equal((await lastRequest()).value, 0);
  await accept(await lastRequest());
  await row("inlineCompletions.debounceMilliseconds").locator("input").fill("99");
  const count = messages.length;
  await row("inlineCompletions.debounceMilliseconds").getByRole("button", { name: "Save", exact: true }).click();
  assert.match(await row("inlineCompletions.debounceMilliseconds").innerText(), /Invalid value/);
  assert.equal(messages.length, count);
  await row("inlineCompletions.excludedLanguages").locator("textarea").fill("");
  await row("inlineCompletions.excludedLanguages").getByRole("button", { name: "Save", exact: true }).click();
  assert.deepEqual((await lastRequest()).value, []);
  await accept(await lastRequest());
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  assert.equal(await page.locator("section").count(), 2);
  snapshot.trusted = false;
  snapshot.revision++;
  await push();
  assert.equal(await row("approveProjectResources").locator("input").isDisabled(), true);
  snapshot.trusted = true;
  snapshot.revision++;
  await push();
  await page.getByRole("button", { name: "General", exact: true }).click();
  await row("thinkingLevel").locator("select").selectOption("high");
  const failedEnum = await lastRequest();
  const executable = snapshot.entries.find((entry) => entry.key === "executablePath");
  executable.user = "other-pi";
  executable.effective = "other-pi";
  snapshot.revision++;
  await push();
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "result", id, ok: false, error: "Settings changed. Try again." } }),
      ),
    failedEnum.id,
  );
  assert.equal(await row("thinkingLevel").locator("select").inputValue(), "high");
  await row("thinkingLevel").getByRole("button", { name: "Retry save", exact: true }).click();
  const enumRetry = await lastRequest();
  assert.notEqual(enumRetry.id, failedEnum.id);
  assert.equal(enumRetry.value, "high");
  assert.equal(enumRetry.target, failedEnum.target);
  assert.equal(enumRetry.revision, snapshot.revision);
  await accept(enumRetry);
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  await row("approveProjectResources").locator("input").check();
  const failed = await lastRequest();
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "result", id, ok: false, error: "Read-only settings" } }),
      ),
    failed.id,
  );
  assert.equal(await row("approveProjectResources").locator("input").isChecked(), true);
  assert.match(await row("approveProjectResources").innerText(), /Read-only settings/);
  assert.equal(await row("approveProjectResources").locator("input").isDisabled(), false);
  await row("approveProjectResources").getByRole("button", { name: "Retry save", exact: true }).click();
  const busyRetry = await lastRequest();
  assert.notEqual(busyRetry.id, failed.id);
  assert.equal(busyRetry.value, true);
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "result", id, ok: false, error: "Settings are busy. Try saving this row again." },
        }),
      ),
    busyRetry.id,
  );
  assert.equal(await row("approveProjectResources").locator("input").isDisabled(), false);
  assert.match(await row("approveProjectResources").innerText(), /busy/);
  await row("approveProjectResources").getByRole("button", { name: "Retry save", exact: true }).click();
  const checkboxRetry = await lastRequest();
  assert.equal(checkboxRetry.value, true);
  assert.equal(checkboxRetry.target, failed.target);
  await accept(checkboxRetry);
  assert.equal(
    await row("approveProjectResources").getByRole("button", { name: "Retry save", exact: true }).count(),
    0,
  );
  assert.ok(
    messages
      .filter((message) => message.type === "save" && message.key === "approveProjectResources")
      .every((message) => message.value === true),
  );
  // A changed value in the same row still requires an explicit reload, not a stale retry.
  await page.getByRole("button", { name: "General", exact: true }).click();
  await row("thinkingLevel").locator("select").selectOption("medium");
  const staleEnum = await lastRequest();
  const thinking = snapshot.entries.find((entry) => entry.key === "thinkingLevel");
  thinking.workspace = "off";
  thinking.effective = "off";
  snapshot.revision++;
  await push();
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "result", id, ok: false, error: "Settings changed." } }),
      ),
    staleEnum.id,
  );
  assert.equal(await row("thinkingLevel").getByRole("button", { name: "Retry save", exact: true }).isDisabled(), true);
  await row("thinkingLevel").getByRole("button", { name: "Reload row", exact: true }).click();
  await page.getByRole("button", { name: "Permissions", exact: true }).click();
  // Recreate the document as VS Code can do after hiding a non-retained webview.
  await row("sensitiveContextNames").locator("textarea").fill("draft-secret");
  await page.reload();
  await push();
  assert.equal(await row("sensitiveContextNames").locator("textarea").inputValue(), "draft-secret");
  assert.equal(
    await page.getByRole("button", { name: "Permissions", exact: true }).getAttribute("aria-pressed"),
    "true",
  );
  assert.equal(
    messages.filter((message) => message.type === "nativeLoad").length,
    0,
    "Unrelated categories never load native files",
  );
  // Native controls remain keyboard accessible.
  await page.getByRole("button", { name: "General", exact: true }).focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.getByRole("button", { name: "General", exact: true }).getAttribute("aria-pressed"), "true");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.textContent), "Permissions");
  for (const theme of ["light", "dark", "high-contrast"]) {
    await page.emulateMedia({
      colorScheme: theme === "light" ? "light" : "dark",
      reducedMotion: "reduce",
      forcedColors: theme === "high-contrast" ? "active" : "none",
    });
    for (const width of [280, 400, 650, 1100]) {
      await page.setViewportSize({ width, height: 800 });
      for (const category of ["General", "Pi Configuration"]) {
        const before = messages.length - 1;
        await page.getByRole("button", { name: category, exact: true }).click();
        if (category === "Pi Configuration") await loadNative(before);
        assert.ok(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          `${category} ${theme} ${width}: overflow`,
        );
      }
    }
  }
  assert.equal(await page.locator("#target").isDisabled(), true);
  assert.match(await page.locator("#scope-note").innerText(), /Global Pi or Project Pi/);
  assert.match(await page.locator("main").innerText(), /~\/\.pi\/agent\/settings\.json/);
  assert.match(await page.locator("main").innerText(), /\.pi\/settings\.json/);
  assert.equal(await page.locator("[data-native-key]").count(), 10);
  assert.equal(writeCount(), 0, "Loading, layout checks, and scope changes never write native files");
  const selectNativeScope = async (scope) => {
    const before = messages.length - 1;
    await page.locator("#native-scope").selectOption(scope);
    await loadNative(before);
  };
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
  const editNative = async (control, value) => {
    const field = control.locator("input,select,textarea");
    if (typeof value === "boolean") await field.setChecked(value);
    else if (await field.evaluate((element) => element.tagName === "SELECT")) await field.selectOption(value);
    else await field.fill(Array.isArray(value) ? value.join("\n") : value);
  };
  // Every native control uses explicit Save at both scopes, including checkboxes and selects.
  for (const scope of ["global", "project"]) {
    if (scope !== "global") await selectNativeScope(scope);
    if (scope === "project") assert.match(await page.locator("main").innerText(), /Project overrides remain inactive/);
    for (const descriptor of nativeSettingControls) {
      const control = nativeRow(descriptor.key);
      assert.equal(await control.locator("label").getAttribute("for"), `native-${descriptor.key}`);
      const before = writeCount();
      // Project inherits the Global value; choose a different project value where possible.
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
      await editNative(control, value);
      assert.equal(writeCount(), before, `${descriptor.key}: editing alone must not save`);
      const after = messages.length - 1;
      await control.getByRole("button", { name: "Save", exact: true }).click();
      const request = await waitMessage("nativeSave", after);
      assert.equal(request.scope, scope);
      assert.equal(request.key, descriptor.key);
      assert.equal(request.server, undefined);
      assert.deepEqual(request.value, value);
      assert.ok(request.id.length <= 80 && /^[a-zA-Z0-9_-]+$/.test(request.id));
      assert.equal(await control.locator("input,select,textarea").isDisabled(), true);
      await acceptNative(request);
      assert.match(await control.innerText(), /Saved/);
      assert.equal(await page.evaluate(() => document.activeElement.id), `native-${descriptor.key}-save`);
      assert.match(await control.locator(".meta").innerText(), /Selected-scope override:/);
    }
    for (const [kind, name] of [
      ["settings", "Native settings management"],
      ["mcp", "Native MCP management"],
    ]) {
      const after = messages.length - 1;
      await page.getByRole("button", { name, exact: true }).click();
      assert.deepEqual(await waitMessage("openPiFile", after), { type: "openPiFile", kind, scope });
    }
    const server = page.locator('[data-server="fixture-server"]');
    assert.match(await server.innerText(), /Transport: stdio.*Source: global.*Connection: unknown/s);
    for (const key of ["enabled", "exposure"]) {
      const control = server.locator(`[data-native-key="${key}"]`);
      const value = key === "enabled" ? scope === "project" : scope === "global" ? "direct" : "hidden";
      const before = writeCount();
      await editNative(control, value);
      assert.equal(writeCount(), before, "MCP drafts do not auto-save");
      if (key === "exposure") assert.deepEqual(await control.locator("option").allTextContents(), mcpExposures);
      const after = messages.length - 1;
      await control.getByRole("button", { name: "Save", exact: true }).click();
      const request = await waitMessage("nativeSave", after);
      assert.equal(request.server, "fixture-server");
      assert.equal(request.scope, scope);
      assert.equal(request.key, key);
      assert.equal(request.value, value);
      await acceptNative(request);
    }
  }
  // Reset removes only the selected scope, then exposes the inherited/default value.
  for (const scope of ["project", "global"]) {
    await selectNativeScope(scope);
    for (const descriptor of nativeSettingControls) {
      const control = nativeRow(descriptor.key);
      const after = messages.length - 1;
      await control.getByRole("button", { name: "Reset override", exact: true }).focus();
      await page.keyboard.press("Enter");
      const request = await waitMessage("nativeReset", after);
      assert.equal(request.scope, scope);
      assert.ok(!Object.hasOwn(request, "value"));
      await acceptNative(request);
      assert.match(await control.locator(".meta").innerText(), /Selected-scope override: None/);
      assert.equal(await control.getByRole("button", { name: "Reset override", exact: true }).isDisabled(), true);
      assert.equal(
        await page.evaluate(() => document.activeElement.id),
        `native-${descriptor.key}`,
        "Reset returns focus to its field when the override no longer exists",
      );
      if (scope === "project") assert.deepEqual(nativeOverrides.global[descriptor.key], values[descriptor.key]);
    }
    for (const key of ["enabled", "exposure"]) {
      const control = page.locator(`[data-server] [data-native-key="${key}"]`);
      const after = messages.length - 1;
      await control.getByRole("button", { name: "Reset override", exact: true }).click();
      const request = await waitMessage("nativeReset", after);
      assert.equal(request.server, "fixture-server");
      await acceptNative(request);
      assert.match(await control.locator(".meta").innerText(), /Selected-scope override: None/);
      assert.equal(await page.evaluate(() => document.activeElement.id), `native-mcp-0-${key}`);
    }
  }
  // MCP drafts bind to the whole opaque file revision, not only visible metadata.
  const exposureRow = page.locator('[data-server] [data-native-key="exposure"]');
  const mcpWritesBefore = writeCount();
  await exposureRow.locator("select").selectOption("direct");
  await page.getByRole("button", { name: "General", exact: true }).click();
  // A host revision changes after a same-name transport/credential replacement; safe metadata stays equal.
  nativeRevision++;
  let mcpAfter = messages.length - 1;
  await page.getByRole("button", { name: "Pi Configuration", exact: true }).click();
  await loadNative(mcpAfter);
  assert.equal(await exposureRow.locator("select").inputValue(), "direct");
  assert.equal(await exposureRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  mcpAfter = messages.length - 1;
  await exposureRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(mcpAfter);
  await exposureRow.locator("select").selectOption("hidden");
  await selectNativeScope("project");
  nativeRevision++;
  await selectNativeScope("global");
  assert.equal(await exposureRow.locator("select").inputValue(), "hidden");
  assert.equal(await exposureRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  mcpAfter = messages.length - 1;
  await exposureRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(mcpAfter);
  assert.equal(await exposureRow.locator("select").inputValue(), "codemode");
  assert.equal(writeCount(), mcpWritesBefore);
  const providerRow = nativeRow("defaultProvider");
  // Unsolicited and missing-ID projections cannot replace the loaded scope.
  await send({ ...nativeProjection({ scope: "project", id: "unsolicited" }), id: undefined });
  assert.equal(await page.locator("#native-scope").inputValue(), "global");
  const modelRow = nativeRow("defaultModel");
  await modelRow.locator("input").fill("local-model-draft");
  nativeOverrides.global.defaultModel = "external-model";
  nativeRevision++;
  let refreshAfter = messages.length - 1;
  await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
  await loadNative(refreshAfter);
  assert.equal(await modelRow.locator("input").inputValue(), "local-model-draft");
  assert.equal(await modelRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  refreshAfter = messages.length - 1;
  await modelRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(refreshAfter);
  assert.equal(await modelRow.locator("input").inputValue(), "external-model");
  await providerRow.locator("input").fill("unsaved-global");
  let after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Save", exact: true }).click();
  let failedNative = await waitMessage("nativeSave", after);
  await send({
    type: "nativeResult",
    id: failedNative.id,
    ok: false,
    error: "Native configuration is unavailable. Try again.",
  });
  assert.equal(await providerRow.locator("input").inputValue(), "unsaved-global");
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), false);
  assert.match(await providerRow.innerText(), /unavailable/);
  await selectNativeScope("project");
  await providerRow.locator("input").fill("unsaved-project");
  await selectNativeScope("global");
  assert.equal(await providerRow.locator("input").inputValue(), "unsaved-global");
  after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Save", exact: true }).click();
  failedNative = await waitMessage("nativeSave", after);
  await send({
    type: "nativeResult",
    id: failedNative.id,
    ok: false,
    error: "Native configuration changed. Reload this row.",
  });
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  assert.match(await providerRow.innerText(), /Draft retained/);
  after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(after);
  assert.equal(await providerRow.locator("input").inputValue(), "");
  // A replaced load or save must not change the selected scope or leave a row pending.
  await providerRow.locator("input").fill("superseded-draft");
  after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Save", exact: true }).click();
  const lateSave = await waitMessage("nativeSave", after);
  after = messages.length - 1;
  await page.locator("#native-scope").selectOption("project");
  const lateLoad = await waitMessage("nativeLoad", after);
  after = messages.length - 1;
  await page.locator("#native-scope").selectOption("global");
  await loadNative(after);
  await send(nativeProjection(lateLoad));
  await send(nativeProjection(lateSave));
  await send({ type: "nativeResult", id: lateSave.id, ok: true });
  assert.equal(await page.locator("#native-scope").inputValue(), "global");
  assert.equal(await providerRow.locator("input").isDisabled(), false);
  assert.equal(await providerRow.locator("input").inputValue(), "superseded-draft");
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  // Invalidation while another category is selected is lazy and retains draft conflict state.
  await page.getByRole("button", { name: "General", exact: true }).click();
  const loadCount = messages.filter((message) => message.type === "nativeLoad").length;
  await send({ type: "nativeInvalidated" });
  assert.equal(messages.filter((message) => message.type === "nativeLoad").length, loadCount);
  after = messages.length - 1;
  await page.getByRole("button", { name: "Pi Configuration", exact: true }).click();
  await loadNative(after);
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(after);
  // Native load failure recovers through an explicit reload, not an automatic retry loop.
  after = messages.length - 1;
  await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
  const failedLoad = await waitMessage("nativeLoad", after);
  await send({ type: "nativeResult", id: failedLoad.id, ok: false, error: "Native configuration is unavailable." });
  assert.match(await page.locator("main").innerText(), /unavailable/);
  assert.equal(await page.locator("[data-native-key]").count(), 0);
  after = messages.length - 1;
  await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
  await loadNative(after);
  // Scope and common drafts recover independently of VS Code User/Workspace.
  await selectNativeScope("project");
  await providerRow.locator("input").fill("restored-project-draft");
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  assert.equal(await page.locator("#native-scope").inputValue(), "project");
  assert.equal(await providerRow.locator("input").inputValue(), "restored-project-draft");
  await selectNativeScope("global");
  await providerRow.locator("input").fill("restored-common-draft");
  await page.locator('[data-server] [data-native-key="exposure"] select').selectOption("hidden");
  const recovered = await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureState")));
  assert.equal(recovered.native.drafts["global:defaultProvider"].raw, "restored-common-draft");
  assert.ok(Object.keys(recovered.native.drafts).every((key) => !key.includes("mcp:")));
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
  assert.equal(await providerRow.locator("input").inputValue(), "restored-common-draft");
  assert.equal(await page.locator('[data-server] [data-native-key="exposure"] select').inputValue(), "codemode");
  assert.equal(writeCount(), writesBeforeRestore);
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), false);
  // Origin changes cannot carry an old draft into a new workspace, directory, or approval policy.
  nativeOrigin = "b".repeat(64);
  after = messages.length - 1;
  await page.getByRole("button", { name: "Reload configuration", exact: true }).click();
  await loadNative(after);
  assert.equal(await providerRow.locator("input").inputValue(), "restored-common-draft");
  assert.equal(await providerRow.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  // Keep the old category migration and reject unknown or invalid native recovery data.
  const previousState = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem("fixtureState"));
    const changed = structuredClone(state);
    changed.category = "Pi Files";
    changed.native.drafts["global:unknown"] = { raw: "UNKNOWN_RECOVERY_CANARY", base: "12345678", origin: "origin" };
    changed.native.drafts["global:defaultModel"] = { raw: "x".repeat(257), base: "12345678", origin: "origin" };
    changed.native.drafts["global:defaultProvider"].unknown = "UNKNOWN_RECOVERY_CANARY";
    localStorage.setItem("fixtureState", JSON.stringify(changed));
    return state;
  });
  after = messages.length - 1;
  await page.reload();
  await push();
  await loadNative(after);
  await page.getByRole("button", { name: "Pi Configuration", exact: true }).click();
  const restoredState = await page.evaluate(() => JSON.parse(localStorage.getItem("fixtureState")));
  assert.equal(restoredState.category, "Pi Configuration");
  assert.deepEqual(restoredState.drafts, previousState.drafts);
  assert.doesNotMatch(JSON.stringify(restoredState.native), /UNKNOWN_RECOVERY_CANARY/);
  assert.equal(await page.locator("#target").inputValue(), previousState.target);
  assert.equal(await page.locator("#target").isDisabled(), true);
  assert.doesNotMatch(await page.locator("body").innerText(), /Pi Files/);
  // A labelled field and its explicit Save action are reachable with the keyboard.
  after = messages.length - 1;
  await providerRow.getByRole("button", { name: "Reload row" }).click();
  await loadNative(after);
  await providerRow.locator("input").focus();
  await page.keyboard.type("keyboard-draft");
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "native-defaultProvider-save");
  after = messages.length - 1;
  await page.keyboard.press("Enter");
  await acceptNative(await waitMessage("nativeSave", after));
  // Two individually valid lists exceed the native recovery cap, but remain editable in memory.
  const largePatterns = Array.from(
    { length: 100 },
    (_, index) => `${String(index).padStart(3, "0")}${"x".repeat(253)}`,
  ).join("\n");
  const beforeLargeDrafts = writeCount();
  await nativeRow("enabledModels").locator("textarea").fill(largePatterns);
  let boundedState = await page.evaluate(() => localStorage.getItem("fixtureState"));
  assert.ok(JSON.parse(boundedState).native.drafts["global:enabledModels"]);
  await selectNativeScope("project");
  await nativeRow("enabledModels").locator("textarea").fill(largePatterns);
  assert.match(await page.locator("#status").innerText(), /28 KiB recovery limit.*will not be restored/);
  boundedState = await page.evaluate(() => localStorage.getItem("fixtureState"));
  assert.ok(Buffer.byteLength(boundedState) <= 32 * 1024);
  assert.deepEqual(JSON.parse(boundedState).native.drafts, {});
  snapshot.revision++;
  await push();
  assert.match(await page.locator("#status").innerText(), /28 KiB recovery limit/);
  await selectNativeScope("global");
  assert.equal(await nativeRow("enabledModels").locator("textarea").inputValue(), largePatterns);
  await nativeRow("enabledModels").locator("textarea").fill("global/*");
  assert.doesNotMatch(await page.locator("#status").innerText(), /exceed/);
  await selectNativeScope("project");
  await nativeRow("enabledModels").locator("textarea").fill("project/*");
  await selectNativeScope("global");
  assert.equal(writeCount(), beforeLargeDrafts);
  snapshot.nativeFilesAvailable = false;
  snapshot.revision++;
  await push();
  for (const button of await page.locator("main button").all()) assert.equal(await button.isDisabled(), true);
  assert.match(await page.locator("main").innerText(), /trusted, file-backed workspace/);
  snapshot.nativeFilesAvailable = true;
  snapshot.revision++;
  await push();
  await page.getByRole("button", { name: "General", exact: true }).click();
  assert.equal(await page.locator("#target").isDisabled(), false);
  await page.locator("#target").selectOption("workspace");
  snapshot.workspace = false;
  snapshot.remote = true;
  snapshot.revision++;
  await push();
  assert.equal(await page.locator('#target option[value="workspace"]').isDisabled(), true);
  assert.equal(
    await page.locator("#target").inputValue(),
    "user",
    "Closing the workspace selects User, not an invalid write target",
  );
  assert.match(await page.locator("#scope-note").innerText(), /remote-user/);
  await row("provider").locator("input").fill("x".repeat(33000));
  assert.match(await page.locator("#status").innerText(), /32 KiB recovery limit/);
  snapshot.revision++;
  await push();
  assert.match(await page.locator("#status").innerText(), /32 KiB recovery limit/);
  await row("provider").locator("input").fill("small-draft");
  assert.match(await page.locator("#status").innerText(), /stored by VS Code/);
  // Real CSP rejects inline scripts and network requests.
  await page.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.injected=true";
    document.body.append(script);
    await fetch("https://invalid.example/blocked").catch(() => {});
  });
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.ok(!requests.some((url) => url.includes("invalid.example")));
  await page.getByRole("button", { name: "Open in VS Code Settings" }).click();
  await page.waitForTimeout(50);
  assert.equal(messages.at(-1).type, "openNative");
  assert.deepEqual(errors, []);
  await page.close();
  console.log(
    "Settings browser: General regression, eight native fields at both scopes, MCP, explicit Save/reset, lazy loads, failures, superseded replies, conflicts, recovery, keyboard, 24 layouts/themes, CSP and teardown passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
