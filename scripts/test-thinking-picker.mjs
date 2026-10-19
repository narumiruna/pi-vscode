import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

const require = createRequire(import.meta.url);
const { getSidebarHtml } = require("../out/sidebarHtml.js");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  await post({ type: "showSessionDetail" });
  const modelName = "A long model name that must shrink 日本語 🐈";
  const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  const state = (thinkingLevel, extra = {}) =>
    post({
      type: "state",
      status: "Ready",
      runtime: {
        connected: true,
        busy: false,
        model: { name: modelName, provider: "fixture", id: "long-model" },
        thinkingLevel,
        availableThinkingLevels: thinkingLevel === null ? [] : levels,
        ...extra,
      },
    });
  let layouts = 0;
  for (const theme of ["vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate((theme) => {
      document.body.className = theme;
      const light = theme.endsWith("light");
      const foreground = light ? "#000000" : "#ffffff";
      const background = light ? "#ffffff" : "#000000";
      for (const [key, value] of Object.entries({
        "font-family": "Arial",
        "font-size": "13px",
        foreground,
        descriptionForeground: foreground,
        "sideBar-background": background,
        "input-background": background,
        "input-foreground": foreground,
        "button-background": foreground,
        "button-foreground": background,
        contrastBorder: foreground,
        focusBorder: foreground,
      }))
        document.body.style.setProperty(`--vscode-${key}`, value);
    }, theme);
    for (const width of [159, 180, 200, 210, 220, 280, 400, 600, 960]) {
      for (const height of [344, 358, 800]) {
        await page.setViewportSize({ width, height });
        for (const level of [...levels, null]) {
          await state(level);
          await page.locator("#input").fill("Keep this draft");
          assert.equal(await page.locator("#thinking-level:visible, .thinking-picker:visible").count(), 0);
          const geometry = await page.evaluate(() => {
            const rect = (selector) => document.querySelector(selector).getBoundingClientRect().toJSON();
            const picker = document.querySelector("#model-picker");
            return {
              box: rect(".composer-box"),
              send: rect("#send"),
              picker: rect("#model-picker"),
              attach: rect("#add-context"),
              overflow: document.documentElement.scrollWidth > innerWidth,
              disabled: picker.disabled,
              name: picker.getAttribute("aria-label"),
              title: picker.title,
              labelsInside: ["model-label", "thinking-label"].every((id) =>
                picker.contains(document.getElementById(id)),
              ),
            };
          });
          const context = JSON.stringify({ theme, width, height, level, geometry });
          assert.equal(geometry.overflow, false, context);
          assert.equal(geometry.disabled, false, "a model can still change when thinking is unavailable");
          assert.equal(geometry.labelsInside, true, context);
          assert.ok(geometry.name.includes(modelName), context);
          assert.ok(geometry.title.includes(modelName), context);
          if (level !== null) {
            const label = new RegExp(level === "xhigh" ? "X-high" : level, "i");
            assert.match(geometry.name, label, context);
            assert.match(geometry.title, label, context);
            assert.match(await page.locator("#thinking-label").textContent(), label, context);
          }
          for (const control of [geometry.attach, geometry.picker, geometry.send]) {
            assert.ok(control.left >= geometry.box.left && control.right <= geometry.box.right - 1, context);
            assert.ok(control.top >= geometry.box.top && control.bottom <= geometry.box.bottom, context);
            assert.ok(control.height >= 30, `controls must not shrink to fit: ${context}`);
            assert.ok(control.bottom <= height, context);
          }
          assert.equal(geometry.send.width, 30, context);
          assert.ok(Math.abs(geometry.attach.top - geometry.picker.top) <= 1, context);
          assert.ok(Math.abs(geometry.picker.top - geometry.send.top) <= 1, context);
          assert.ok(
            geometry.attach.right <= geometry.picker.left && geometry.picker.right <= geometry.send.left,
            context,
          );
          layouts++;
        }
      }
    }
  }
  // The button opens only the native action chooser. Cancelling it has no browser side effects.
  await page.setViewportSize({ width: 600, height: 800 });
  await state("high");
  for (const key of ["Enter", "Space"]) {
    await page.locator("#model-picker").focus();
    const before = await page.evaluate(() => window.posted.length);
    await page.keyboard.press(key);
    assert.deepEqual(await page.evaluate((offset) => window.posted.slice(offset), before), [
      { type: "pickComposerSettings" },
    ]);
    assert.equal(await page.locator("#input").inputValue(), "Keep this draft");
    assert.equal(await page.locator("#model-label").textContent(), modelName);
    assert.match(await page.locator("#thinking-label").textContent(), /high/i);
  }
  await state("low");
  assert.match(await page.locator("#thinking-label").textContent(), /low/i);
  assert.equal(await page.locator("#input").inputValue(), "Keep this draft");
  for (const extra of [{ busy: true, cancellable: true }, { connected: false }]) {
    await state("high", extra);
    assert.equal(await page.locator("#model-picker").isDisabled(), true);
    const before = await page.evaluate(() => window.posted.length);
    await page.locator("#model-picker").evaluate((button) => button.click());
    assert.equal(await page.evaluate(() => window.posted.length), before);
    assert.equal(await page.locator("#more").isEnabled(), true);
    assert.equal(await page.locator("#input").inputValue(), "Keep this draft");
  }
  assert.deepEqual(errors, []);
  console.log(`Combined model/thinking picker: ${layouts} browser layout cases and native-chooser routing passed.`);
} finally {
  await browser.close();
}
