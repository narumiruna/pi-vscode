import assert from "node:assert/strict";

// Primary-status presentation only. All state is deterministic; no runtime or provider is started.
export async function assertFixedStatus({ page, state, post, runtime, themes, theme, renderSafeMarkdown, prose }) {
  const primary = page.locator("#status");
  const description = page.locator("#composer-status");
  const input = page.locator("#input");
  const placement = async () => {
    assert.equal(await page.locator("#composer > #runtime + .composer-box").count(), 1);
    assert.equal(await page.locator("#conversation #runtime, #activity #runtime").count(), 0);
    assert.equal(await page.locator("#runtime").isVisible(), true);
    assert.equal(await page.locator("#runtime").evaluate((node) => node.hidden), false);
    assert.equal(
      await page
        .locator("#runtime")
        .evaluate((node) =>
          Boolean(
            document.getElementById("extension-ui-above").compareDocumentPosition(node) &
              Node.DOCUMENT_POSITION_FOLLOWING,
          ),
        ),
      true,
    );
  };
  const accessibility = async () => {
    assert.equal(await primary.getAttribute("role"), "status");
    assert.equal(await primary.getAttribute("aria-live"), "polite");
    assert.equal(await primary.getAttribute("aria-atomic"), "true");
    assert.equal(await description.evaluate((node) => node.hidden), true);
    assert.equal(await description.getAttribute("role"), null);
    assert.equal(await description.getAttribute("aria-live"), null);
    for (const id of ["input", "send", "after-this"]) {
      assert.ok(
        (await page.locator(`#${id}`).getAttribute("aria-describedby")).split(/\s+/).includes("composer-status"),
      );
    }
    const text = await primary.textContent();
    if (text) {
      const duplicates = await page
        .locator('[role="status"], [aria-live="polite"], [aria-live="assertive"]')
        .evaluateAll((nodes, text) => nodes.filter((node) => node.textContent === text).map((node) => node.id), text);
      assert.deepEqual(duplicates, ["status"], "only the primary live region announces the selected message");
    }
  };
  await page.evaluate(() => {
    window.fixedRuntime = document.getElementById("runtime");
    window.runtimeMoves = 0;
    window.runtimeObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (node === window.fixedRuntime) window.runtimeMoves++;
        }
      }
    });
    window.runtimeObserver.observe(document.getElementById("app"), { childList: true, subtree: true });
  });
  // Identical geometry in both views, including extension widgets requested above the editor.
  let geometryCases = 0;
  for (const sessions of [false, true]) {
    await post({ type: sessions ? "showSessionsLayer" : "showSessionDetail" });
    for (const widgets of [false, true]) {
      const extensionUi = {
        statuses: [],
        widgets: widgets ? [{ key: "fixture", placement: "aboveEditor", lines: ["Above editor"] }] : [],
      };
      await input.fill("");
      await state({ extensionUi });
      await placement();
      await accessibility();
      assert.equal(await primary.textContent(), "");
      assert.equal(await page.locator("#runtime .status-dot").isVisible(), false);
      const idle = await page.locator(".composer-box").boundingBox();
      const reserved = await page.locator("#runtime").evaluate((node) => ({
        height: node.getBoundingClientRect().height,
        minimum: parseFloat(getComputedStyle(node).minHeight),
        line: parseFloat(getComputedStyle(document.getElementById("status")).lineHeight),
      }));
      assert.ok(reserved.minimum > 0 && reserved.height >= reserved.line, JSON.stringify(reserved));
      await input.focus();
      await state({
        status: "Thinking…",
        runtime: { ...runtime, busy: true, queueable: true, cancellable: true },
        extensionUi,
      });
      assert.equal(
        await primary.textContent(),
        sessions ? "Pi is working. Wait or use Stop before starting a new session." : "Thinking…",
      );
      assert.equal(await page.locator("#runtime .status-dot").isVisible(), true);
      const working = await page.locator(".composer-box").boundingBox();
      assert.ok(
        Math.abs(idle.y - working.y) <= 1,
        `one-line progress does not move editor: ${JSON.stringify({ idle, working })}`,
      );
      assert.equal(await page.evaluate(() => document.activeElement.id), "input", "status does not steal focus");
      await accessibility();
      geometryCases++;
    }
  }
  await post({ type: "showSessionDetail" });
  await state();
  await input.fill("/compact");
  await state({ status: "Running read…", runtime: { ...runtime, busy: true, queueable: true, cancellable: true } });
  assert.match(await primary.textContent(), /Slash commands cannot be queued/);
  await accessibility();
  await state({
    status: "Request failed · Retry available",
    retryAvailable: true,
    runtime: { ...runtime, busy: true, queueable: true, cancellable: true },
  });
  assert.equal(await primary.textContent(), "Request failed · Retry available", "problems precede draft blockers");
  assert.match(await description.textContent(), /Slash commands cannot be queued/);
  await accessibility();
  await state({ status: "Pi completed · History refresh failed", historyRecoveryAvailable: true });
  assert.equal(await primary.textContent(), "Pi completed · History refresh failed");
  await state({ status: "Pi resources reloaded", historyRecoveryAvailable: true });
  assert.equal(
    await primary.textContent(),
    "History unavailable · Refresh available",
    "stale results do not mask recovery",
  );
  await state({ status: "Stopped" });
  assert.equal(await primary.textContent(), "Stopped", "non-Ready results remain available");

  // Recovery remains reachable when visible selection changes; hiding a focused action restores input focus.
  for (const id of ["reconnect", "retry", "refresh-history"]) {
    await state({
      status: "Disconnected · Reconnect available",
      runtime: { ...runtime, connected: false },
      retryAvailable: true,
      historyRecoveryAvailable: true,
    });
    for (const action of ["reconnect", "retry", "refresh-history"])
      assert.equal(await page.locator(`#runtime #${action}`).isVisible(), true);
    if (id !== "reconnect") await state({ retryAvailable: true, historyRecoveryAvailable: true });
    assert.equal(await page.locator(`#${id}`).isEnabled(), true);
    await page.locator(`#${id}`).focus();
    assert.equal(await page.evaluate(() => document.activeElement.id), id);
    await state();
    assert.equal(await page.locator(`#${id}`).isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.activeElement.id),
      "input",
      `${id} disappearance restores input focus`,
    );
  }

  // Long plain-text problems wrap with recovery actions in all themes, short/narrow layouts and CSS zoom.
  let wrappingCases = 0;
  const longStatus =
    "Disconnected. Inspect history before repeating this request, then use Reconnect to continue. <b>Not markup</b>";
  for (const name of Object.keys(themes)) {
    await theme(name);
    for (const [width, height, zoom] of [
      [220, 420, 1],
      [280, 420, 1.25],
      [400, 420, 1.5],
      [600, 500, 2],
    ]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((zoom) => {
        document.body.style.zoom = String(zoom);
      }, zoom);
      await input.fill("");
      await state({
        status: longStatus,
        runtime: { ...runtime, connected: false },
        retryAvailable: true,
        historyRecoveryAvailable: true,
      });
      await placement();
      await accessibility();
      assert.equal(await primary.textContent(), longStatus);
      assert.equal(await primary.locator("b").count(), 0, "status remains plain text");
      const bounds = await page.locator("#runtime").evaluate((node) => {
        const region = node.getBoundingClientRect();
        const text = document.getElementById("status");
        const range = document.createRange();
        range.selectNodeContents(text);
        return {
          region: { left: region.left, right: region.right, top: region.top, bottom: region.bottom },
          lines: [...range.getClientRects()].map(({ left, right, top, bottom }) => ({ left, right, top, bottom })),
          controls: [...node.querySelectorAll("button")]
            .filter((button) => !button.hidden)
            .map((button) => {
              const { left, right, top, bottom } = button.getBoundingClientRect();
              return { left, right, top, bottom };
            }),
          clipped: text.scrollWidth > text.clientWidth + 1 || text.scrollHeight > text.clientHeight + 1,
          horizontalOverflow: document.documentElement.scrollWidth > innerWidth,
        };
      });
      const label = JSON.stringify({ name, width, height, zoom, bounds });
      assert.equal(bounds.clipped, false, label);
      assert.equal(bounds.horizontalOverflow, false, label);
      assert.ok(bounds.lines.length > 1, label);
      assert.ok(bounds.region.top >= 0 && bounds.region.bottom <= height, label);
      for (const rect of [...bounds.lines, ...bounds.controls]) {
        assert.ok(
          rect.left >= bounds.region.left - 1 &&
            rect.right <= bounds.region.right + 1 &&
            rect.top >= bounds.region.top - 1 &&
            rect.bottom <= bounds.region.bottom + 1,
          label,
        );
      }
      const controls = bounds.controls;
      for (let i = 0; i < controls.length; i++)
        for (let j = i + 1; j < controls.length; j++) {
          const a = controls[i];
          const b = controls[j];
          assert.ok(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top, label);
        }
      wrappingCases++;
    }
  }
  await page.evaluate(() => {
    document.body.style.zoom = "";
  });
  await theme("vscode-dark");
  await page.setViewportSize({ width: 600, height: 420 });
  const messages = [{ id: "fixed-status-long", role: "assistant", html: renderSafeMarkdown(prose) }];
  await state({ messages });
  await page.locator("#jump-to-latest").evaluate((node) => node.click());
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(100);
  for (const position of ["older", "near-bottom"]) {
    await page.locator("#conversation").evaluate((node, position) => {
      node.scrollTop = position === "older" ? 40 : node.scrollHeight - node.clientHeight - 40;
    }, position);
    await page.waitForTimeout(100);
    const scrollTop = await page.locator("#conversation").evaluate((node) => node.scrollTop);
    for (const extra of [
      { status: "Thinking…", runtime: { ...runtime, busy: true, queueable: true, cancellable: true } },
      {
        status: longStatus,
        runtime: { ...runtime, connected: false },
        retryAvailable: true,
        historyRecoveryAvailable: true,
      },
      {},
    ]) {
      await state({ messages, ...extra });
      await page.waitForTimeout(100);
      assert.equal(
        await page.locator("#conversation").evaluate((node) => node.scrollTop),
        scrollTop,
        `short/long status does not scroll ${position} output`,
      );
      assert.equal(await page.locator("#jump-to-latest").textContent(), "Jump to latest");
      assert.equal(
        await page.evaluate(() => conversationPinnedToBottom),
        false,
        "status does not enable automatic following",
      );
      await placement();
      const bounds = await page.locator("#runtime").boundingBox();
      assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 420, "status stays visible when reading old output");
    }
    await page.locator("#conversation").hover();
    await page.mouse.wheel(0, 100000);
    await page.waitForTimeout(100);
    assert.equal(
      await page.evaluate(() => conversationPinnedToBottom),
      true,
      "user scroll to bottom resumes following after resize",
    );
  }
  // A shrinking status can naturally clamp a reader who is only 20px above the tail.
  // That layout scroll must not turn following back on or clear the New output indication.
  await page.setViewportSize({ width: 220, height: 420 });
  await state({ messages, status: "Pi completed · History refresh failed", historyRecoveryAvailable: true });
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -100000);
  await page.waitForTimeout(100);
  const changedMessages = [{ ...messages[0], html: renderSafeMarkdown(prose + "\n\nNew transcript output") }];
  await state({
    messages: changedMessages,
    status: "Pi completed · History refresh failed",
    historyRecoveryAvailable: true,
  });
  await page.locator("#conversation").evaluate((node) => {
    node.scrollTop = node.scrollHeight - node.clientHeight - 20;
  });
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => conversationPinnedToBottom), false);
  assert.equal(await page.evaluate(() => hasNewTranscriptOutput), true);
  assert.match(await page.locator("#jump-to-latest").textContent(), /New output/);
  const beforeClamp = await page.locator("#conversation").evaluate((node) => node.scrollTop);
  const longHeight = (await page.locator("#runtime").boundingBox()).height;
  await page.evaluate(() => {
    window.statusScrollCalls = 0;
    window.originalStatusScroll = setConversationScrollTop;
    setConversationScrollTop = (...args) => {
      const before = document.getElementById("conversation").scrollTop;
      const result = window.originalStatusScroll(...args);
      if (document.getElementById("conversation").scrollTop !== before) window.statusScrollCalls++;
      return result;
    };
  });
  await state({ messages: changedMessages });
  await page.waitForTimeout(200);
  const clamped = await page.evaluate(() => {
    const node = document.getElementById("conversation");
    const result = {
      top: node.scrollTop,
      maximum: node.scrollHeight - node.clientHeight,
      softwareScrolls: window.statusScrollCalls,
      following: conversationPinnedToBottom,
      newOutput: hasNewTranscriptOutput,
    };
    setConversationScrollTop = window.originalStatusScroll;
    return result;
  });
  assert.ok((await page.locator("#runtime").boundingBox()).height < longHeight);
  assert.ok(clamped.maximum < beforeClamp, "fixture must exercise a natural near-tail clamp");
  assert.equal(clamped.top, Math.min(beforeClamp, clamped.maximum), "only the natural viewport clamp is allowed");
  assert.equal(clamped.softwareScrolls, 0, "status changes do not cause an extra software scroll");
  assert.equal(clamped.following, false, "natural clamp does not resume automatic following");
  assert.equal(clamped.newOutput, true, "natural clamp does not clear New output");
  assert.match(await page.locator("#jump-to-latest").textContent(), /New output/);
  assert.equal(await page.locator("#jump-to-latest").isVisible(), true);
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -100);
  await page.waitForTimeout(100);
  assert.equal(await page.evaluate(() => conversationPinnedToBottom), false);
  await page.mouse.wheel(0, 100000);
  await page.waitForTimeout(100);
  assert.equal(
    await page.evaluate(() => conversationPinnedToBottom),
    true,
    "user scroll resumes following after natural clamp",
  );
  assert.equal(await page.evaluate(() => hasNewTranscriptOutput), false);
  assert.equal(await page.locator("#jump-to-latest").isVisible(), false);
  assert.equal(await page.evaluate(() => window.runtimeMoves), 0, "runtime is never removed or reparented");
  assert.equal(await page.locator("#runtime").evaluate((node) => node === window.fixedRuntime), true);
  await page.evaluate(() => window.runtimeObserver.disconnect());
  await page.setViewportSize({ width: 600, height: 800 });
  await state();
  return {
    geometryCases,
    wrappingCases,
    placement: "permanent composer child in both views",
    focus: "all recovery controls",
    liveRegion: "one polite atomic primary; hidden non-live submission description",
    scroll: "older/near-bottom output stays fixed; natural near-tail clamp preserves pause and New output",
  };
}
