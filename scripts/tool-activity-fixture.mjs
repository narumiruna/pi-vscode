import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

export async function assertToolActivity(frame, page, invoke, release, label) {
  const messages = frame.locator("#messages");
  const toolMessages = messages.locator(":scope > article.message.tool-message");
  const rows = toolMessages.locator(":scope > .content > details.tool");
  await rows.nth(10).waitFor();
  assert.equal(await rows.count(), 11);
  assert.equal(await toolMessages.count(), 11);
  assert.equal(await frame.locator("details.tool").count(), 11, "All tools belong to the message timeline");
  assert.equal(await toolMessages.locator("details.tool.running").count(), 1);
  assert.equal(await toolMessages.locator("details.tool.error").count(), 1);
  assert.equal(await toolMessages.locator("details.tool.success").count(), 9);
  assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.open)), Array(11).fill(false));
  const toolIds = await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.id));
  const heights = await rows.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
  for (const height of heights) {
    assert.ok(height > 0 && height <= 56, `Each collapsed inline tool must fit in 56px, got ${height}`);
  }
  const height = heights.reduce((total, value) => total + value, 0);
  assert.equal(
    await toolMessages.first().evaluate((node) => node.previousElementSibling?.classList.contains("user")),
    true,
    "Tool calls follow their user turn",
  );
  assert.equal(
    await toolMessages.last().evaluate((node) => node.nextElementSibling?.classList.contains("assistant")),
    true,
    "The subsequent assistant answer follows the tool calls",
  );
  const headings = toolMessages.locator(":scope > h2.role");
  assert.equal(await headings.count(), 11);
  for (const heading of await headings.all()) {
    assert.match(await heading.getAttribute("aria-label"), /^Tool message \d+$/);
    assert.equal(
      await heading.evaluate((node) => node.parentElement.getAttribute("aria-labelledby") === node.id),
      true,
    );
    assert.equal(
      await heading.evaluate((node) => {
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return bounds.width <= 1 && bounds.height <= 1 && style.display !== "none" && style.visibility !== "hidden";
      }),
      true,
      "Tool headings remain accessible without a visible role row",
    );
  }
  assert.match(await rows.nth(0).locator("summary").first().innerText(), /read\s+src\/sidebar.ts/);
  assert.equal(await toolMessages.locator("img, script, [onerror], [onclick]").count(), 0);
  assert.match(await rows.nth(4).locator(".tool-section").first().textContent(), /<script>not executable<\/script>/);
  assert.match(await rows.nth(7).locator("summary").first().textContent(), /<img src=x onerror=alert\(1\)>/);

  const bash = rows.nth(2);
  const toggle = bash.locator("summary").first();
  await toggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await bash.evaluate((node) => node.open), true);
  const focusStyle = await toggle.evaluate((node) => ({
    focused: node.matches(":focus-visible"),
    outline: getComputedStyle(node).outlineStyle,
  }));
  assert.equal(focusStyle.focused, true);
  assert.notEqual(focusStyle.outline, "none");
  const output = bash.locator(".tool-section").nth(1);
  const full = output.locator("details");
  const preview = output.locator(":scope > pre");
  assert.ok((await preview.innerText()).length <= 600);
  assert.equal(await preview.evaluate((node) => getComputedStyle(node).overflowY), "hidden");
  assert.ok(await preview.evaluate((node) => node.clientHeight <= 102));
  await full.locator("summary").focus();
  await page.keyboard.press("Space");
  assert.equal(await full.evaluate((node) => node.open), true);
  assert.match(await full.locator("pre").innerText(), /Truncated; only retained text is available/);
  assert.ok((await full.locator("pre").innerText()).length <= 8000);
  assert.ok((await full.locator("pre").innerText()).endsWith("FINAL: retained command summary"));
  assert.equal(
    await full.locator("pre").evaluate((node) => /^(auto|scroll)$/.test(getComputedStyle(node).overflowY)),
    false,
    "Full output uses the conversation scroll surface",
  );
  const readOutput = rows.nth(0).locator(".tool-section").nth(1).locator(":scope > pre");
  assert.equal(await readOutput.textContent(), JSON.stringify({ content: [{ type: "text", text: "file contents" }] }));
  const literalBashOutput = JSON.stringify({
    output: "literal command result",
    exit_code: 0,
    wall_time_seconds: 1,
    truncated: false,
  });
  assert.equal(
    await rows.nth(10).locator(".tool-section").nth(1).locator(":scope > pre").textContent(),
    literalBashOutput,
  );
  assert.match(await bash.locator(".tool-section").first().innerText(), /Input/);
  assert.match(await bash.locator(".tool-section").first().locator(":scope > pre").innerText(), /npm test/);
  await rows.nth(3).evaluate((node) => {
    node.open = true;
  });
  assert.equal(
    await rows.nth(3).locator(".tool-section").nth(1).locator(":scope > pre").innerText(),
    "wrapped first\nwrapped second",
  );
  await rows.nth(6).evaluate((node) => {
    node.open = true;
  });
  assert.match(await rows.nth(6).locator(".tool-section").nth(1).innerText(), /No output returned/);

  // Copy uses the VS Code host clipboard, not navigator.clipboard in the webview.
  // Deterministic failure/late-reply branches are covered by sidebarClipboard.test.ts.
  const copy = output.getByRole("button", { name: "Copy Output", exact: true });
  await copy.focus();
  await page.keyboard.press("Enter");
  await output.getByRole("status").filter({ hasText: "Output copied" }).waitFor();
  assert.equal(await invoke("clipboardRead"), await full.locator("pre").innerText());
  const nativeClipboard = await output.locator('[role="status"]').innerText();
  const inputSection = bash.locator(".tool-section").first();
  await inputSection.getByRole("button", { name: "Copy Input", exact: true }).click();
  await inputSection.getByRole("status").filter({ hasText: "Input copied" }).waitFor();
  assert.equal(await invoke("clipboardRead"), await inputSection.locator(":scope > pre").innerText());

  // Reader-opened and reader-closed disclosures must survive status updates and history settlement.
  const running = rows.nth(10);
  const runningToggle = running.locator(":scope > summary");
  await runningToggle.focus();
  await page.keyboard.press("Enter");
  assert.equal(await running.evaluate((node) => node.open), true);
  await page.keyboard.press("Space");
  assert.equal(await running.evaluate((node) => node.open), false);
  await release();
  await frame.waitForFunction(() => !document.querySelector("#messages details.tool.running"));
  await frame.locator("#cancel").waitFor({ state: "hidden" });
  assert.equal(await rows.count(), 11, "Settled Pi history must preserve tool calls");
  assert.deepEqual(await rows.evaluateAll((nodes) => nodes.map((node) => node.dataset.id)), toolIds);
  assert.equal(await toolMessages.locator("details.tool.success").count(), 10);
  assert.equal(await toolMessages.locator("details.tool.error").count(), 1);
  assert.equal(await bash.evaluate((node) => node.open), true);
  assert.equal(await full.evaluate((node) => node.open), true);
  assert.equal(await running.evaluate((node) => node.open), false);
  assert.equal(await rows.nth(5).evaluate((node) => node.open), false, "Failed tools also stay collapsed by default");
  assert.equal(await runningToggle.evaluate((node) => node === document.activeElement), true);
  assert.equal(
    await rows.nth(10).locator(".tool-section").nth(1).locator(":scope > pre").textContent(),
    literalBashOutput,
  );

  // Output now uses the conversation scroll surface, not nested vertical scrollbars.
  const conversation = frame.locator("#conversation");
  await conversation.evaluate((node) => {
    node.scrollTop = 20;
    node.dispatchEvent(new Event("scroll"));
  });
  const before = await conversation.evaluate((node) => node.scrollTop);
  await rows
    .nth(0)
    .locator("summary")
    .first()
    .evaluate((node) => node.click());
  assert.equal(await conversation.evaluate((node) => node.scrollTop), before);

  // Snapshot the native DOM in a separate browser viewport. Native workbench ancestors
  // clip an iframe resized beyond the sidebar; a snapshot gives exact 640/320px evidence.
  const snapshotBrowser = await chromium.launch({ headless: true });
  const screenshots = [];
  try {
    const capture = await snapshotBrowser.newPage();
    await capture.route("**/*", (route) => route.abort());
    for (const [theme, cssClass] of [
      ["Default Dark Modern", "vscode-dark"],
      ["Default Light Modern", "vscode-light"],
      ["Default High Contrast", "vscode-high-contrast"],
    ]) {
      await invoke("theme", { theme });
      await frame.waitForFunction((name) => document.body.classList.contains(name), cssClass);
      const html = (await frame.content()).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
      for (const width of [640, 320]) {
        await capture.setViewportSize({ width, height: 1100 });
        await capture.setContent(html);
        // Keep the native tool articles in their timeline; omit unrelated turns from this focused snapshot.
        const snapshotMessages = capture.locator("#messages");
        await snapshotMessages.locator(":scope > :not(article.tool-message)").evaluateAll((nodes) =>
          nodes.forEach((node) => {
            node.remove();
          }),
        );
        const snapshotArticles = snapshotMessages.locator(":scope > article.message.tool-message");
        const snapshotRows = snapshotArticles.locator(":scope > .content > details.tool");
        const snapshotBash = snapshotRows.nth(2);
        assert.equal(await snapshotRows.count(), 11);
        await snapshotRows.evaluateAll((nodes) =>
          nodes.forEach((node) => {
            node.open = false;
          }),
        );
        assert.equal(
          await capture.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
          false,
          `${theme} ${width}px must not overflow horizontally`,
        );
        const screenshot = path.join(tmpdir(), `pi-tools-${label}-${cssClass}-${width}.png`);
        await snapshotMessages.screenshot({ path: screenshot });
        screenshots.push(screenshot);
        await snapshotBash.evaluate((node) => {
          node.open = true;
        });
        await snapshotBash.locator(".tool-full").evaluateAll((nodes) =>
          nodes.forEach((node) => {
            node.open = false;
          }),
        );
        assert.equal(await capture.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
        const detailsScreenshot = path.join(tmpdir(), `pi-tools-${label}-${cssClass}-${width}-details.png`);
        await snapshotArticles.nth(2).screenshot({ path: detailsScreenshot });
        screenshots.push(detailsScreenshot);
      }
    }
  } finally {
    await snapshotBrowser.close();
    await invoke("theme", { theme: "Default Dark Modern" });
  }
  return {
    collapsedRowsHeight: height,
    nativeClipboard,
    screenshots,
    checks:
      "native chronological inline tools, default collapse, keyboard, focus, preview, full retained output, native host clipboard, safe text, disclosure through settlement and scroll; native timeline snapshots at 640/320px in dark/light/high-contrast",
  };
}
