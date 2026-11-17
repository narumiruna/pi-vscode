import assert from "node:assert/strict";

// Two editor-panel documents use the real renderer; only VS Code IPC is simulated.
// This does not test native VS Code tabs, Extension Host routing, or a live provider.
export async function assertConcurrentSessions(browser, getSidebarHtml, renderSafeMarkdown, origin) {
  const context = await browser.newContext({ viewport: { width: 600, height: 800 } });
  const errors = [];
  const consoleErrors = [];
  const external = [];
  const html = getSidebarHtml(
    100_000,
    5_000_000,
    {
      source: origin,
      script: `${origin}/rich-content.js`,
      style: `${origin}/rich-content.css`,
    },
    true,
  );
  const panels = [];
  const open = async (name, binding) => {
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(`${name}: ${error}`));
    // Include initial document-load CSP failures, before the DOM listener is installed.
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(`${name}: ${message.text()}`);
    });
    await page.route("**/*", (route) => {
      if (!route.request().url().startsWith(`${origin}/`)) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.evaluate(() => {
      window.concurrentPosted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.concurrentPosted.push(message) });
    });
    await page.setContent(html);
    await page.waitForFunction(() => Boolean(window.piRichContent));
    await page.evaluate(() => {
      window.concurrentViolations = [];
      document.addEventListener("securitypolicyviolation", (event) => {
        window.concurrentViolations.push(event.violatedDirective);
      });
    });
    const panel = { name, binding, page, prompt: `${name}-only prompt`, draft: "", chunks: 0, messages: [] };
    panels.push(panel);
    // Do not send showSessionDetail: the fourth HTML argument must select the initial route.
    await assertDetail(panel);
    return panel;
  };
  const state = async (panel, busy = false) => {
    await post(panel.page, {
      type: "state",
      status: busy ? "Generating response…" : "Ready",
      runtime: {
        connected: true,
        busy,
        queueable: busy,
        cancellable: busy,
        sessionId: `session-${panel.name}`,
        sessionFile: `/fixture/${panel.name}.jsonl`,
      },
      sessions: [{ id: panel.name, title: `Panel ${panel.name}`, current: true, updatedAt: 1 }],
      attachments: [],
      messages: panel.messages,
    });
    await assertDetail(panel);
  };
  const assertDrafts = async () => {
    for (const panel of panels) assert.equal(await panel.page.locator("#input").inputValue(), panel.draft);
  };
  const stream = async (panel, other) => {
    const otherTranscript = await other.page.locator("#messages").innerText();
    panel.chunks += 1;
    // Identical message IDs in separate documents must not share retained renderer nodes.
    panel.messages = [
      { id: "request", role: "user", html: renderSafeMarkdown(panel.prompt) },
      {
        id: "response",
        role: "assistant",
        html: renderSafeMarkdown(
          `**${panel.name}-only stream**\n\n` +
            Array.from({ length: panel.chunks }, (_, index) => `${panel.name}-only chunk ${index + 1}`).join("\n\n"),
        ),
      },
    ];
    await state(panel, true);
    assert.equal(
      await other.page.locator("#messages").innerText(),
      otherTranscript,
      `${panel.name} stream must not change the other document`,
    );
    const transcript = await panel.page.locator("#messages").innerText();
    assert.ok(transcript.includes(panel.prompt));
    for (let index = 1; index <= panel.chunks; index++) {
      assert.ok(transcript.includes(`${panel.name}-only chunk ${index}`));
    }
    assert.ok(!transcript.includes(`${other.name}-only`), "streamed transcripts must not cross documents");
    assert.deepEqual(
      await panel.page.locator("#messages > article").evaluateAll((nodes) => nodes.map((node) => node.messageId)),
      ["request", "response"],
    );
    await assertDrafts();
  };
  try {
    const a = await open("A", "11111111-1111-4111-8111-111111111111");
    const b = await open("B", "22222222-2222-4222-8222-222222222222");
    for (const panel of panels) {
      await state(panel);
      await post(panel.page, {
        type: "draftState",
        binding: panel.binding,
        enabled: true,
        available: false,
        writable: true,
        reset: true,
      });
      panel.draft = panel.prompt;
      await panel.page.bringToFront();
      await panel.page.locator("#input").fill(panel.draft);
    }
    await assertDrafts();
    for (const panel of panels) await waitDraft(panel);

    await a.page.bringToFront();
    await a.page.locator("#input").press("Enter");
    assert.equal((await posted(b.page, "send")).length, 0, "A Send must not post through B IPC");
    await b.page.bringToFront();
    await b.page.locator("#send").click();
    for (const panel of panels) {
      const sends = await posted(panel.page, "send");
      assert.equal(sends.length, 1, "the initial editor-panel submission must use send");
      assert.equal(sends[0].text, panel.prompt);
      assert.equal((await posted(panel.page, "sendNewSession")).length, 0);
    }
    // An acceptance clears only the originating panel, not the other pending draft.
    for (const panel of panels) {
      const [sent] = await posted(panel.page, "send");
      await post(panel.page, {
        type: "clearInput",
        draftBinding: panel.binding,
        expectedText: sent.text,
        expectedRevision: sent.revision,
      });
      panel.draft = "";
      await assertDrafts();
    }
    for (const panel of panels) {
      panel.draft = `${panel.name}-only next draft 日本語`;
      await panel.page.locator("#input").fill(panel.draft);
    }

    let focusEdits = 0;
    for (const [active, other] of [
      [a, b],
      [b, a],
      [a, b],
      [b, a],
    ]) {
      await active.page.bringToFront();
      await active.page.locator("#input").focus();
      await active.page.locator("#input").press("End");
      const addition = ` edit-${++focusEdits}`;
      await active.page.keyboard.insertText(addition);
      active.draft += addition;
      await stream(other, active); // Background output must not replace the focused draft.
      await stream(active, other);
      assert.equal(
        await active.page.evaluate(() => document.hasFocus() && document.activeElement.id === "input"),
        true,
        "stream updates must retain focus in the active page",
      );
    }
    for (const [panel, other] of [
      [a, b],
      [b, a],
    ]) {
      await waitDraft(panel);
      await post(panel.page, { type: "showSessionsLayer" });
      await assertDetail(panel);
      await stream(panel, other); // Later state updates must not restore Sessions navigation.
    }
    await assertDrafts();

    for (const [panel, other] of [
      [a, b],
      [b, a],
    ]) {
      const otherStops = await posted(other.page, "cancel");
      const otherTranscript = await other.page.locator("#messages").innerText();
      await panel.page.bringToFront();
      const stop = panel.page.getByRole("button", { name: "Cancel Pi response", exact: true });
      assert.equal(await stop.innerText(), "Stop");
      await stop.click();
      assert.deepEqual(await posted(panel.page, "cancel"), [{ type: "cancel" }]);
      assert.deepEqual(await posted(other.page, "cancel"), otherStops, "Stop must post only to its own page");
      assert.equal(await other.page.locator("#messages").innerText(), otherTranscript);
      await state(panel, false); // Simulate only this host's stopped state.
      assert.equal(await panel.page.locator("#cancel").isVisible(), false);
      if (panel === a) assert.equal(await other.page.locator("#cancel").isVisible(), true);
      await assertDrafts();
    }

    for (const panel of panels) {
      const drafts = await posted(panel.page, "draftChanged");
      assert.ok(drafts.length > 0);
      assert.ok(
        drafts.every(
          (message) =>
            message.binding === panel.binding && (!message.text || message.text.startsWith(`${panel.name}-only`)),
        ),
        "draft IPC must stay with its page binding",
      );
      assert.equal((await posted(panel.page, "send")).length, 1);
      assert.equal((await posted(panel.page, "sendNewSession")).length, 0);
      assert.equal((await posted(panel.page, "queueInstruction")).length, 0);
      assert.deepEqual(await panel.page.evaluate(() => window.concurrentViolations), []);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(consoleErrors, []);
    assert.deepEqual(external, []);
    return {
      documents: panels.length,
      initialDetailWithoutHostNavigation: true,
      hiddenBackAfterStateAndShowSessionsLayer: true,
      initialSendRoutes: ["send", "send"],
      alternatingFocusEdits: focusEdits,
      independentDraftBindings: panels.length,
      interleavedStreamUpdates: a.chunks + b.chunks,
      stopMessagesPerPage: [1, 1],
      sendNewSessionMessages: 0,
      cspViolations: 0,
      pageErrors: 0,
      consoleErrors: 0,
      externalRequests: 0,
    };
  } finally {
    await context.close();
  }
}

async function assertDetail({ page, name }) {
  assert.equal(
    await page.locator("#app").evaluate((node) => node.classList.contains("sessions-layer")),
    false,
    `${name} must stay in conversation detail`,
  );
  assert.equal(await page.locator("#session-list-content").isVisible(), false);
  assert.notEqual(await page.locator("#session-header-title").textContent(), "Sessions");
  assert.equal(await page.locator("#back-to-sessions").getAttribute("hidden"), "");
  assert.equal(await page.getByRole("button", { name: "Back to Sessions", exact: true }).count(), 0);
  assert.equal(await page.locator("#conversation").isVisible(), true);
  assert.equal(await page.locator("#input").isVisible(), true);
}

async function post(page, data) {
  await page.evaluate((value) => window.dispatchEvent(new MessageEvent("message", { data: value })), data);
}

async function posted(page, type) {
  return page.evaluate((value) => window.concurrentPosted.filter((message) => message.type === value), type);
}

async function waitDraft({ page, binding, draft }) {
  await page.waitForFunction(
    ({ binding, draft }) =>
      window.concurrentPosted.some(
        (message) => message.type === "draftChanged" && message.binding === binding && message.text === draft,
      ),
    { binding, draft },
  );
}
