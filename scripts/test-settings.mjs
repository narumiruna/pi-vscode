import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { getSettingsHtml } = require("../out/settingsHtml.js");
const { settingsDescriptors } = require("../out/settingsModel.js");
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
  await page.goto(origin);
  await page.waitForFunction(() => document.querySelector("nav button") !== null);
  await push();
  assert.equal(await page.locator("section").count(), 4);
  assert.match(await page.locator("main").innerText(), /Used when a Pi process starts; running sessions are unchanged/);
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
  assert.equal(await page.locator("section").count(), 4);
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
  assert.equal(await page.locator("section").count(), 3);
  snapshot.trusted = false;
  snapshot.revision++;
  await push();
  assert.equal(await row("approveProjectResources").locator("input").isDisabled(), true);
  snapshot.trusted = true;
  snapshot.revision++;
  await push();
  await row("agent.confirmToolCalls").locator("select").selectOption("all");
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
  assert.equal(await row("agent.confirmToolCalls").locator("select").inputValue(), "all");
  await row("agent.confirmToolCalls").getByRole("button", { name: "Retry save", exact: true }).click();
  const enumRetry = await lastRequest();
  assert.notEqual(enumRetry.id, failedEnum.id);
  assert.equal(enumRetry.value, "all");
  assert.equal(enumRetry.target, failedEnum.target);
  assert.equal(enumRetry.revision, snapshot.revision);
  await accept(enumRetry);
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
  await row("agent.confirmToolCalls").locator("select").selectOption("dangerous");
  const staleEnum = await lastRequest();
  const policy = snapshot.entries.find((entry) => entry.key === "agent.confirmToolCalls");
  policy.workspace = "off";
  policy.effective = "off";
  snapshot.revision++;
  await push();
  await page.evaluate(
    (id) =>
      window.dispatchEvent(
        new MessageEvent("message", { data: { type: "result", id, ok: false, error: "Settings changed." } }),
      ),
    staleEnum.id,
  );
  assert.equal(
    await row("agent.confirmToolCalls").getByRole("button", { name: "Retry save", exact: true }).isDisabled(),
    true,
  );
  await row("agent.confirmToolCalls").getByRole("button", { name: "Reload row", exact: true }).click();
  // Recreate the document as VS Code can do after hiding a non-retained webview.
  await row("sensitiveContextNames").locator("textarea").fill("draft-secret");
  await page.reload();
  await push();
  assert.equal(await row("sensitiveContextNames").locator("textarea").inputValue(), "draft-secret");
  assert.equal(
    await page.getByRole("button", { name: "Permissions", exact: true }).getAttribute("aria-pressed"),
    "true",
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
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${theme} ${width}: overflow`,
      );
    }
  }
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
    "Settings browser: controls, scopes, reset, conflicts, drafts, keyboard, 12 layouts/themes, CSP and teardown passed.",
  );
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
