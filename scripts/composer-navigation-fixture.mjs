import assert from "node:assert/strict";

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
    assert.equal(await status.isVisible(), true);
    assert.match(await status.innerText(), /Enter a message or attach context/);
  }
  assert.equal(await status.getAttribute("aria-live"), "polite");
  assert.equal(await pi.locator("#composer-help").evaluate((node) => node.open), false);
  assert.ok((await input.getAttribute("aria-describedby")).includes("composer-status"));
  assert.equal(await pi.locator("#send").getAttribute("title"), await status.innerText());
  await input.fill("Native navigation draft, never sent");
  assert.equal(await status.isVisible(), false);
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
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
  return { blockers: "visible neutral status and clear-on-ready", latest: "keyboard/focus/draft preserved" };
}
