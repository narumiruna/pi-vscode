import assert from "node:assert/strict";

export async function assertThinkingBrowser(browser, html, renderSafeMarkdown, piMessageThinking, fixture) {
  const page = await browser.newPage({ viewport: { width: 280, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
  });
  await page.setContent(html);
  await page.waitForFunction(() => Boolean(window.piRichContent));
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "showSessionDetail" } })));
  const send = async (messages, busy = true, connected = true) =>
    page.evaluate(
      (state) => {
        window.dispatchEvent(new MessageEvent("message", { data: state }));
      },
      { type: "state", status: busy ? "Pi is thinking…" : "Ready", runtime: { connected, busy }, messages },
    );
  const live = { id: "live", role: "assistant", html: "", thinking: [{ contentIndex: 0, text: "Partial thinking." }] };
  await send([live]);
  const details = page.locator(".thinking-transcript");
  const summary = details.locator("summary");
  await summary.focus();
  await summary.press("Enter");
  await send([{ ...live, thinking: [{ contentIndex: 0, text: "More thinking.\n".repeat(100) }] }]);
  assert.equal(await details.evaluate((element) => element.open), true);
  assert.equal(await summary.evaluate((element) => document.activeElement === element), true);
  await summary.press("Space");
  await send([{ ...live, thinking: [{ contentIndex: 0, text: "Still streaming." }] }]);
  assert.equal(
    await details.evaluate((element) => element.open),
    false,
    "live deltas never reopen a collapsed disclosure",
  );
  const answer = {
    id: "live",
    role: "assistant",
    html: renderSafeMarkdown("Fixture answer."),
    thinking: piMessageThinking(fixture.content),
  };
  const only = {
    id: "history-thinking-only",
    role: "assistant",
    html: "",
    thinking: [{ contentIndex: 0, text: "Thinking-only response." }],
  };
  await send([answer, only], false);
  assert.equal(
    await page
      .locator(".thinking-transcript summary")
      .first()
      .evaluate((element) => document.activeElement === element),
    true,
    "authoritative history preserves focus on the same assistant disclosure",
  );
  const evidence = await assertThinkingDisclosure(page);
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate((theme) => {
      document.body.className = theme;
    }, theme);
    await page.setViewportSize({ width: 200, height: 700 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  }
  // Off-bottom readers keep their position as an expanded live block changes height.
  const older = { id: "older", role: "assistant", html: renderSafeMarkdown("Older answer.\n\n".repeat(100)) };
  await send([older, answer, only], true);
  await page
    .locator(".thinking-transcript")
    .first()
    .evaluate((element) => {
      element.open = true;
    });
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -1000);
  await page.waitForTimeout(100);
  await page.locator("#conversation").evaluate((element) => {
    element.scrollTop = 30;
  });
  const before = await page.locator("#conversation").evaluate((element) => element.scrollTop);
  await send(
    [older, { ...answer, thinking: [{ contentIndex: 0, text: "Stream height change.\n".repeat(300) }] }, only],
    true,
  );
  assert.equal(await page.locator("#conversation").evaluate((element) => element.scrollTop), before);
  // A history/reconnect replacement is authoritative, not an append.
  await send([answer, only], false, false);
  await send([answer, only], false);
  assert.equal(await page.locator(".thinking-transcript").count(), 2);
  assert.deepEqual(errors, []);
  await page.close();
  return {
    ...evidence,
    themes: 4,
    narrowWidth: 200,
    liveFocus: "retained",
    offBottom: "retained",
    history: "replaced",
  };
}

export async function assertThinkingDisclosure(frame) {
  const disclosures = frame.locator(".thinking-transcript");
  assert.equal(await disclosures.count(), 2, "answer and thinking-only messages each have one disclosure");
  const details = disclosures.first();
  const summary = details.locator("summary");
  assert.equal(await details.evaluate((element) => element.open), false);
  await summary.focus();
  await summary.press("Enter");
  assert.equal(await details.evaluate((element) => element.open), true);
  assert.ok((await details.innerText()).includes("Authoritative visible thinking."));
  assert.ok((await details.innerText()).includes("Second visible block."));
  assert.ok((await details.innerText()).includes("Provider redacted this thinking block."));
  assert.equal(await details.locator("img, script, a").count(), 0);
  assert.equal(await frame.locator(".content").filter({ hasText: "Authoritative visible thinking" }).count(), 0);
  assert.doesNotMatch(
    await frame.locator("#messages").innerHTML(),
    /SIGNATURE_MUST_NOT_LEAK|REDACTED_TEXT_MUST_NOT_LEAK/,
  );
  await summary.press("Space");
  assert.equal(await details.evaluate((element) => element.open), false);
  return { disclosures: 2, keyboard: "Enter/Space", redacted: "label only", signatures: "absent" };
}
