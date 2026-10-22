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

// Shared assertions also apply while native draft recovery changes the composer state.
export async function assertComposerStatusContract(pi) {
  assert.equal(await pi.locator("#composer > #runtime + .composer-box").count(), 1);
  assert.equal(await pi.locator("#conversation #runtime, #activity #runtime").count(), 0);
  assert.equal(await pi.locator("#runtime").isVisible(), true);
  assert.equal(await pi.locator("#status").getAttribute("role"), "status");
  assert.equal(await pi.locator("#status").getAttribute("aria-live"), "polite");
  assert.equal(await pi.locator("#status").getAttribute("aria-atomic"), "true");
  const explanation = pi.locator("#composer-status");
  assert.equal(await explanation.evaluate((node) => node.hidden), true);
  assert.equal(await explanation.isVisible(), false);
  assert.equal(await explanation.getAttribute("role"), null);
  assert.equal(await explanation.getAttribute("aria-live"), null);
  assert.match(await explanation.getAttribute("data-state"), /^(empty|blocked|ready)$/);
  for (const id of ["input", "send", "after-this"]) {
    assert.ok((await pi.locator(`#${id}`).getAttribute("aria-describedby")).split(/\s+/).includes("composer-status"));
  }
  for (const id of ["reconnect", "retry", "refresh-history"]) {
    assert.equal(await pi.locator(`#runtime > #${id}`).count(), 1, `${id} stays in primary status`);
  }
  assert.equal(await pi.locator(".composer-actions #cancel").count(), 1, "Stop stays in composer actions");
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
    assert.match(await status.textContent(), /Direct shell.*remove attachments/);
    assert.match(await pi.locator("#status").innerText(), /Direct shell.*remove attachments/);
    assert.equal(await status.isVisible(), false, "the submission description is never a second visible status");
    assert.equal(await status.getAttribute("data-state"), "blocked");
  } else {
    assert.equal(await status.isVisible(), false, "an empty composer has no visible hint");
    assert.match(await status.textContent(), /Enter a message or attach context/);
  }
  await assertComposerStatusContract(pi);
  assert.equal(await pi.locator("#composer-help").evaluate((node) => node.open), false);
  assert.ok((await input.getAttribute("aria-describedby")).includes("composer-status"));
  assert.equal(await pi.locator("#send").getAttribute("title"), await status.textContent());
  await input.fill("Native navigation draft, never sent");
  assert.equal(await status.isVisible(), false);
  assert.equal(await status.getAttribute("data-state"), "ready");
  assert.equal(await pi.locator("#status").textContent(), "");
  assert.equal(await pi.locator("#runtime .status-dot").isVisible(), false);
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
  // Consume any output retained by the previous fixture before testing blocker-only changes.
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll"));
  });
  await page.waitForTimeout(150);
  await scroller.hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(150);
  const latest = pi.locator("#jump-to-latest");
  assert.equal(await latest.isVisible(), true, "native conversation fixture must overflow");
  await assertComposerStatusContract(pi);
  const fixed = await pi.locator("#runtime").evaluate((node) => {
    const bounds = node.getBoundingClientRect();
    return bounds.top >= 0 && bounds.bottom <= innerHeight;
  });
  assert.equal(fixed, true, "primary status stays visible while reading older native output");
  const scrollTop = await scroller.evaluate((node) => node.scrollTop);
  if (hasAttachments) {
    await input.fill("!pwd");
    assert.match(await pi.locator("#status").textContent(), /Direct shell.*remove attachments/);
    assert.equal(
      await scroller.evaluate((node) => node.scrollTop),
      scrollTop,
      "blocker changes do not scroll native output",
    );
    assert.equal(await latest.textContent(), "Jump to latest", "a blocker is not New output");
    await input.fill("Native navigation draft, never sent");
  }
  await latest.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(100);
  assert.equal(await latest.isVisible(), false);
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  assert.equal(await input.inputValue(), "Native navigation draft, never sent");
  assert.ok(await scroller.evaluate((node) => node.scrollHeight - node.scrollTop - node.clientHeight <= 16));
  await pi.locator("#runtime").evaluate((node) => {
    window.nativeFixedRuntime = node;
  });
  await pi.locator("#back-to-sessions").click();
  await assertComposerStatusContract(pi);
  assert.equal(await pi.locator("#runtime").evaluate((node) => node === window.nativeFixedRuntime), true);
  // The current conversation can be opened without submitting or changing the session.
  await pi.locator('.session-row[aria-current="page"]:visible').first().click();
  await assertComposerStatusContract(pi);
  assert.equal(await pi.locator("#runtime").evaluate((node) => node === window.nativeFixedRuntime), true);
  await input.fill(saved);
  return {
    blockers: "hidden non-live descriptions; one fixed primary status in both views",
    latest: "keyboard/focus/draft preserved; primary status remains visible",
  };
}
