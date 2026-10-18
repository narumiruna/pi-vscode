import assert from "node:assert/strict";

/** Shared assertions use only Page/Frame APIs, including the native webview Frame. */
export async function assertDiscoveryWrap(frame) {
  const headings = frame.locator("#messages > article > h2.role");
  const labels = await headings.evaluateAll((nodes) =>
    nodes.map((node) => ({
      id: node.id,
      label: node.getAttribute("aria-label"),
      owner: node.parentElement.getAttribute("aria-labelledby"),
    })),
  );
  assert.ok(labels.length > 0, "transcript messages have navigable headings");
  assert.equal(new Set(labels.map((item) => item.id)).size, labels.length);
  assert.equal(new Set(labels.map((item) => item.label)).size, labels.length);
  for (const item of labels) {
    assert.match(item.id, /^pi-message-heading-\d+$/);
    assert.match(item.label, /^(?:You|Pi|Shell) message \d+$/);
    assert.equal(item.owner, item.id);
  }
  assert.equal(await frame.locator("#messages").getAttribute("aria-live"), "off");
  const code = frame.locator("#messages .message:not(.shell) .content pre");
  assert.ok(await code.count(), "fixture includes transcript source blocks");
  const snapshot = () =>
    code.evaluateAll((nodes) => nodes.map((node) => ({ text: node.textContent, html: node.innerHTML })));
  const before = await snapshot();
  const toggle = frame.locator("#wrap-code");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.focus();
  await toggle.press("Space");
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await toggle.evaluate((node) => document.activeElement === node), true);
  assert.deepEqual(await snapshot(), before, "wrapping preserves source and highlighted markup");
  const source = code.first();
  const copyText = () =>
    source.evaluate((node) => {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(node);
      selection.removeAllRanges();
      selection.addRange(range);
      const text = selection.toString();
      selection.removeAllRanges();
      return text;
    });
  const wrappedCopy = await copyText();
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  assert.equal(await copyText(), wrappedCopy, "copy selection is independent of wrapping");
  assert.deepEqual(await snapshot(), before);
  return { headings: labels.length, keyboard: "Space/Enter", sourceAndCopy: "unchanged" };
}

export async function assertDiscoveryWrapBrowser(browser, getSidebarHtml, renderSafeMarkdown) {
  const page = await browser.newPage({ viewport: { width: 280, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.evaluate(() => {
    window.fixturePosts = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.fixturePosts.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  await page.evaluate(() => {
    for (const [key, value] of Object.entries({
      "font-family": "Arial",
      "font-size": "13px",
      "editor-font-family": "monospace",
      "editor-font-size": "13px",
    }))
      document.body.style.setProperty(`--vscode-${key}`, value);
  });
  const post = (data) =>
    page.evaluate((message) => {
      window.dispatchEvent(new MessageEvent("message", { data: message }));
    }, data);
  await post({ type: "showSessionDetail" });
  const long = "日本語🙂_".repeat(80);
  const markdown = `\`\`\`typescript\n  const value = "${long}";\n    // indentation stays intact\n\`\`\`\n\n\`\`\`mermaid\npie\n  "Unsupported diagram fallback": 1\n\`\`\``;
  const messages = [
    { id: "user", role: "user", html: renderSafeMarkdown("Inspect the source.") },
    { id: "answer", role: "assistant", html: renderSafeMarkdown(markdown), thinking: [{ text: "Visible thinking." }] },
    { id: "shell", role: "shell", html: `<pre class="shell-output">${long}</pre>` },
  ];
  const state = (changes = {}) =>
    post({
      type: "state",
      runtime: { connected: true, busy: false },
      messages,
      fileCompletionSupport: { available: true },
      imageSupported: true,
      extensionUi: { widgets: [{ key: "text", placement: "aboveEditor", lines: [long] }] },
      ...changes,
    });
  await state();
  const hint = page.locator("#file-discovery-hint");
  assert.match(await hint.innerText(), /@ selects a file snapshot/);
  assert.match(await hint.innerText(), /Tab on a visible path suggestion inserts only its path/);
  assert.ok((await page.locator("#input").getAttribute("aria-describedby")).includes("file-discovery-hint"));
  assert.equal(
    await page.evaluate(() =>
      window.fixturePosts.some((message) => /^(?:fileCompletion|send|queueInstruction|attach)/.test(message.type)),
    ),
    false,
    "discovery help does not capture files or call Pi",
  );
  for (const text of ["!echo x", "!!echo x", "/compact"]) {
    await page.locator("#input").fill(text);
    assert.match(await hint.innerText(), /unavailable for shell input and slash commands/);
  }
  await page.locator("#input").fill("");
  for (const reason of [
    "File completion requires a trusted workspace.",
    "File completion requires a file-backed workspace.",
    "File completion requires a workspace matching the Pi working directory.",
  ]) {
    await state({ fileCompletionSupport: { available: false, reason } });
    assert.equal(await hint.innerText(), reason);
    assert.doesNotMatch(await hint.innerText(), /@ selects|Tab on/);
  }
  await state();
  const evidence = await assertDiscoveryWrap(page);
  const heading = page.locator("#messages > article > h2.role").nth(1);
  const headingId = await heading.getAttribute("id");
  await heading.evaluate((node) => {
    window.retainedHeading = node;
    node.focus();
  });
  await state({
    messages: messages.map((message) =>
      message.id === "answer" ? { ...message, html: renderSafeMarkdown(markdown + "\n\nStreaming.") } : message,
    ),
  });
  assert.equal(
    await heading.evaluate((node) => node === window.retainedHeading && document.activeElement === node),
    true,
  );
  // Adding an earlier message forces structural history replacement, retaining the existing identity.
  await state({ messages: [{ id: "earlier", role: "user", html: "<p>Earlier turn.</p>" }, ...messages] });
  const retained = page.locator(`[id="${headingId}"]`);
  assert.equal(await retained.count(), 1);
  assert.equal(
    await retained.evaluate((node) => node === window.retainedHeading && document.activeElement === node),
    true,
  );
  assert.equal(await retained.getAttribute("aria-label"), "Pi message 3");
  assert.equal(await page.locator(".thinking-transcript").evaluate((node) => node.open), false);
  await state();
  const toggle = page.locator("#wrap-code");
  for (const theme of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate((value) => {
      document.body.className = value;
      const light = value.endsWith("light");
      const foreground = light ? "#000000" : "#ffffff";
      const background = light ? "#ffffff" : "#000000";
      for (const [key, color] of Object.entries({
        foreground,
        descriptionForeground: foreground,
        contrastBorder: foreground,
        "sideBar-background": background,
        "editor-background": background,
        "input-background": background,
        "input-foreground": foreground,
        "button-background": foreground,
        "button-foreground": background,
        focusBorder: foreground,
      }))
        document.body.style.setProperty(`--vscode-${key}`, color);
    }, theme);
    for (const width of [200, 280, 480]) {
      for (const height of [500, 700]) {
        await page.setViewportSize({ width, height });
        if ((await toggle.getAttribute("aria-pressed")) === "true") await toggle.click();
        const pre = page.locator(".assistant .content pre").first();
        assert.equal(await pre.evaluate((node) => node.scrollWidth > node.clientWidth), true);
        const shellBefore = await page.locator(".shell pre").evaluate((node) => getComputedStyle(node).whiteSpace);
        const widgetBefore = await page
          .locator(".extension-ui-block pre")
          .evaluate((node) => getComputedStyle(node).whiteSpace);
        await toggle.click();
        assert.equal(await pre.evaluate((node) => node.scrollWidth <= node.clientWidth + 1), true);
        assert.equal(
          await page.locator(".shell pre").evaluate((node) => getComputedStyle(node).whiteSpace),
          shellBefore,
        );
        assert.equal(
          await page.locator(".extension-ui-block pre").evaluate((node) => getComputedStyle(node).whiteSpace),
          widgetBefore,
        );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      }
    }
  }
  // Retain the display choice for replacement sessions and new streamed blocks.
  await state({ runtime: { connected: true, sessionId: "replacement" } });
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(
    await page
      .locator(".assistant .content pre")
      .first()
      .evaluate((node) => getComputedStyle(node).whiteSpace),
    "pre-wrap",
  );
  // A manual reader's visible heading below expanding code stays at the same viewport offset.
  await page.setViewportSize({ width: 280, height: 700 });
  const many = [
    ...messages.slice(0, 2),
    { id: "marker", role: "user", html: "<p>Reading marker.</p>" },
    { id: "tail", role: "assistant", html: renderSafeMarkdown("Tail.\n\n".repeat(100)) },
  ];
  await state({ messages: many });
  const marker = page.locator("#messages > article").nth(2).locator("h2");
  await marker.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(60);
  // Focus can scroll a partially covered heading. Measure after focus to isolate the wrapping operation.
  await marker.focus();
  const beforeTop = await marker.evaluate((node) => node.getBoundingClientRect().top);
  // DOM activation avoids browser auto-scroll of the toolbar; focus remains in the message.
  const wrapBefore = await page.evaluate(() => ({
    pinned: conversationPinnedToBottom,
    top: conversationElement.scrollTop,
    edge:
      conversationElement.getBoundingClientRect().top +
      document.getElementById("transcript-controls").getBoundingClientRect().height,
    anchors: Array.from(messagesElement.querySelectorAll("pre, p, .role"))
      .map((node) => ({
        tag: node.tagName,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
      }))
      .filter((item) => item.bottom > conversationElement.getBoundingClientRect().top)
      .slice(0, 4),
  }));
  await toggle.evaluate((node) => node.click());
  assert.ok(
    Math.abs((await marker.evaluate((node) => node.getBoundingClientRect().top)) - beforeTop) <= 2,
    JSON.stringify({
      beforeTop,
      wrapBefore,
      after: await page.evaluate(() => ({ pinned: conversationPinnedToBottom, top: conversationElement.scrollTop })),
    }),
  );
  assert.equal(await marker.evaluate((node) => document.activeElement === node), true);
  const readingTop = await marker.evaluate((node) => node.getBoundingClientRect().top);
  await toggle.click();
  assert.ok(
    Math.abs((await marker.evaluate((node) => node.getBoundingClientRect().top)) - readingTop) <= 2,
    "the sticky toolbar can change wrapping without moving an off-bottom reader",
  );
  assert.equal(await toggle.evaluate((node) => document.activeElement === node), true);
  assert.deepEqual(errors, []);
  await page.close();
  return {
    ...evidence,
    themes: 4,
    layouts: 24,
    headingIdentity: "retained",
    hints: "capability-aware",
    readingPosition: "retained",
  };
}
