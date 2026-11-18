import assert from "node:assert/strict";
import { createHash } from "node:crypto";

// One real Sidebar document with deterministic host snapshots, not a live provider.
export async function assertSidebarConcurrency(browser, getSidebarHtml, renderSafeMarkdown, origin) {
  const context = await browser.newContext({ viewport: { width: 600, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.route("**/*", (route) => {
    if (!route.request().url().startsWith(`${origin}/`)) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const a = "aaaaaaaaaaaaaaaaaaaaaaaa";
  const b = "bbbbbbbbbbbbbbbbbbbbbbbb";
  const launcher = "cccccccccccccccccccccccc";
  const entries = new Map([
    [a, { text: "A saved draft", revision: 5 }],
    [b, { text: "B saved draft", revision: 9 }],
    [launcher, { text: "Launcher draft", revision: 2 }],
  ]);
  const activities = ["running", "waiting", "completed", "failed", "stopped", "idle"];
  let generation = 0;
  let current;
  let currentComposerContext = 0;
  let resultRevision = 0;
  let rows = activities.map((activity, index) => ({
    id: index === 0 ? a : index === 1 ? b : String(index).repeat(24),
    title: index === 0 ? "Session A" : index === 1 ? "Session B" : `Session ${index + 1}`,
    updatedAt: Date.now() - index * 60000,
    current: index === 0,
    activity,
    unread: index === 2,
  }));
  const messages = (id) => [
    { id: "request", role: "user", html: renderSafeMarkdown(`${id === a ? "A" : "B"}-only prompt`) },
    {
      id: "response",
      role: "assistant",
      html: renderSafeMarkdown(
        Array.from({ length: 65 }, (_, index) => `${id === a ? "A" : "B"}-only paragraph ${index + 1}`).join("\n\n"),
      ),
    },
  ];
  const syncDrafts = async () => {
    for (const message of await posted(page, "sidebarViewState")) {
      if (entries.has(message.entryId)) entries.set(message.entryId, { text: message.text, revision: message.revision });
    }
  };
  const state = async (id, options = {}) => {
    if (id !== current || options.rebind) {
      await syncDrafts();
      generation += 1;
      current = id;
    }
    currentComposerContext = options.composerContext ?? 0;
    const sessionsView = options.view === undefined ? id === launcher : options.view === "sessions";
    const snapshot = {
      type: "state",
      sidebar: {
        entryId: id,
        bindingGeneration: generation,
        composerContext: currentComposerContext,
        view: sessionsView ? "sessions" : "session",
        resultRevision,
        composer: { ...entries.get(id), contextBlocked: Boolean(options.contextBlocked) },
        primary: id === a,
        canClose: id === b,
        canStart: Boolean(options.canStart),
      },
      status: options.busy ? "Generating response…" : "Ready",
      runtime: {
        connected: options.connected !== false,
        busy: Boolean(options.busy),
        queueable: Boolean(options.busy),
        cancellable: Boolean(options.busy),
        sessionId: sessionsView ? undefined : `session-${id}`,
        sessionFile: sessionsView ? undefined : `/fixture/${id}.jsonl`,
      },
      history: { available: true, mode: options.mode || "latest", loading: Boolean(options.historyLoading), canNavigate: true, generation: 1 },
      sessions: rows,
      imageSupported: true,
      editorRequest: options.editorRequest,
      attachments: options.attachments || [],
      messages: options.messages ?? (sessionsView ? [] : messages(id)),
    };
    await post(page, snapshot);
    await frames(page);
    return snapshot;
  };
  const envelope = () => ({ entryId: current, bindingGeneration: generation, composerContext: currentComposerContext });
  try {
    await page.evaluate(() => {
      window.sidebarPosted = [];
      window.sidebarViolations = [];
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.sidebarPosted.push(message) });
      document.addEventListener("securitypolicyviolation", (event) => {
        window.sidebarViolations.push(event.violatedDirective);
      });
    });
    await page.setContent(
      getSidebarHtml(100_000, 5_000_000, {
        source: origin,
        script: `${origin}/rich-content.js`,
        style: `${origin}/rich-content.css`,
      }),
    );
    await page.waitForFunction(() => Boolean(window.piRichContent));
    assert.deepEqual(await posted(page, "ready"), [{ type: "ready" }]);
    const staleAState = await state(a, { busy: true });
    assert.equal(await page.locator("#conversation").isVisible(), true);
    assert.equal(await page.locator("#input").inputValue(), "A saved draft");
    assert.equal(await page.locator("#new-session").isEnabled(), true, "busy A must not block admission");
    assert.equal(await page.locator("#close-sidebar-session").isVisible(), false);
    await page.locator("#input").fill("A unsent draft 日本語");
    const aOrigin = envelope();
    for (const command of ["/new", "/resume"]) {
      await page.locator("#input").fill(command);
      assert.equal(await page.locator("#send").isEnabled(), true, "local navigation remains available during work");
      const sends = (await posted(page, "send")).length;
      const queues = (await posted(page, "queueInstruction")).length;
      await page.locator("#input").press("Enter");
      assert.equal((await posted(page, "send")).length, sends + 1);
      assert.equal((await posted(page, "send")).at(-1).text, command);
      assert.equal((await posted(page, "queueInstruction")).length, queues, "navigation must never enter a model queue");
      await post(page, { type: "sendRejected", sidebar: envelope() });
    }
    for (const guarded of [
      { editorRequest: { id: "prepared", label: "Prepared action", description: "Keep this action", requiresInput: false } },
      { attachments: [{ id: "reference", label: "Keep reference", image: false }] },
    ]) {
      await state(a, { busy: true, ...guarded });
      await page.locator("#input").fill("/new");
      const sends = (await posted(page, "send")).length;
      assert.equal(await page.locator("#send").isDisabled(), true, "navigation keeps prepared-action and attachment guards");
      await page.locator("#input").press("Enter");
      assert.equal((await posted(page, "send")).length, sends);
    }
    await state(a, { busy: true });
    const beforeAEdit = (await posted(page, "sidebarViewState")).at(-1).revision;
    await page.locator("#input").fill("A unsent draft 日本語");
    assert.equal(await page.locator("#input").inputValue(), "A unsent draft 日本語");
    assert.equal(await page.locator("#input").evaluate((node) => node === document.activeElement), true);
    const aView = (await posted(page, "sidebarViewState")).at(-1);
    assert.equal(aView.text, "A unsent draft 日本語");
    assert.equal(aView.revision, beforeAEdit + 1);

    const scroller = page.locator("#conversation");
    await scroller.hover();
    await page.mouse.wheel(0, -100000);
    await page.waitForFunction(() => !document.getElementById("jump-to-latest").hidden);
    await frames(page);
    await scroller.evaluate((node) => {
      node.scrollTop = 180;
      node.dispatchEvent(new Event("scroll"));
    });
    const aTop = await scroller.evaluate((node) => node.scrollTop);
    await post(page, { type: "showConversationDetails", sidebar: aOrigin });
    assert.equal(await page.locator("#conversation-details").evaluate((node) => node.open), true);

    await state(b, { busy: true });
    assert.equal(await page.locator("#conversation-details").evaluate((node) => node.open), false);
    assert.equal(await page.locator("#input").inputValue(), "B saved draft");
    assert.match(await page.locator("#messages").innerText(), /B-only prompt/);
    assert.doesNotMatch(await page.locator("#messages").innerText(), /A-only/);
    await page.locator("#input").fill("B unsent draft");
    const bOrigin = envelope();
    await page.locator("#cancel").click();
    assert.deepEqual(await posted(page, "cancel"), [{ type: "cancel", ...bOrigin }]);
    await page.locator("#close-sidebar-session").click();
    assert.deepEqual(await posted(page, "closeSidebarSession"), [{ type: "closeSidebarSession", ...bOrigin }]);
    await post(page, staleAState);
    await post(page, { type: "clearInput", expectedText: "B unsent draft", sidebar: aOrigin });
    await post(page, { type: "clearInput", expectedText: "B unsent draft" });
    assert.equal(await page.locator("#input").inputValue(), "B unsent draft", "stale or unbound replies cannot clear B");

    // Delay a real FileReader completion across B -> A. It must never use A's envelope.
    await page.evaluate(() => {
      const NativeFileReader = window.FileReader;
      window.sidebarFinishImage = undefined;
      window.FileReader = class extends NativeFileReader {
        readAsDataURL(blob) {
          window.sidebarFinishImage = () => super.readAsDataURL(blob);
        }
      };
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([new Uint8Array([1, 2, 3])], "B-image.png", { type: "image/png" }));
      document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard }));
    });
    await state(a, { busy: true });
    assert.equal(await page.locator("#input").inputValue(), "A unsent draft 日本語");
    assert.ok(Math.abs((await scroller.evaluate((node) => node.scrollTop)) - aTop) <= 2, "restore A's reading anchor");
    assert.equal(await page.locator("#jump-to-latest").isVisible(), true);
    assert.equal(await page.locator("#cancel").isVisible(), true, "B Stop must not stop A");
    await page.evaluate(() => window.sidebarFinishImage());
    await page.waitForFunction(() => window.sidebarPosted.some((message) => message.type === "pasteImage"));
    const [image] = await posted(page, "pasteImage");
    assert.equal(image.entryId, bOrigin.entryId);
    assert.equal(image.bindingGeneration, bOrigin.bindingGeneration);
    assert.equal(await page.locator("#input").inputValue(), "A unsent draft 日本語");
    assert.doesNotMatch(await page.locator("#composer-status").textContent(), /Loading pasted/);
    await page.locator("#cancel").click();
    assert.equal((await posted(page, "cancel")).at(-1).entryId, a);
    await page.locator("#new-session").click();
    assert.equal((await posted(page, "newSession")).at(-1).entryId, a);

    // Navigation saves A without locally changing the host-owned binding or composer.
    await page.locator("#back-to-sessions").click();
    assert.deepEqual((await posted(page, "draftSelect")).at(-1), { type: "draftSelect", scope: "sessions", ...envelope() });
    await state(launcher, { connected: false, canStart: true });
    assert.equal(await page.locator("#session-header-title").textContent(), "Sessions");
    assert.equal(await page.locator("#input").inputValue(), "Launcher draft");
    assert.equal(await page.locator("#send").isEnabled(), true, "a fresh lazy session can submit before connection");
    await page.locator("#send").click();
    assert.equal((await posted(page, "sendNewSession")).at(-1).entryId, launcher, "cold Send dispatches to its launcher owner");
    assert.deepEqual(
      await page.locator("#recent-session-list .session-row-activity").allTextContents(),
      ["Running", "Waiting for input", "Completed", "Failed", "Stopped", "Idle"],
    );
    const unread = page.locator("#recent-session-list .session-row").nth(2);
    assert.equal(await unread.locator(".session-unread-dot").isVisible(), true);
    assert.match(await unread.getAttribute("class"), /session-row/);
    assert.equal(await unread.locator(".session-row-unread").textContent(), "Unread result");
    const first = page.locator("#recent-session-list .session-row").first();
    assert.equal(await first.evaluate((node) => node.tagName), "BUTTON");
    assert.equal(await first.getAttribute("aria-current"), "page");
    await first.focus();
    await first.evaluate((node) => { window.sidebarFocusedRow = node; });
    rows = rows.map((row, index) => index === 1 ? { ...row, activity: "completed", unread: true } : row);
    await post(page, { type: "sidebarSessions", sessions: rows, sidebar: envelope() });
    assert.equal(
      await first.evaluate((node) => node === window.sidebarFocusedRow && document.activeElement === node),
      true,
      "background progress must keep the same focused button",
    );
    assert.equal(await page.locator("#recent-session-list .session-row-activity").nth(1).textContent(), "Completed");
    // The binding stays unchanged after cancel, capacity rejection, or editor reveal.
    const savedRow = page.locator("#recent-session-list .session-row").nth(2);
    await savedRow.click();
    assert.equal(await first.isDisabled(), true);
    await post(page, { type: "sessionSwitchRejected", sidebar: { entryId: a, bindingGeneration: 0 } });
    assert.equal(await first.isDisabled(), true, "stale replies cannot clear the current row action");
    await post(page, { type: "sessionSwitchRejected", sidebar: envelope() });
    assert.equal(await first.isEnabled(), true, "an unchanged-binding completion releases row navigation");
    const selections = (await posted(page, "switchRecentSession")).length;
    await savedRow.click();
    assert.equal((await posted(page, "switchRecentSession")).length, selections + 1);
    await post(page, { type: "sessionSwitchRejected", sidebar: envelope() });
    const navigationCount = (await posted(page, "draftSelect")).length;
    await first.click();
    assert.equal((await posted(page, "draftSelect")).at(-1).scope, "session");
    await state(a);
    assert.equal((await posted(page, "draftSelect")).length, navigationCount + 1, "host rendering must not navigate again");
    assert.equal(await page.locator("#input").inputValue(), "A unsent draft 日本語");

    // Results are read only in rendered, visible latest detail while following the tail.
    resultRevision = 1;
    await state(a);
    assert.equal((await posted(page, "acknowledgeResult")).length, 0, "reading older output leaves results unread");
    await page.locator("#jump-to-latest").click();
    assert.deepEqual((await posted(page, "acknowledgeResult")).at(-1), { type: "acknowledgeResult", revision: 1, ...envelope() });
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    resultRevision = 2;
    await state(a);
    assert.equal((await posted(page, "acknowledgeResult")).length, 1, "hidden detail cannot acknowledge");
    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    assert.equal((await posted(page, "acknowledgeResult")).at(-1).revision, 2);
    resultRevision = 3;
    await state(a, { historyLoading: true });
    assert.equal((await posted(page, "acknowledgeResult")).length, 2, "loading history cannot acknowledge or consume its dedup key");
    await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
    assert.equal((await posted(page, "acknowledgeResult")).length, 2);
    await state(a, { historyLoading: false });
    assert.equal((await posted(page, "acknowledgeResult")).length, 3, "the same revision acknowledges after history finishes loading");
    assert.equal((await posted(page, "acknowledgeResult")).at(-1).revision, 3);
    await state(a, { historyLoading: false });
    assert.equal((await posted(page, "acknowledgeResult")).length, 3, "a rendered result still deduplicates normally");
    resultRevision = 4;
    await state(a, { mode: "earlier" });
    assert.equal((await posted(page, "acknowledgeResult")).length, 3, "earlier history cannot acknowledge");
    await state(launcher);
    assert.equal((await posted(page, "acknowledgeResult")).length, 3, "Sessions cannot acknowledge results");
    await page.locator("#input").fill("Separate launcher draft");
    await state(b);
    assert.equal(await page.locator("#input").inputValue(), "B unsent draft");
    await state(launcher);
    assert.equal(await page.locator("#input").inputValue(), "Separate launcher draft");

    // Real recovery bindings change during promotion and cold startup before accepted clear.
    const draftState = (binding) => post(page, { type: "draftState", binding, enabled: false, writable: true, available: false, reset: true, sidebar: envelope() });
    const promoted = "dddddddddddddddddddddddd";
    entries.set(promoted, { text: "Captured launcher submission", revision: 2 });
    await state(promoted, { view: "sessions", connected: false, canStart: true });
    const launcherBinding = "11111111-1111-4111-8111-111111111111";
    await draftState(launcherBinding);
    await page.locator("#send").click();
    const promotedSend = (await posted(page, "sendNewSession")).at(-1);
    await state(promoted, { view: "session", rebind: true, busy: true });
    await draftState("22222222-2222-4222-8222-222222222222");
    await post(page, { type: "clearInput", draftBinding: launcherBinding, expectedText: promotedSend.text, expectedRevision: promotedSend.revision, sidebar: envelope() });
    assert.equal(await page.locator("#input").inputValue(), "", "promotion clears its exact accepted text across draft owners");

    const cold = "eeeeeeeeeeeeeeeeeeeeeeee";
    entries.set(cold, { text: "Captured cold detail submission", revision: 3 });
    await state(cold, { view: "session", connected: false, canStart: true });
    const coldBinding = "33333333-3333-4333-8333-333333333333";
    await draftState(coldBinding);
    await page.locator("#send").click();
    const coldSend = (await posted(page, "send")).at(-1);
    await draftState("44444444-4444-4444-8444-444444444444");
    await post(page, { type: "clearInput", draftBinding: coldBinding, expectedText: coldSend.text, expectedRevision: coldSend.revision, sidebar: envelope() });
    assert.equal(await page.locator("#input").inputValue(), "", "cold first Send clears after session-file assignment");
    await page.locator("#input").fill("Submitted before another draft-owner assignment");
    await page.locator("#send").click();
    const olderSend = (await posted(page, "send")).at(-1);
    await draftState("55555555-5555-4555-8555-555555555555");
    await page.locator("#input").fill("Newer text must remain");
    await post(page, { type: "clearInput", draftBinding: "44444444-4444-4444-8444-444444444444", expectedText: olderSend.text, expectedRevision: olderSend.revision, sidebar: envelope() });
    assert.equal(await page.locator("#input").inputValue(), "Newer text must remain");

    // A restored composer has no local submission token from its destroyed document.
    const restored = "101010101010101010101010";
    const restoredText = "Accepted after renderer reconstruction";
    entries.set(restored, { text: restoredText, revision: 80 });
    await state(restored);
    await draftState("88888888-8888-4888-8888-888888888888");
    const restoredAcceptance = {
      type: "clearInput",
      draftBinding: "99999999-9999-4999-8999-999999999999",
      expectedText: restoredText,
      expectedRevision: 80,
    };
    await post(page, { ...restoredAcceptance, sidebar: envelope() });
    assert.equal(
      await page.locator("#input").inputValue(), restoredText,
      "an old draft token alone cannot clear restored text",
    );
    await post(page, {
      ...restoredAcceptance,
      sidebar: { ...envelope(), composer: { text: "", revision: 82, contextBlocked: false } },
    });
    assert.equal(
      await page.locator("#input").inputValue(), restoredText,
      "a mismatched host revision cannot clear restored text",
    );
    await post(page, {
      ...restoredAcceptance,
      sidebar: { ...envelope(), composer: { text: "", revision: 81, contextBlocked: false } },
    });
    assert.equal(
      await page.locator("#input").inputValue(), "",
      "the host's exact accepted snapshot clears without a document-local token",
    );
    await page.locator("#input").fill("New text after reconstruction");
    await post(page, {
      ...restoredAcceptance,
      sidebar: { ...envelope(), composer: { text: "", revision: 81, contextBlocked: false } },
    });
    assert.equal(
      await page.locator("#input").inputValue(), "New text after reconstruction",
      "a repeated acceptance must preserve newer text",
    );

    // Each host owns its payloads, but all Sidebar entries share this bounded DOM cache.
    const imageData = await page.evaluate(() => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 1;
      const context = canvas.getContext("2d");
      return Array.from({ length: 101 }, (_, index) => {
        context.fillStyle = `rgb(${index},0,0)`;
        context.fillRect(0, 0, 1, 1);
        return canvas.toDataURL("image/png").split(",")[1];
      });
    });
    const payloads = imageData.map((data) => {
      const bytes = Buffer.from(data, "base64");
      return { type: "imageAsset", id: `sha256-${createHash("sha256").update(bytes).digest("hex")}`,
        mimeType: "image/png", data, byteLength: bytes.length, width: 1, height: 1 };
    });
    const withImages = (assets) => [{ id: "images", role: "user", html: "<p>Retained images</p>", attachments: assets.map((asset) => ({
      type: "image", assetId: asset.id, label: "retained.png", fullLabel: "retained.png",
      mimeType: asset.mimeType, width: 1, height: 1, availability: "available",
    })) }];
    const aImage = payloads.at(-1);
    await state(a, { messages: withImages([aImage]) });
    await post(page, { ...aImage, sidebar: envelope() });
    await page.waitForFunction(() => document.querySelector("#messages img")?.naturalWidth === 1);
    await state(b, { messages: withImages(payloads.slice(0, 100)) });
    for (const asset of payloads.slice(0, 100)) await post(page, { ...asset, sidebar: envelope() });
    const eviction = (await posted(page, "imageAssetEvicted")).find((message) => message.id === aImage.id);
    assert.equal(eviction.entryId, b, "B reports eviction of A's asset under the current binding");
    await state(a, { messages: withImages([aImage]) });
    assert.equal(await page.locator("#messages img").count(), 0);
    assert.match(await page.locator("#messages").innerText(), /Loading image/);
    // The host regression requires selection to emit this retained payload again.
    await post(page, { ...aImage, sidebar: envelope() });
    await page.waitForFunction(() => document.querySelector("#messages img")?.naturalWidth === 1);

    // An actual same-entry session replacement retains the stale-context block.
    const replaced = "ffffffffffffffffffffffff";
    entries.set(replaced, { text: "Draft for the original runtime session", revision: 9 });
    await state(replaced, { view: "session" });
    const oldDraftBinding = "66666666-6666-4666-8666-666666666666";
    await post(page, { type: "draftState", binding: oldDraftBinding, enabled: false, writable: true, available: false, reset: true, sidebar: { ...envelope(), composer: { contextBlocked: false } } });
    assert.equal(await page.locator("#send").isEnabled(), true);
    await post(page, { type: "draftState", binding: "77777777-7777-4777-8777-777777777777", enabled: false, writable: true, available: false, reset: true, sidebar: { ...envelope(), composer: { contextBlocked: true } } });
    assert.equal(await page.locator("#send").isDisabled(), true, "a real runtime replacement must block the old draft");
    assert.match(await page.locator("#notice").textContent(), /session changed|Draft context changed/i);
    const sendsBeforeReplacement = (await posted(page, "send")).length;
    await page.locator("#input").press("Enter");
    assert.equal((await posted(page, "send")).length, sendsBeforeReplacement);
    await post(page, { type: "clearInput", draftBinding: oldDraftBinding, expectedText: "Draft for the original runtime session", expectedRevision: 9, sidebar: { ...envelope(), composer: { contextBlocked: true } } });
    assert.equal(await page.locator("#input").inputValue(), "Draft for the original runtime session");
    await state(a);
    assert.equal(await page.locator("#send").isEnabled(), true, "A must not inherit another entry's context block");
    await state(replaced, { view: "session", contextBlocked: true });
    assert.equal(await page.locator("#send").isDisabled(), true, "the owner keeps its guard across Sidebar bindings");
    await page.locator("#input").fill("");
    await state(replaced, { view: "session", contextBlocked: false });
    await page.locator("#input").fill("New draft for the verified current session");
    assert.equal(await page.locator("#send").isEnabled(), true);

    // The host has not received this text when a real replacement changes its context.
    const racing = "202020202020202020202020";
    entries.set(racing, { text: "", revision: 0 });
    await state(racing);
    await page.locator("#input").fill("Unreported text for the previous session");
    await state(racing, { composerContext: 1 });
    assert.equal(await page.locator("#send").isDisabled(), true, "a changed context must block unreported text");
    assert.equal(await page.locator("#input").inputValue(), "Unreported text for the previous session");
    assert.equal((await posted(page, "sidebarViewState")).at(-1).composerContext, 0);
    await post(page, { type: "draftState", binding: "abababab-abab-4bab-8bab-abababababab", reset: true,
      enabled: false, writable: true, available: false,
      sidebar: { ...envelope(), composer: { contextBlocked: false } } });
    assert.equal(await page.locator("#send").isDisabled(), true, "host metadata must not retarget old text");
    await page.locator("#input").fill("");
    const emptyReport = (await posted(page, "sidebarViewState")).at(-1);
    assert.equal(emptyReport.composerContext, 1, "only explicit empty input adopts the new context");
    await page.locator("#input").fill("Fresh text for the current session");
    await page.locator("#send").click();
    assert.equal((await posted(page, "send")).at(-1).composerContext, 1);

    const all = await page.evaluate(() => window.sidebarPosted);
    for (let index = 1; index < all.length; index += 1) {
      const message = all[index];
      assert.match(message.entryId, /^[a-f0-9]{24}$/);
      assert.equal(Number.isSafeInteger(message.bindingGeneration), true);
      if (["cancel", "newSession", "draftSelect", "closeSidebarSession"].includes(message.type)) {
        assert.equal(all[index - 1].type, "sidebarViewState", "actions publish their view state first");
        assert.equal(all[index - 1].entryId, message.entryId);
        assert.equal(all[index - 1].bindingGeneration, message.bindingGeneration);
      }
    }
    assert.deepEqual(await page.evaluate(() => window.sidebarViolations), []);
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(external, []);
    return {
      documents: 1,
      switchedEntries: 8,
      activityLabels: activities.length,
      independentStops: 2,
      originBoundDelayedImage: true,
      draftsAndReadingAnchorPreserved: true,
      keyedFocusPreserved: true,
      unchangedNavigationReleased: true,
      imageEvictionRecovered: true,
      loadingHistoryAcknowledgedAfterRender: true,
      busyNavigationShortcuts: true,
      runtimeReplacementDraftGuard: true,
      reconstructedComposerAcceptance: true,
      lateComposerContextGuard: true,
      visibilityAndLatestAcknowledgement: true,
      cspViolations: 0,
      pageErrors: 0,
      consoleErrors: 0,
      externalRequests: 0,
    };
  } finally {
    await context.close();
  }
}

async function post(page, data) {
  await page.evaluate((value) => window.dispatchEvent(new MessageEvent("message", { data: value })), data);
}

async function posted(page, type) {
  return page.evaluate((value) => window.sidebarPosted.filter((message) => message.type === value), type);
}

async function frames(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}
