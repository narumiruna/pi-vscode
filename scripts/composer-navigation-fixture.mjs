import assert from "node:assert/strict";

// Open the actual host picker rather than dispatching a webview-only fixture reply.
export async function openConversationDetails(pi, page) {
  const dialog = pi.locator("#conversation-details");
  if (await dialog.evaluate((node) => node.open)) return;
  await pi.locator("#more").focus();
  await page.keyboard.press("Enter");
  const picker = page.locator(".quick-input-widget").filter({ hasText: "Pi Session Actions" });
  await picker.locator("input[type=text]").fill("Conversation details");
  await picker.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Conversation details" }).waitFor();
  await picker.locator("input[type=text]").press("Enter");
  await dialog.waitFor({ state: "visible" });
}

// Use the real native sidebar with an idle fixture conversation. Never submit a prompt.
export async function assertComposerNavigation(pi, page) {
  const input = pi.locator("#input");
  const saved = await input.inputValue();
  await input.fill("");
  const status = pi.locator("#composer-status");
  const hasAttachments = (await pi.locator("#attachments > *").count()) > 0;
  if (hasAttachments) {
    assert.equal(await status.isVisible(), false, "attachment-only submission remains available");
    await input.fill("!pwd");
    assert.match(await status.innerText(), /Direct shell.*remove attachments/);
  } else {
    assert.equal(await status.isVisible(), false, "an empty composer has no visible hint");
    assert.match(await status.textContent(), /Enter a message or attach context/);
  }
  assert.equal(await status.getAttribute("aria-live"), "polite");
  assert.equal(await pi.locator("#composer-help").evaluate((node) => node.open), false);
  assert.ok((await input.getAttribute("aria-describedby")).includes("composer-status"));
  assert.equal(await pi.locator("#send").getAttribute("title"), await status.textContent());
  await input.fill("Native navigation draft, never sent");
  assert.equal(await status.isVisible(), false);
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  assert.equal(await pi.locator("#thinking-level").count(), 0, "settings use one combined button");
  await pi.locator("#model-picker").click();
  const settings = page.locator(".quick-input-widget").filter({ hasText: "Pi Model and Thinking" });
  await settings.locator("input[type=text]").waitFor({ state: "visible" });
  assert.match(await settings.innerText(), /Change Model/);
  assert.match(await settings.innerText(), /Change Thinking Level/);
  await page.keyboard.press("Escape");
  await settings.waitFor({ state: "hidden" });
  assert.equal(await input.inputValue(), "Native navigation draft, never sent");
  const scroller = pi.locator("#conversation");
  await scroller.hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(150);
  const latest = pi.locator("#jump-to-latest");
  assert.equal(await latest.isVisible(), true, "native conversation fixture must overflow");
  await latest.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  assert.equal(await latest.isVisible(), false);
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  assert.equal(await input.inputValue(), "Native navigation draft, never sent");
  assert.ok(await scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 16));
  await input.fill(saved);
  return { blockers: "quiet empty composer, accessible hint, visible blockers and clear-on-ready", latest: "keyboard/focus/draft preserved" };
}
