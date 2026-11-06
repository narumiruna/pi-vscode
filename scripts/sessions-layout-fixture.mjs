import assert from "node:assert/strict";

// The real sidebar document with fixture IPC; no Pi process or provider is used.
export async function assertSessionsLayout(browser, getSidebarHtml) {
  const page = await browser.newPage({ viewport: { width: 400, height: 800 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.evaluate(() => {
      window.posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
    });
    await page.setContent(getSidebarHtml(100000, 5000000));
    await page.evaluate(() => {
      document.body.style.setProperty("--vscode-font-family", "Arial");
      document.body.style.setProperty("--vscode-font-size", "13px");
    });
    const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      id: index.toString(16).padStart(24, "0"),
      title: `Session ${index}`,
      updatedAt: Date.now() - index * 60000,
      current: index === 0,
    }));
    const state = (rows = sessions) =>
      post({
        type: "state",
        runtime: { connected: true, busy: false },
        sessions: rows,
      });
    const layout = () =>
      page.evaluate(() => {
        const list = document.getElementById("recent-session-list");
        const bounds = list.getBoundingClientRect();
        const viewAll = document.getElementById("view-all-sessions").getBoundingClientRect();
        const composer = document.getElementById("composer").getBoundingClientRect();
        return {
          height: bounds.height,
          visibleRows: [...list.children].filter((row) => {
            const rect = row.getBoundingClientRect();
            return rect.top >= bounds.top - 1 && rect.bottom <= bounds.bottom + 1;
          }).length,
          rowHeight: list.firstElementChild?.getBoundingClientRect().height,
          scrollable: list.scrollHeight > list.clientHeight,
          listBottom: bounds.bottom,
          viewAllTop: viewAll.top,
          viewAllBottom: viewAll.bottom,
          composerTop: composer.top,
          composerBottom: composer.bottom,
          viewportHeight: innerHeight,
          pageFits:
            document.documentElement.scrollWidth <= innerWidth && document.documentElement.scrollHeight <= innerHeight,
        };
      });
    await state();
    const cases = [];
    for (const theme of ["vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light"]) {
      await page.evaluate((name) => {
        document.body.className = name;
      }, theme);
      for (const size of [
        { width: 280, height: 360 },
        { width: 400, height: 800 },
        { width: 727, height: 1295 },
      ]) {
        await page.setViewportSize(size);
        const result = await layout();
        assert.ok(result.visibleRows > 3, JSON.stringify({ theme, size, result }));
        assert.ok(result.rowHeight >= 28, "rows keep their normal height");
        assert.equal(result.scrollable, true);
        assert.ok(result.listBottom <= result.viewAllTop);
        assert.ok(result.viewAllBottom <= result.composerTop);
        assert.ok(result.composerBottom <= result.viewportHeight);
        assert.equal(result.pageFits, true, JSON.stringify({ theme, size, result }));
        cases.push({ theme, ...size, visibleRows: result.visibleRows });
      }
    }
    assert.ok(cases[2].visibleRows > cases[1].visibleRows && cases[1].visibleRows > cases[0].visibleRows);

    // Composer growth must reduce the list, not push controls outside the viewport.
    await page.setViewportSize({ width: 400, height: 800 });
    const before = await layout();
    await page.locator("#input").fill("Draft line\n".repeat(8));
    const grown = await layout();
    assert.ok(grown.height < before.height);
    assert.ok(grown.viewAllBottom <= grown.composerTop);
    assert.equal(await page.locator("#input").inputValue(), "Draft line\n".repeat(8));

    // Entries beyond the visible rows work without opening View all.
    const last = page.locator("#recent-session-list .session-row").last();
    await last.focus();
    await page.keyboard.press("Enter");
    assert.deepEqual(await page.evaluate(() => window.posted.at(-1)), {
      type: "switchRecentSession",
      id: sessions[99].id,
    });
    assert.ok(await page.locator("#recent-session-list").evaluate((node) => node.scrollTop > 0));
    await post({ type: "sessionSwitchRejected" });

    // View all retains its search and Back behavior.
    await page.locator("#view-all-sessions").click();
    await page.locator("#session-search-input").fill("Session 99");
    assert.equal(await page.locator("#all-session-list .session-row").count(), 1);
    await page.locator("#back-to-sessions").click();
    assert.equal(await page.locator("#recent-session-list .session-row").count(), 100);
    assert.equal(await page.locator("#input").inputValue(), "Draft line\n".repeat(8));

    // A short list keeps compact rows and View all directly below them.
    await page.locator("#input").fill("");
    await state(sessions.slice(0, 2));
    const short = await layout();
    assert.equal(short.visibleRows, 2);
    assert.equal(short.scrollable, false);
    assert.ok(short.rowHeight >= 28 && short.rowHeight < 40);
    assert.ok(short.viewAllTop - short.listBottom <= 3);
    assert.ok(short.composerTop - short.viewAllBottom > 100);
    await state([]);
    assert.equal(await page.locator("#recent-session-list .session-row").count(), 0);
    assert.equal(await page.locator("#view-all-sessions").isVisible(), false);
    assert.equal(await page.locator("#input").isVisible(), true);
    assert.deepEqual(errors, []);
    return {
      cases,
      rows: sessions.length,
      composerGrowth: true,
      keyboardSwitch: true,
      search: true,
      shortAndEmpty: true,
    };
  } finally {
    await page.close();
  }
}
