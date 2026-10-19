import assert from "node:assert/strict";

/** Shared assertions use only Page/Frame APIs, including the native webview Frame. */
export async function assertDiscoveryWrap(frame, toggleWrapping) {
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
  const wrapped = () => frame.locator("#messages").evaluate((node) => node.classList.contains("wrap-code"));
  assert.equal(await frame.locator("#wrap-code, #transcript-controls").count(), 0);
  assert.equal(await wrapped(), false);
  await toggleWrapping({ key: "Space" });
  assert.equal(await wrapped(), true);
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
  await toggleWrapping({ key: "Enter" });
  assert.equal(await wrapped(), false);
  assert.equal(await copyText(), wrappedCopy, "copy selection is independent of wrapping");
  assert.deepEqual(await snapshot(), before);
  return { headings: labels.length, keyboard: "Space/Enter", sourceAndCopy: "unchanged" };
}

async function assertResponsiveHeader(page, state, post) {
  const ids = ["new-session", "delete-session", "history-search-open", "history-earlier", "history-latest", "more"];
  const themes = ["vscode-dark", "vscode-light", "vscode-high-contrast", "vscode-high-contrast-light"];
  // Native 200% zoom also exposes a 169 CSS-pixel sidebar viewport.
  const widths = [169, 200, 240, 280, 340, 600, 960];
  const history = {
    generation: 10,
    mode: "earlier",
    start: 0,
    end: 3,
    total: 6,
    omittedBefore: 0,
    omittedAfter: 3,
    available: true,
    loading: false,
    canNavigate: true,
  };
  for (const theme of themes) {
    await page.evaluate((theme) => {
      document.body.className = theme;
      const light = theme.endsWith("light");
      for (const [key, value] of Object.entries({
        foreground: light ? "#000000" : "#ffffff",
        descriptionForeground: light ? "#000000" : "#ffffff",
        "sideBar-background": light ? "#ffffff" : "#000000",
        focusBorder: light ? "#000000" : "#ffffff",
        contrastBorder: light ? "#000000" : "#ffffff",
      }))
        document.body.style.setProperty(`--vscode-${key}`, value);
    }, theme);
    for (const width of widths) {
      await page.setViewportSize({ width, height: 700 });
      for (const title of ["Short title", "Long session title 日本語 🐈 ".repeat(30)]) {
        await state({
          runtime: { connected: true, busy: false, sessionId: "header", sessionFile: "/fixture/header.jsonl" },
          sessions: [{ id: "header", title, current: true }],
          history,
        });
        assert.equal(await page.locator("#session-header-title").innerText(), title.trim());
        assert.deepEqual(
          await page.locator(".sessions-actions > button").evaluateAll((nodes) => nodes.map((node) => node.id)),
          ids,
        );
        for (const id of ids) {
          const button = page.locator(`#${id}`);
          assert.equal(await button.count(), 1, `${id} must be unique`);
          assert.equal(await button.isVisible(), true);
          assert.ok(await button.getAttribute("aria-label"), `${id} needs an accessible name`);
          assert.ok(await button.getAttribute("title"), `${id} needs a tooltip`);
          assert.equal(await button.locator("svg").count(), 1);
          assert.equal(await button.locator("svg").getAttribute("aria-hidden"), "true");
          assert.equal(await button.locator("svg").getAttribute("focusable"), "false");
        }
        const geometry = await page.locator(".sessions-header").evaluate((header) => {
          const rect = (node) => node.getBoundingClientRect().toJSON();
          return {
            title: rect(header.querySelector(".sessions-title")),
            actions: rect(header.querySelector(".sessions-actions")),
            buttons: Array.from(header.querySelectorAll(".sessions-actions button"), rect),
            viewport: innerWidth,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        const context = `${theme} ${width}px ${title.length} characters: ${JSON.stringify(geometry)}`;
        assert.equal(geometry.overflow, false, context);
        const overlaps = (a, b) =>
          a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
        assert.equal(overlaps(geometry.title, geometry.actions), false, context);
        for (let index = 0; index < geometry.buttons.length; index += 1) {
          const button = geometry.buttons[index];
          assert.ok(button.width > 0 && button.left >= 0 && button.right <= geometry.viewport, context);
          if (index) assert.equal(overlaps(geometry.buttons[index - 1], button), false, context);
        }
        if (width <= 240)
          assert.ok(geometry.actions.top >= geometry.title.bottom - 1, `narrow header uses a second row: ${context}`);
        await post({ type: "showSessionsLayer" });
        for (const id of ids.slice(2, 5)) assert.equal(await page.locator(`#${id}`).isVisible(), false);
        await post({ type: "showSessionDetail" });
      }
    }
  }
  // Earlier mode makes all navigation controls available for the real Tab sequence.
  await state({
    runtime: { connected: true, busy: false, sessionId: "header", sessionFile: "/fixture/header.jsonl" },
    history: { ...history, omittedBefore: 3 },
  });
  await page.locator("#new-session").focus();
  for (const id of ids.slice(1)) {
    await page.keyboard.press("Tab");
    assert.equal(await page.locator(`#${id}`).evaluate((node) => document.activeElement === node), true);
    const focus = await page.locator(`#${id}`).evaluate((node) => ({
      style: getComputedStyle(node).outlineStyle,
      width: getComputedStyle(node).outlineWidth,
    }));
    assert.notEqual(focus.style, "none");
    assert.notEqual(focus.width, "0px");
  }
  await state({
    runtime: { connected: true, busy: false, sessionId: "header", sessionFile: "/fixture/header.jsonl" },
    history: { ...history, mode: "latest", omittedBefore: 3, omittedAfter: 0 },
  });
  const latest = page.locator("#history-latest");
  assert.equal(await latest.isDisabled(), true);
  const disabledStyle = await latest.evaluate((node) => ({
    opacity: Number(getComputedStyle(node).opacity),
    visibility: getComputedStyle(node).visibility,
  }));
  assert.ok(disabledStyle.opacity > 0, "disabled latest action remains visible");
  assert.equal(disabledStyle.visibility, "visible");
  await page.locator("#history-earlier").focus();
  await page.keyboard.press("Tab");
  assert.equal(await page.locator("#more").evaluate((node) => document.activeElement === node), true);
  await state();
  return {
    themes: themes.length,
    widths,
    titles: 2,
    layouts: themes.length * widths.length * 2,
    keyboard: "header Tab order and disabled skip",
  };
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
  const hint = page.locator("#conversation-details #file-discovery-hint");
  assert.equal(await hint.isVisible(), false, "file discovery instructions are not persistent composer chrome");
  await page.locator("#more").focus();
  await page.keyboard.press("Enter");
  assert.equal(await page.evaluate(() => window.fixturePosts.at(-1).type), "showMoreActions");
  await post({ type: "showConversationDetails" });
  assert.equal(await page.locator("#conversation-details").evaluate((dialog) => dialog.open), true);
  assert.equal(await hint.isVisible(), true);
  assert.match(await hint.innerText(), /@ selects a file snapshot/);
  assert.match(await hint.innerText(), /Tab on a visible path suggestion inserts only its path/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => document.activeElement.id === "more");
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
    assert.match(await hint.textContent(), /unavailable for shell input and slash commands/);
  }
  await page.locator("#input").fill("");
  for (const reason of [
    "File completion requires a trusted workspace.",
    "File completion requires a file-backed workspace.",
    "File completion requires a workspace matching the Pi working directory.",
  ]) {
    await state({ fileCompletionSupport: { available: false, reason } });
    assert.equal(await hint.textContent(), reason);
    assert.doesNotMatch(await hint.textContent(), /@ selects|Tab on/);
  }
  await state();
  const wrapped = () => page.locator("#messages").evaluate((node) => node.classList.contains("wrap-code"));
  const toggleWrapping = async ({ key, preserveFocus = false } = {}) => {
    const before = await wrapped();
    const postsBefore = await page.evaluate(() => window.fixturePosts.length);
    const more = page.locator("#more");
    if (key) {
      await more.focus();
      await more.press(key);
    } else if (preserveFocus) {
      // Activate the real More handler without browser focus/scroll changes.
      await more.evaluate((node) => node.click());
    } else await more.click();
    const posts = await page.evaluate((offset) => window.fixturePosts.slice(offset), postsBefore);
    assert.equal(posts.length, 1, "opening More must not submit the composer or request Pi");
    const request = posts[0];
    assert.deepEqual(Object.keys(request).sort(), ["codeWrapping", "revision", "text", "type"]);
    assert.equal(request.type, "showMoreActions");
    assert.equal(request.text, await page.locator("#input").inputValue());
    assert.ok(Number.isSafeInteger(request.revision));
    assert.equal(request.codeWrapping, before);
    assert.equal(await wrapped(), before, "opening or cancelling More alone does not toggle wrapping");
    await post({ type: "toggleCodeWrapping" });
    assert.equal(await wrapped(), !before, "the fixed host reply toggles local display state");
  };
  const evidence = await assertDiscoveryWrap(page, toggleWrapping);
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
  const headerEvidence = await assertResponsiveHeader(page, state, post);
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
        if (await wrapped()) await toggleWrapping();
        const pre = page.locator(".assistant .content pre").first();
        assert.equal(await pre.evaluate((node) => node.scrollWidth > node.clientWidth), true);
        const shellBefore = await page.locator(".shell pre").evaluate((node) => getComputedStyle(node).whiteSpace);
        const widgetBefore = await page
          .locator(".extension-ui-block pre")
          .evaluate((node) => getComputedStyle(node).whiteSpace);
        await toggleWrapping();
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
  assert.equal(await wrapped(), true);
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
  const scroller = page.locator("#conversation");
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await page.waitForTimeout(60);
  await toggleWrapping({ preserveFocus: true });
  assert.ok(
    await scroller.evaluate((node) => node.scrollHeight - node.clientHeight - node.scrollTop <= 2),
    "wrapping retains bottom following",
  );
  const marker = page.locator("#messages > article").nth(2).locator("h2");
  await marker.evaluate((node) => node.scrollIntoView({ block: "start" }));
  await page.waitForTimeout(60);
  // Focus can scroll a partially covered heading. Measure after focus to isolate the wrapping operation.
  await marker.focus();
  const beforeTop = await marker.evaluate((node) => node.getBoundingClientRect().top);
  // More IPC activation and the fixed host reply preserve a reader's focus and scroll.
  const wrapBefore = await page.evaluate(() => ({
    pinned: conversationPinnedToBottom,
    top: conversationElement.scrollTop,
    edge: conversationElement.getBoundingClientRect().top,
    anchors: Array.from(messagesElement.querySelectorAll("pre, p, .role"))
      .map((node) => ({
        tag: node.tagName,
        top: node.getBoundingClientRect().top,
        bottom: node.getBoundingClientRect().bottom,
      }))
      .filter((item) => item.bottom > conversationElement.getBoundingClientRect().top)
      .slice(0, 4),
  }));
  await toggleWrapping({ preserveFocus: true });
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
  await toggleWrapping();
  assert.ok(
    Math.abs((await marker.evaluate((node) => node.getBoundingClientRect().top)) - readingTop) <= 2,
    "the header menu can change wrapping without moving an off-bottom reader",
  );
  assert.equal(await page.locator("#more").evaluate((node) => document.activeElement === node), true);
  assert.deepEqual(errors, []);
  await page.close();
  return {
    ...evidence,
    themes: 4,
    layouts: 24,
    headingIdentity: "retained",
    hints: "capability-aware, inside Conversation details without automatic capture",
    readingPosition: "retained",
    wrapping: "More state IPC and fixed host reply",
    header: headerEvidence,
  };
}
