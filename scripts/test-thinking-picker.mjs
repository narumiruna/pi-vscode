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
    window.acquireVsCodeApi = () => ({ postMessage() {} });
  });
  const html = getSidebarHtml(100000, 5000000).replace(
    "body { margin: 0;",
    "body { --vscode-font-family: Arial; --vscode-font-size: 13px; margin: 0;",
  );
  await page.setContent(html);
  for (const width of [180, 200, 210, 220, 280, 400, 600, 960]) {
    await page.setViewportSize({ width, height: 800 });
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max", null]) {
      await page.evaluate((thinkingLevel) => {
        window.dispatchEvent(
          new MessageEvent("message", {
            data: {
              type: "state",
              runtime: {
                connected: true,
                busy: false,
                model: { name: "A long model name that must shrink" },
                thinkingLevel,
                availableThinkingLevels:
                  thinkingLevel === null ? [] : ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
              },
            },
          }),
        );
      }, level);
      const geometry = await page.evaluate(() => {
        const box = document.querySelector(".composer-box").getBoundingClientRect();
        const send = document.querySelector("#send").getBoundingClientRect();
        const wrapper = document.querySelector(".thinking-picker").getBoundingClientRect();
        const select = document.querySelector("#thinking-level");
        const picker = select.getBoundingClientRect();
        return {
          boxRight: box.right,
          sendRight: send.right,
          sendWidth: send.width,
          wrapperWidth: wrapper.width,
          pickerWidth: picker.width,
          disabled: select.disabled,
          label: select.getAttribute("aria-label"),
        };
      });
      const context = JSON.stringify({ width, level, geometry });
      assert.ok(geometry.sendRight <= geometry.boxRight - 1, context);
      assert.equal(geometry.sendWidth, 30, context);
      assert.ok(geometry.pickerWidth <= geometry.wrapperWidth + 0.5, context);
      assert.equal(geometry.disabled, level === null, context);
      assert.equal(geometry.label, "Pi thinking level", context);
    }
  }
  assert.deepEqual(errors, []);
  console.log("Thinking picker: 64 browser layout cases passed.");
} finally {
  await browser.close();
}
