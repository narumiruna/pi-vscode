import assert from "node:assert/strict";

// Real keyboard, selection, IME, focus and layout; only host IPC is simulated.
export async function assertComposerFileCompletion(browser, getSidebarHtml) {
  const page = await browser.newPage({ viewport: { width: 280, height: 700 } });
  const errors = [];
  page.on("pageerror", error => errors.push(String(error)));
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: message => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100_000, 5_000_000));
  const post = data => page.evaluate(data => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const runtime = { connected: true, busy: false, sessionId: "completion-fixture", sessionFile: "/fixture/session.jsonl" };
  const state = attachments => post({ type: "state", runtime, attachments, messages: [], status: "Ready" });
  await state([]); await post({ type: "showSessionDetail" });
  const input = page.locator("#input");
  const query = async text => {
    await input.fill(text);
    await page.waitForFunction(text => window.posted.some(item => item.type === "fileCompletionQuery" && item.text === text), text);
    return page.evaluate(text => window.posted.filter(item => item.type === "fileCompletionQuery" && item.text === text).at(-1), text);
  };
  const candidate = { id: "11111111-1111-4111-8111-111111111111", path: "src/some path.ts" };
  const results = (request, candidates = [candidate]) => post({ type: "fileCompletionResults", id: request.id, revision: request.revision, token: request.token, candidates });
  const applied = (request, replacement) => post({ type: "fileCompletionApplied", id: request.id, revision: request.revision, token: request.token, replacement });
  const menu = page.locator("#file-completions");
  const request = await query("Explain @src/");
  await results(request);
  assert.equal(await menu.isVisible(), true);
  assert.equal(await menu.getAttribute("aria-label"), "Files to attach as snapshots");
  assert.equal(await input.getAttribute("aria-expanded"), "true");
  await input.press("ArrowDown"); await input.press("Tab");
  assert.equal(await input.evaluate(item => item.readOnly), true);
  assert.equal(await page.locator("#send").isDisabled(), true);
  assert.equal(await page.evaluate(() => window.posted.filter(item => item.type === "fileCompletionSelect").length), 1);
  await applied(request, "");
  await state([{ id: "snapshot", label: candidate.path, image: false }]);
  assert.equal(await input.inputValue(), "Explain ");
  assert.equal(await input.evaluate(item => item.readOnly), false);
  assert.match(await page.locator("#attachments").innerText(), /some path/);
  // Inspection is still the ordinary Attach picker, not another capture or prompt.
  await page.locator("#add-context").click();
  assert.equal(await page.evaluate(() => window.posted.at(-1).type), "pickContext");

  const pathRequest = await query("Look at ./src/"); await results(pathRequest);
  assert.equal(await menu.getAttribute("aria-label"), "Paths to insert without attaching");
  await input.press("Tab"); await applied(pathRequest, '"src/some path.ts"');
  assert.equal(await input.inputValue(), 'Look at "src/some path.ts"');
  assert.equal(await page.locator("#attachments [data-remove-attachment]").count(), 1);

  const failed = await query("Keep @missing"); await results(failed);
  await input.press("Enter");
  await post({ type: "fileCompletionFailed", id: failed.id, revision: failed.revision });
  assert.equal(await input.inputValue(), "Keep @missing");
  assert.equal(await input.evaluate(item => item.readOnly), false);
  assert.equal(await page.locator("#attachments [data-remove-attachment]").count(), 1);

  const late = await query("@old"); await input.fill("Newer draft"); await results(late);
  assert.equal(await menu.isVisible(), false); assert.equal(await input.inputValue(), "Newer draft");
  const dismissed = await query("@escape"); await results(dismissed); await input.press("Escape");
  assert.equal(await menu.isVisible(), false); assert.equal(await input.inputValue(), "@escape");
  await input.press("Tab");
  assert.notEqual(await page.evaluate(() => document.activeElement.id), "input", "Tab without visible results keeps native focus navigation");

  await input.focus();
  await input.evaluate(item => item.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await input.fill("@ime"); await page.waitForTimeout(180);
  assert.equal(await page.evaluate(() => window.posted.some(item => item.type === "fileCompletionQuery" && item.text === "@ime")), false);
  await input.evaluate(item => item.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await page.waitForFunction(() => window.posted.some(item => item.type === "fileCompletionQuery" && item.text === "@ime"));

  const changed = await query("@session");
  await post({ type: "state", runtime: { ...runtime, sessionId: "new-session" }, attachments: [], messages: [] });
  await results(changed); assert.equal(await menu.isVisible(), false);
  for (const text of ["mail@example.com", "/compact", "!cat ./src/", "!!cat @src/"]) {
    await input.fill(text); await page.waitForTimeout(150);
    assert.equal(await page.evaluate(text => window.posted.some(item => item.type === "fileCompletionQuery" && item.text === text), text), false);
  }
  const narrow = await query("@narrow"); await results(narrow);
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate(theme => { document.body.className = theme; }, theme);
    const box = await menu.boundingBox(); assert.ok(box.x >= 0 && box.x + box.width <= 280);
  }
  await input.press("Escape");
  assert.equal(await page.evaluate(() => window.posted.filter(item => ["send", "sendNewSession", "queueInstruction"].includes(item.type)).length), 0);
  await input.fill("Explicit Send"); await input.press("Enter");
  assert.equal(await page.evaluate(() => window.posted.filter(item => item.type === "send").length), 1);
  assert.deepEqual(errors, []);
  await page.close();
  return { attachmentCapture: true, pathOnlyInsertion: true, failedCapture: true, lateReplies: true, ime: true, keyboard: true, narrowThemes: 4, modelRequestsBeforeSend: 0 };
}
