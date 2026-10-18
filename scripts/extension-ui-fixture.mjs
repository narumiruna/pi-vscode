import assert from "node:assert/strict";
import { createRequire } from "node:module";
import requests from "./fixtures/extension-ui.cjs";

const require = createRequire(import.meta.url);
const { SidebarExtensionUi } = require("../out/sidebarExtensionUi.js");

export async function assertExtensionUi(browser, getSidebarHtml) {
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  await post({ type: "showSessionDetail" });
  const ui = new SidebarExtensionUi();
  for (const request of requests) ui.update(request);
  const state = (extensionUi = ui.state, queued = false) =>
    post({
      type: "state",
      status: "Pi is working…",
      extensionUi,
      runtime: {
        connected: true,
        busy: true,
        cancellable: true,
        queueable: true,
        ...(queued
          ? {
              pendingQueue: {
                steering: [{ id: "next", text: "Next native instruction", kind: "steering" }],
                followUp: [{ id: "later", text: "After this native instruction", kind: "followUp" }],
              },
            }
          : {}),
      },
    });
  await state();
  assert.deepEqual(await page.locator("#extension-ui-above > p").allTextContents(), [
    "second: Updated status",
    "first: First status",
    "above",
    "empty",
  ]);
  assert.ok((await page.locator("#extension-ui-above pre").first().textContent()).includes("Visible text"));
  assert.equal(
    await page.locator(".extension-ui-block script, .extension-ui-block a, .extension-ui-block img").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.extensionInjected), undefined);
  assert.equal(await page.locator("#extension-ui-below > p").textContent(), "below");
  assert.equal((await page.locator("#extension-ui-above").textContent()).includes("Must be removed"), false);
  // The scroll regions participate in DOM/keyboard order around the editor.
  await page.locator("#extension-ui-above").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "input");
  await page.locator("#input").fill("A draft");
  await page.locator("#send").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.evaluate(() => document.activeElement.id), "extension-ui-below");
  let layouts = 0;
  for (const theme of ["vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate((theme) => {
      document.body.className = theme;
    }, theme);
    for (const width of [169, 180, 220, 280, 600, 960]) {
      for (const height of [358, 420, 800]) {
        for (const queued of [false, true]) {
          await page.setViewportSize({ width, height });
          await state(ui.state, queued);
          await post({
            type: "notice",
            level: "warning",
            message: "Queued delivery is uncertain. Check history before resending.",
          });
          await page.locator("#input").fill("Draft\n".repeat(12));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          for (const id of [
            "input",
            "add-context",
            "cancel",
            "after-this",
            "send",
            "notice",
            "status",
            "extension-ui-above",
            "extension-ui-below",
          ]) {
            assert.equal(
              await page.locator(`#${id}`).evaluate((element) => {
                const rect = element.getBoundingClientRect();
                const composer = element.closest(".composer-box")?.getBoundingClientRect();
                return (
                  rect.width > 0 &&
                  rect.height > 0 &&
                  rect.top >= 0 &&
                  rect.left >= 0 &&
                  rect.right <= innerWidth &&
                  rect.bottom <= innerHeight &&
                  (!composer || (rect.top >= composer.top && rect.bottom <= composer.bottom))
                );
              }),
              true,
              `${theme} ${width}x${height} queued=${queued} ${id} must remain visible: ${JSON.stringify(await page.locator(`#${id}`).evaluate((element) => ({ rect: element.getBoundingClientRect().toJSON(), composer: element.closest(".composer-box")?.getBoundingClientRect().toJSON() })))}`,
            );
          }
          const order = await page.evaluate(() => {
            const above = document.getElementById("extension-ui-above").getBoundingClientRect();
            const box = document.querySelector(".composer-box").getBoundingClientRect();
            const below = document.getElementById("extension-ui-below").getBoundingClientRect();
            return above.bottom <= box.top && box.bottom <= below.top;
          });
          assert.equal(order, true, "widgets must not overlap the composer");
          assert.match(await page.locator("#notice").textContent(), /Queued delivery is uncertain/);
          layouts++;
        }
      }
    }
  }
  await state({ statuses: [], widgets: [] });
  assert.equal(await page.locator("#extension-ui-above").isVisible(), false);
  assert.equal(await page.locator("#extension-ui-below").isVisible(), false);
  assert.deepEqual(errors, []);
  await page.close();
  return {
    layouts,
    keyedOrder: "passed",
    textSafety: "passed",
    keyboard: "passed",
    warningAndStop: "passed",
    clearing: "passed",
  };
}
