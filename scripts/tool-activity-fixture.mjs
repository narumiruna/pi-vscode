import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromium } from "playwright-core";

export async function assertToolActivity(frame, page, invoke, release, label) {
  const group = frame.locator("#tools-group");
  const rows = frame.locator(".tool");
  await rows.nth(10).waitFor();
  assert.equal(await rows.count(), 11);
  assert.match(await frame.locator("#tools-summary").innerText(), /Tool activity · 11 calls/);
  assert.match(await frame.locator("#tools-running").innerText(), /1 running/);
  assert.match(await frame.locator("#tools-failed").innerText(), /1 failed/);
  await group.evaluate((node) => {
    node.open = true;
  });
  await rows.evaluateAll((nodes) =>
    nodes.forEach((node) => {
      node.open = false;
    }),
  );
  const height = await frame.locator("#tools").evaluate((node) => node.getBoundingClientRect().height);
  assert.ok(height <= 275, `11 collapsed rows must fit in 275px, got ${height}`);
  assert.match(await rows.nth(0).locator("summary").first().innerText(), /read\s+src\/sidebar.ts/);
  assert.equal(await frame.locator("#tools img, #tools script").count(), 0);

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

  // Exercise the real webview clipboard policy first; both policy outcomes must be visible.
  const copy = output.getByRole("button", { name: "Copy Output", exact: true });
  await copy.click();
  await output
    .locator('[role="status"]')
    .filter({ hasText: /copied|Copy failed/ })
    .waitFor();
  const nativeClipboard = await output.locator('[role="status"]').innerText();
  // Deterministically verify both async branches without changing webview permissions.
  await frame.evaluate(() => {
    window.toolClipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text) => {
          window.toolCopied = text;
        },
      },
    });
  });
  try {
    await copy.focus();
    await page.keyboard.press("Enter");
    await output.getByRole("status").filter({ hasText: "Output copied" }).waitFor();
    assert.equal(await frame.evaluate(() => window.toolCopied), await full.locator("pre").innerText());
    const inputSection = bash.locator(".tool-section").first();
    await inputSection.getByRole("button", { name: "Copy Input", exact: true }).click();
    await inputSection.getByRole("status").filter({ hasText: "Input copied" }).waitFor();
    assert.equal(await frame.evaluate(() => window.toolCopied), await inputSection.locator(":scope > pre").innerText());
    await frame.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async () => {
            throw new Error("Denied by fixture");
          },
        },
      }),
    );
    await copy.click();
    await output.getByRole("status").filter({ hasText: "Copy failed" }).waitFor();
  } finally {
    await frame.evaluate(() => {
      delete navigator.clipboard;
      if (window.toolClipboardDescriptor) Object.defineProperty(navigator, "clipboard", window.toolClipboardDescriptor);
      delete window.toolCopied;
      delete window.toolClipboardDescriptor;
    });
  }

  // A disclosure made by the reader must survive completion, including full retained output.
  await group.locator(":scope > summary").click();
  await group.locator(":scope > summary").click();
  await release();
  await frame.waitForFunction(() => !document.querySelector("#tools-running").textContent);
  assert.equal(await group.evaluate((node) => node.open), true);
  assert.equal(await bash.evaluate((node) => node.open), true);
  assert.equal(await full.evaluate((node) => node.open), true);
  assert.match(await frame.locator("#tools-failed").innerText(), /1 failed/);

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
        const snapshotRows = capture.locator(".tool");
        const snapshotGroup = capture.locator("#tools-group");
        const snapshotBash = snapshotRows.nth(2);
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
        await snapshotGroup.screenshot({ path: screenshot });
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
        await snapshotBash.screenshot({ path: detailsScreenshot });
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
      "native keyboard, focus, preview, full retained output, copy success/failure, safe text, disclosure and scroll; native DOM snapshots at 640/320px in dark/light/high-contrast",
  };
}
