import assert from "node:assert/strict";

export async function assertNativeDirectShell(frame, page, executionCount) {
  const before = await executionCount();
  let panel = await frame();
  await panel.locator("#input").fill("!printf pi-shell-fixture");
  await panel.locator("#send").click();
  await page.getByRole("button", { name: "Run Shell", exact: true }).waitFor();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(await executionCount(), before, "rejected native modal executes no shell");
  assert.equal(await panel.locator("#input").inputValue(), "!printf pi-shell-fixture");
  for (const prefix of ["!", "!!"]) {
    panel = await frame();
    await panel.locator("#input").fill(`${prefix}printf pi-shell-fixture`);
    await panel.locator("#send").click();
    await page.getByRole("button", { name: "Run Shell", exact: true }).click();
    await panel.locator(".shell-output").last().filter({ hasText: "Exit: 0" }).waitFor();
    const expected = prefix === "!!" ? "Excluded from model context; retained in Pi history" : "Included in model context on the next prompt";
    assert.match(await panel.locator(".shell-output").last().textContent(), new RegExp(expected));
    assert.equal(await panel.locator(".message.shell img, .message.shell a, .message.shell script").count(), 0);
    assert.doesNotMatch(await panel.locator(".shell-output").last().textContent(), /DO_NOT_RENDER/);
  }
  assert.equal(await executionCount(), before + 2);
  return "native modal rejection/approval, !/!! context labels, retained inert history, correlated final replacement";
}

export async function assertDirectShellInterface(browser, getSidebarHtml, shellMessageText, escapeHtml) {
  const page = await browser.newPage({ viewport: { width: 320, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const state = { type: "state", status: "Ready", runtime: { connected: true, busy: false }, messages: [], attachments: [], imageSupported: true };
  await post({ type: "showSessionDetail" });
  await post(state);
  const input = page.locator("#input");
  await input.fill("!printf harmless");
  assert.equal(await page.locator("#send").isEnabled(), true);
  assert.match(await page.locator("#composer-hint").textContent(), /Approval required/);
  await page.locator("#send").click();
  assert.equal((await page.evaluate(() => window.posted.filter((value) => value.type === "send").at(-1))).text, "!printf harmless");
  await post({ type: "sendRejected" });
  await post({ ...state, attachments: [{ id: "context", label: "fixture.txt", type: "context" }] });
  assert.equal(await page.locator("#send").isDisabled(), true);
  await post({ ...state, runtime: { connected: true, busy: true, queueable: true } });
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await page.locator("#after-this").isDisabled(), true);
  await post({ ...state, runtime: { connected: true, busy: true, queueable: false, cancellable: true } });
  assert.equal(await page.locator("#cancel").isVisible(), true);
  const text = shellMessageText("printf '<img src=x>'", true, { output: "<img src=x onerror=alert(1)>\n[unsafe](https://invalid.example)", exitCode: 7, cancelled: true, truncated: true });
  await post({ ...state, messages: [{ id: "shell", role: "shell", content: text, html: `<pre class="shell-output">${escapeHtml(text)}</pre>` }] });
  assert.equal(await page.locator(".message.shell .role").textContent(), "Shell");
  assert.match(await page.locator(".shell-output").textContent(), /Cancelled · Output truncated/);
  assert.match(await page.locator(".shell-output").textContent(), /Excluded from model context; retained in Pi history/);
  assert.equal(await page.locator(".message.shell img, .message.shell a, .message.shell script").count(), 0);
  await input.fill("\\!literal prose");
  assert.equal(await page.locator("#send").isEnabled(), true);
  for (const width of [280, 900]) {
    await page.setViewportSize({ width, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  assert.deepEqual(errors, []);
  await page.close();
  return { shell: "inert card, !/!! help, attachment/queue guards, Stop, literal escape, responsive layout" };
}
