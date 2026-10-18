import assert from "node:assert/strict";

// Real composer and browser events; only the Extension Host protocol is simulated.
export async function assertComposerDraftRecovery(browser, getSidebarHtml) {
  const page = await browser.newPage({ viewport: { width: 320, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100_000, 5_000_000));
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const runtime = { connected: true, busy: false, sessionId: "draft-a", sessionFile: "/fixture/a.jsonl" };
  await post({ type: "state", runtime, attachments: [], messages: [], status: "Ready" });
  const input = page.locator("#input");
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const state = (binding, enabled, available, reset = true) =>
    post({ type: "draftState", binding, enabled, available, writable: true, reset });
  const messages = (type) => page.evaluate((type) => window.posted.filter((item) => item.type === type), type);
  const waitUpdate = (text) =>
    page.waitForFunction(
      (text) => window.posted.some((item) => item.type === "draftChanged" && item.text === text),
      text,
    );
  const openRecovery = async () => {
    await page.locator("#more").click();
    assert.equal((await messages("showMoreActions")).at(-1).text, await input.inputValue());
    await post({ type: "showConversationDetails" });
    assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), true);
    assert.equal(
      await page.locator("#conversation-details #text-draft-recovery").count(),
      1,
      "recovery controls belong to Conversation details",
    );
    const summary = page.locator("#text-draft-recovery > summary");
    if (!(await page.locator("#text-draft-recovery").evaluate((panel) => panel.open))) await summary.click();
  };
  const closeDetails = async () => {
    await page.keyboard.press("Escape");
    await page.waitForFunction(
      () => !document.getElementById("conversation-details").open && document.activeElement.id === "more",
    );
  };
  await state(a, false, false);
  assert.equal(await page.locator("#text-draft-notice").isVisible(), false);
  assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), false);
  await input.fill("not approved");
  await page.waitForTimeout(300);
  assert.equal((await messages("draftChanged")).length, 0);
  await openRecovery();
  await page.locator("#enable-text-drafts").click();
  assert.equal((await messages("draftEnable")).length, 1);
  assert.equal((await messages("draftChanged")).length, 0, "click alone is not host consent");
  await page.locator("#text-draft-recovery > summary").click();
  await closeDetails();
  await state(a, true, false, false);
  await waitUpdate("not approved");

  await input.evaluate((item) => item.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true })));
  await input.fill("日本語 👩🏽‍💻");
  await page.waitForTimeout(300);
  assert.equal(
    (await messages("draftChanged")).some((item) => item.text === "日本語 👩🏽‍💻"),
    false,
  );
  await input.evaluate((item) => item.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true })));
  await waitUpdate("日本語 👩🏽‍💻");
  await input.fill("x".repeat(50_001));
  await page.waitForFunction(() => window.posted.some((item) => item.type === "draftOversized"));
  assert.equal(
    (await messages("draftChanged")).some((item) => item.text.length > 50_000),
    false,
  );

  await input.fill("");
  await state(a, true, true, false);
  assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), false);
  assert.equal(await page.locator("#text-draft-notice").isVisible(), true);
  assert.equal(
    await page.locator("#text-draft-recovery").evaluate((panel) => panel.open),
    false,
    "retention does not expand recovery controls",
  );
  assert.equal(await input.inputValue(), "", "retained text is never restored automatically");
  assert.equal((await messages("draftRestore")).length, 0);
  await page.locator("#text-draft-notice").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), true);
  assert.equal(await page.locator("#text-draft-recovery").evaluate((panel) => panel.open), true);
  assert.equal((await messages("draftRestore")).length, 0, "reviewing retained text is not Restore");
  await page.locator("#restore-text-draft").click();
  const restore = (await messages("draftRestore")).at(-1);
  await closeDetails();
  await input.fill("newer text");
  await post({ type: "draftRestored", binding: a, expectedRevision: restore.revision, text: "!never auto execute" });
  assert.equal(await input.inputValue(), "newer text");
  assert.equal(await page.locator("#restore-text-draft").isDisabled(), true);
  await input.fill("");
  await openRecovery();
  await page.locator("#restore-text-draft").click();
  const next = (await messages("draftRestore")).at(-1);
  await post({
    type: "draftRestored",
    binding: a,
    expectedRevision: next.revision,
    text: "!never auto execute\nUnicode 日本語",
  });
  await page.waitForFunction(
    () => !document.getElementById("conversation-details").open && document.activeElement.id === "input",
  );
  assert.equal(await input.inputValue(), "!never auto execute\nUnicode 日本語");
  assert.equal(await page.locator("#attachments [data-remove-attachment]").count(), 0);
  assert.equal((await messages("send")).length + (await messages("sendNewSession")).length, 0);
  await state(a, true, false, false);
  assert.equal(await page.locator("#text-draft-notice").isVisible(), false);

  // showSessionDetail captures the old text. A newer edit before its binding reply must survive.
  await state(a, true, true, false);
  assert.equal(await page.locator("#text-draft-notice").isVisible(), true);
  await post({ type: "showSessionDetail" });
  assert.equal(
    await page.locator("#text-draft-notice").isVisible(),
    false,
    "the old recovery notice hides during handoff",
  );
  await input.fill("typed during handoff");
  await state(b, true, false);
  assert.equal(
    await page.locator("#text-draft-notice").isVisible(),
    false,
    "the old session notice cannot survive a binding change",
  );
  assert.equal(await input.inputValue(), "typed during handoff");
  await post({ type: "draftRestored", binding: a, expectedRevision: next.revision, text: "old session retained text" });
  assert.equal(await input.inputValue(), "typed during handoff", "an old binding cannot restore into the new session");
  assert.equal(await page.locator("#send").isDisabled(), true);
  await post({ type: "clearInput", expectedText: "typed during handoff", draftBinding: a });
  assert.equal(
    await input.inputValue(),
    "typed during handoff",
    "old acknowledgement cannot clear replacement context",
  );
  await input.fill("");
  await input.fill("session B text");
  await waitUpdate("session B text");
  await post({ type: "showSessionsLayer" });
  await state(a, true, false);
  assert.equal(await input.inputValue(), "session B text", "navigation cannot prove that flushed text was retained");
  assert.equal(await page.locator("#send").isDisabled(), true);
  await input.fill("");
  await input.fill("host-only transition text");
  await state(b, true, false);
  assert.equal(await input.inputValue(), "host-only transition text");
  assert.equal(await page.locator("#send").isDisabled(), true);
  await input.fill("");
  await state(b, true, true, false);
  await input.fill("new draft beside retained text");
  await openRecovery();
  await page.locator("#discard-text-draft").click();
  await closeDetails();
  await state(b, true, false, false);
  await waitUpdate("new draft beside retained text");
  assert.equal(await input.inputValue(), "new draft beside retained text");
  await openRecovery();
  await page.locator("#disable-text-drafts").click();
  assert.equal((await messages("draftDisable")).at(-1).binding, b);
  await closeDetails();
  await state(b, false, false, false);
  assert.equal(await page.locator("#text-draft-notice").isVisible(), false);
  assert.equal(await input.inputValue(), "new draft beside retained text", "Disable does not clear the current draft");
  assert.deepEqual(errors, []);
  const storedMessages = await messages("draftChanged");
  assert.equal(
    storedMessages.every((item) => Object.keys(item).sort().join(",") === "binding,revision,text,type"),
    true,
  );
  assert.equal((await messages("send")).length + (await messages("sendNewSession")).length, 0);
  await page.close();
  const ownership = await assertDraftOwnership(browser, getSidebarHtml);
  return {
    detailsOnlyControls: true,
    retainedNoticeWithoutAutoRestore: true,
    explicitDisable: true,
    explicitConsent: true,
    unicodeIme: true,
    oversized: true,
    explicitRestore: true,
    staleRestore: true,
    handoffRace: true,
    oldAcknowledgement: true,
    discard: true,
    automaticRequests: 0,
    ...ownership,
  };
}

async function assertDraftOwnership(browser, getSidebarHtml) {
  const a = "11111111-1111-4111-8111-111111111111";
  const b = "22222222-2222-4222-8222-222222222222";
  const c = "33333333-3333-4333-8333-333333333333";
  const open = async (binding, enabled = false, available = false) => {
    const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.evaluate(() => {
      window.posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
    });
    await page.setContent(getSidebarHtml(100_000, 5_000_000));
    const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
    const state = (id) => post({ type: "draftState", binding: id, enabled, available, writable: true, reset: true });
    await post({
      type: "state",
      runtime: { connected: true, busy: false, sessionId: "a", sessionFile: "/fixture/a.jsonl" },
      attachments: [],
      messages: [],
      status: "Ready",
    });
    await state(binding);
    return {
      page,
      post,
      state,
      input: page.locator("#input"),
      messages: (type) => page.evaluate((type) => window.posted.filter((item) => item.type === type), type),
      close: async () => {
        assert.deepEqual(errors, []);
        await page.close();
      },
    };
  };
  for (const [name, enabled, available, text] of [
    ["recovery off", false, false, "not retained"],
    ["oversized", true, false, "x".repeat(50_001)],
    ["protected retained record", true, true, "new text beside protected old record"],
    ["persistence unacknowledged", true, false, "flushed is not saved"],
  ]) {
    const f = await open(a, enabled, available);
    await f.input.fill(text);
    await f.post({ type: "showSessionDetail" });
    await f.state(b);
    assert.equal(await f.input.inputValue(), text, `${name}: unchanged navigation handoff must keep text`);
    assert.equal(await f.page.locator("#send").isDisabled(), true, `${name}: uncertain ownership blocks Send`);
    await f.page.waitForTimeout(300);
    assert.equal(
      (await f.messages("draftChanged")).some((item) => item.binding === b && item.text === text),
      false,
      "kept text cannot migrate to the new owner",
    );
    await f.input.fill("");
    await f.input.fill("verified new draft");
    assert.equal(await f.page.locator("#send").isDisabled(), false, "explicit clear releases the ownership block");
    await f.close();
  }

  for (const scenario of ["accepted", "edited", "scope switch", "session switch", "reject"]) {
    const f = await open(a);
    await f.input.fill("accepted origin");
    await f.page.locator("#send").click();
    const sent = (await f.messages("sendNewSession")).at(-1);
    assert.ok(sent, "Sessions Send captures a new-session submission");
    await f.post({ type: "showSessionDetail" });
    await f.state(b);
    assert.equal(await f.input.inputValue(), sent.text, "session creation alone never clears text");
    if (scenario === "edited") await f.input.fill("newer during creation");
    if (scenario === "scope switch") {
      await f.post({ type: "showSessionsLayer" });
      await f.state(c);
    }
    if (scenario === "session switch") await f.state(c);
    if (scenario === "reject") await f.post({ type: "sendRejected" });
    await f.post({ type: "clearInput", draftBinding: a, expectedRevision: sent.revision, expectedText: sent.text });
    assert.equal(
      await f.input.inputValue(),
      scenario === "accepted" ? "" : scenario === "edited" ? "newer during creation" : sent.text,
      `${scenario}: only the live exact accepted send origin can clear`,
    );
    if (scenario === "accepted") {
      await f.input.fill("next prompt");
      assert.equal(await f.page.locator("#send").isDisabled(), false, "accepted clear releases ownership block");
    }
    await f.close();
  }

  // Local commands accept without creating a session or publishing another draft binding.
  for (const command of ["/compact", "/reload"]) {
    for (const enabled of [false, true]) {
      for (const edit of ["unchanged", "newer text", "same text newer revision"]) {
        const f = await open(a, enabled);
        await f.input.fill(command);
        await f.page.locator("#send").click();
        const sent = (await f.messages("sendNewSession")).at(-1);
        assert.ok(sent, "Sessions local command captures a pending send handoff");
        if (edit !== "unchanged") await f.input.fill("newer input");
        if (edit === "same text newer revision") await f.input.fill(command);
        const kept = await f.input.inputValue();
        // A slow local command can outlast the newer revision's debounce while moving blocks writes.
        await f.page.waitForTimeout(300);
        await f.post({ type: "clearInput", draftBinding: a, expectedRevision: sent.revision, expectedText: sent.text });
        assert.equal(
          await f.input.inputValue(),
          edit === "unchanged" ? "" : kept,
          `${command}, recovery ${enabled}, ${edit}: accepted clear cannot remove newer input`,
        );
        assert.doesNotMatch(await f.page.locator("#text-draft-status").textContent(), /Waiting for the draft context/);
        if (enabled && edit !== "unchanged") {
          await f.page.waitForFunction(
            ({ text, revision }) =>
              window.posted.some(
                (item) => item.type === "draftChanged" && item.text === text && item.revision > revision,
              ),
            { text: kept, revision: sent.revision },
            { timeout: 2000 },
          );
        }
        if (edit === "unchanged") await f.input.fill("next prompt");
        assert.equal(
          await f.page.locator("#send").isDisabled(),
          false,
          `${command}, recovery ${enabled}, ${edit}: same-binding acceptance must release the handoff`,
        );
        await f.page.locator("#send").click();
        assert.equal((await f.messages("sendNewSession")).length, 2, "the next Send must actually submit");
        await f.close();
      }
    }
  }

  const rejected = await open(a, true);
  await rejected.input.fill("/compact");
  await rejected.page.locator("#send").click();
  const rejectedSend = (await rejected.messages("sendNewSession")).at(-1);
  await rejected.input.fill("kept after command rejection");
  await rejected.page.waitForTimeout(300);
  await rejected.post({ type: "sendRejected" });
  await rejected.page.waitForFunction(
    (revision) =>
      window.posted.some(
        (item) =>
          item.type === "draftChanged" && item.text === "kept after command rejection" && item.revision > revision,
      ),
    rejectedSend.revision,
    { timeout: 2000 },
  );
  assert.equal(await rejected.input.inputValue(), "kept after command rejection");
  await rejected.close();

  for (const stale of ["binding", "revision", "text"]) {
    const f = await open(a);
    await f.input.fill("/reload");
    await f.page.locator("#send").click();
    const sent = (await f.messages("sendNewSession")).at(-1);
    const accepted = { type: "clearInput", draftBinding: a, expectedRevision: sent.revision, expectedText: sent.text };
    await f.post({
      ...accepted,
      ...(stale === "binding" ? { draftBinding: b } : {}),
      ...(stale === "revision" ? { expectedRevision: sent.revision + 1 } : {}),
      ...(stale === "text" ? { expectedText: "/compact" } : {}),
    });
    assert.equal(await f.input.inputValue(), sent.text, `${stale}: stale clear keeps the command`);
    assert.equal(await f.page.locator("#send").isDisabled(), true, `${stale}: stale clear cannot release the handoff`);
    await f.post(accepted);
    await f.input.fill("next prompt");
    assert.equal(await f.page.locator("#send").isDisabled(), false, "stale clear must not consume the exact token");
    await f.close();
  }

  // A late More start must carry the old binding even when a fresh view repeats revision and text.
  const old = await open(a);
  await old.input.fill("repeated More prompt");
  await old.page.locator("#more").click();
  const more = (await old.messages("showMoreActions")).at(-1);
  assert.ok(more);
  await old.close();
  const replacement = await open(b);
  await replacement.input.fill(more.text);
  await replacement.post({
    type: "clearInput",
    draftBinding: a,
    expectedRevision: more.revision,
    expectedText: more.text,
  });
  assert.equal(
    await replacement.input.inputValue(),
    more.text,
    "replacement view cannot accept an old More start with identical revision and text",
  );
  await replacement.page.locator("#send").click();
  const nextSend = (await replacement.messages("sendNewSession")).at(-1);
  assert.equal(nextSend.revision, more.revision, "regression must actually repeat the origin revision");
  await replacement.post({
    type: "clearInput",
    draftBinding: a,
    expectedRevision: more.revision,
    expectedText: more.text,
  });
  assert.equal(
    await replacement.input.inputValue(),
    more.text,
    "a new view's pending token cannot authorize the old binding",
  );
  await replacement.close();
  return {
    unsavedNavigationPreserved: 4,
    acceptedOriginClear: true,
    newerOriginPreserved: true,
    navigationAndRejectInvalidateOrigin: true,
    acceptedSameBindingLocalCommands: 12,
    staleLocalCommandAcknowledgements: 3,
    delayedHandoffRetention: 5,
    replacementMoreAcknowledgement: true,
  };
}
