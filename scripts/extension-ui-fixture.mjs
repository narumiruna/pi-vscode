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
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  await post({ type: "showSessionDetail" });
  const ui = new SidebarExtensionUi();
  for (const request of requests) ui.update(request);
  const state = (extensionUi = ui.state, queued = false, runtime = {}) =>
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
        ...runtime,
      },
    });
  await state();
  assert.deepEqual(await page.locator("#extension-ui-above > p").allTextContents(), ["above", "empty"]);
  assert.equal(await page.locator("#extension-status").isVisible(), false, "status entries stay out of the composer");
  const openDetails = async () => {
    const before = await page.evaluate(() => window.posted.length);
    await page.locator("#more").focus();
    await page.keyboard.press("Enter");
    const requests = await page.evaluate((offset) => window.posted.slice(offset), before);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].type, "showMoreActions");
    await post({ type: "showConversationDetails" });
    assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), true);
    assert.equal(await page.locator("#conversation-details #extension-status").count(), 1);
  };
  const closeDetails = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.getElementById("conversation-details").open && document.activeElement.id === "more",
    );
  };
  await openDetails();
  assert.deepEqual(await page.locator("#extension-status > p").allTextContents(), [
    "second: Updated status",
    "first: First status",
  ]);
  let reachedStatus = false;
  for (let index = 0; index < 12 && !reachedStatus; index++) {
    await page.keyboard.press("Tab");
    reachedStatus = await page.evaluate(() => document.activeElement.id === "extension-status");
  }
  assert.equal(reachedStatus, true, "Extension status is reachable with the keyboard in details");
  await closeDetails();
  assert.ok((await page.locator("#extension-ui-above pre").first().textContent()).includes("Visible text"));
  assert.equal(
    await page.locator(".extension-ui-block script, .extension-ui-block a, .extension-ui-block img").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.extensionInjected), undefined);
  assert.equal(await page.locator("#extension-ui-below > p").textContent(), "below");
  assert.equal((await page.locator("#extension-ui-above").textContent()).includes("Must be removed"), false);
  // Status and widget content remain inert plain text, including after status replacement and removal.
  const unsafe = "<script>window.extensionInjected=true</script> [run](command:run) <img src=x onerror=alert(1)>";
  ui.update({ method: "setStatus", statusKey: "unsafe", statusText: `\u001b[31m${unsafe}\u001b[0m\u202e` });
  await state();
  await openDetails();
  assert.equal(await page.locator("#extension-status > p").last().textContent(), `unsafe: ${unsafe}`);
  assert.equal(
    await page.locator(".extension-ui-block script, .extension-ui-block a, .extension-ui-block img").count(),
    0,
  );
  assert.equal(await page.evaluate(() => window.extensionInjected), undefined);
  ui.update({ method: "setStatus", statusKey: "unsafe" });
  await state();
  assert.equal((await page.locator("#extension-status").textContent()).includes(unsafe), false);
  await closeDetails();
  ui.update({ method: "setStatus", statusKey: "long", statusText: "Status_日本語_🐈".repeat(60) });
  await state();
  // The widget scroll regions keep their DOM/keyboard order around the editor.
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
      const light = theme.endsWith("light");
      const foreground = light ? "#000000" : "#ffffff";
      const background = light ? "#ffffff" : "#000000";
      for (const [key, value] of Object.entries({
        "font-family": "Arial",
        "font-size": "13px",
        foreground,
        descriptionForeground: foreground,
        "sideBar-background": background,
        "editor-background": background,
        "input-background": background,
        "input-foreground": foreground,
        "button-background": foreground,
        "button-foreground": background,
        contrastBorder: foreground,
        focusBorder: foreground,
      }))
        document.body.style.setProperty(`--vscode-${key}`, value);
    }, theme);
    for (const width of [159, 169, 180, 220, 280, 600, 960]) {
      for (const height of [344, 358, 420, 800]) {
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
            "more",
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
          assert.equal(await page.locator("#notice").getByRole("button", { name: "Dismiss" }).count(), 0);
          assert.equal(await page.locator("#extension-status").isVisible(), false);
          assert.equal(await page.locator("#more").isEnabled(), true);
          await openDetails();
          assert.equal(await page.locator("#extension-status").isVisible(), true);
          assert.equal(
            await page.locator("#extension-status").evaluate((region) => {
              const rect = region.getBoundingClientRect();
              return region.scrollWidth <= region.clientWidth && rect.left >= 0 && rect.right <= innerWidth;
            }),
            true,
            "long extension status stays inside the details scroll region",
          );
          assert.equal(await page.locator("#input").inputValue(), "Draft\n".repeat(12));
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await closeDetails();
          layouts++;
        }
      }
    }
  }
  // Host lifecycle snapshots clear all extension areas, including an open details dialog.
  ui.update({ method: "setStatus", statusKey: "oversized", statusText: "x".repeat(1001) });
  await state();
  await openDetails();
  assert.match(await page.locator("#extension-status").textContent(), /updates were ignored/);
  assert.match(await page.locator("#notice").textContent(), /Queued delivery is uncertain/);
  ui.clear();
  await state(ui.state, false, { connected: false, busy: false, cancellable: false, queueable: false });
  for (const id of ["extension-status", "extension-ui-above", "extension-ui-below"]) {
    assert.equal(await page.locator(`#${id}`).isVisible(), false);
    assert.equal(await page.locator(`#${id}`).textContent(), "", `${id} retains no prior text or diagnostic`);
  }
  await closeDetails();
  assert.equal(await page.locator("#reconnect").isVisible(), true);
  // Only fresh host events repopulate UI after the replacement session snapshot.
  await state(ui.state, false, { sessionId: "replacement" });
  assert.equal(await page.locator("#extension-ui-above").isVisible(), false);
  ui.update({ method: "setStatus", statusKey: "fresh", statusText: "New session status" });
  ui.update({ method: "setWidget", widgetKey: "fresh", widgetLines: ["New session widget"] });
  await state(ui.state, false, { sessionId: "replacement" });
  assert.equal(await page.locator("#extension-ui-above > p").textContent(), "fresh");
  await openDetails();
  assert.deepEqual(await page.locator("#extension-status > p").allTextContents(), ["fresh: New session status"]);
  ui.clear();
  await state();
  assert.equal(await page.locator("#extension-status").isVisible(), false);
  await closeDetails();
  assert.equal(
    await page.evaluate(() =>
      window.posted.some((message) => /^(?:send|sendNewSession|queueInstruction|draftRestore)$/.test(message.type)),
    ),
    false,
    "extension text, details navigation, and lifecycle changes never submit or restore the draft",
  );
  assert.deepEqual(errors, []);
  await page.close();
  return {
    layouts,
    keyedOrder: "passed",
    textSafety: "passed",
    keyboard: "passed",
    warningAndStop: "passed",
    clearing: "open details and widget regions clear; only fresh events repopulate",
    detailsOnlyStatus: "keyboard reachable, text-only, no composer status rows",
  };
}
