import assert from "node:assert/strict";

// Real sidebar HTML, bundled rich renderer and Chromium layout; only VS Code IPC is simulated.
export async function assertPanelInteractions(browser, html, renderSafeMarkdown, origin) {
  const evidence = {};
  const errors = [];
  const external = [];
  const pages = [];
  const open = async () => {
    const page = await browser.newPage({ viewport: { width: 420, height: 700 } });
    pages.push(page);
    page.on("pageerror", (error) => errors.push(String(error)));
    await page.route("**/*", (route) => {
      if (!route.request().url().startsWith(`${origin}/`)) {
        external.push(route.request().url());
        return route.abort();
      }
      return route.continue();
    });
    await page.evaluate(() => {
      window.panelPosted = [];
      window.acquireVsCodeApi = () => ({ postMessage(message) { window.panelPosted.push(message); } });
    });
    await page.setContent(html);
    await page.waitForFunction(() => Boolean(window.piRichContent));
    await post(page, { type: "showSessionDetail" });
    return page;
  };
  const state = (messages) => ({
    type: "state",
    status: "Ready",
    runtime: { connected: true, busy: false },
    messages,
  });
  const message = (id, markdown) => ({ id, role: "assistant", html: renderSafeMarkdown(markdown) });
  try {
    const history = await open();
    const batch = [
      message("history-diagram-1", "```mermaid\nflowchart TD\nA-->B\n```"),
      message("history-prose", "A message after the first diagram."),
      message("history-diagram-2", "```mermaid\nflowchart LR\nC-->D\n```"),
    ];
    await post(history, state(batch));
    await history.waitForFunction(() => {
      const articles = document.querySelectorAll("#messages article");
      return articles.length === 3 && articles[0].querySelector(".mermaid-preview svg")
        && articles[2].querySelector(".mermaid-preview svg");
    });
    await history.evaluate(() => {
      window.historyDiagrams = Array.from(document.querySelectorAll("#messages .mermaid-preview svg"));
    });
    await post(history, state(batch));
    await post(history, state([
      ...batch,
      message("appended-diagram", "```mermaid\nflowchart TD\nE-->F\n```"),
      message("appended-prose", "A message after the appended diagram."),
    ]));
    await history.waitForFunction(() => document.querySelectorAll("#messages .mermaid-preview svg").length === 3);
    evidence.historyBatch = await history.evaluate(() => ({
      diagrams: document.querySelectorAll("#messages .mermaid-preview svg").length,
      existingDiagramsRetained: window.historyDiagrams.every((svg, index) =>
        document.querySelectorAll("#messages .mermaid-preview svg")[index] === svg),
    }));
    assert.equal(evidence.historyBatch.diagrams, 3, "initial and appended batches must render every diagram");
    assert.equal(evidence.historyBatch.existingDiagramsRetained, true, "later batches must retain completed diagrams");

    const page = await open();
    const older = message("older", "Selected passage must remain selected.\n\n" + "Older paragraph.\n\n".repeat(60));
    await post(page, state([older]));
    await pauseFollowing(page, 240);
    await page.evaluate(() => {
      window.retainedArticle = document.querySelector("#messages article");
      window.retainedContent = window.retainedArticle.querySelector(".content");
      const text = window.retainedContent.querySelector("p").firstChild;
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, "Selected passage".length);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      window.retainedSelectionNode = text;
    });
    await post(page, state([older, message("appended", "New answer below the reading position.")]));
    await settle(page);
    evidence.append = await page.evaluate(() => ({
      articleRetained: document.querySelector("#messages article") === window.retainedArticle,
      contentRetained: document.querySelector("#messages article .content") === window.retainedContent,
      selectionNodeRetained: getSelection().anchorNode === window.retainedSelectionNode,
      selectedText: getSelection().toString(),
      top: document.querySelector("#conversation").scrollTop,
    }));

    // A completed tall diagram has more height than its source-only fallback.
    // Hold renderer microtasks during append, then release them. This makes the
    // shrink/restore race deterministic without replacing Mermaid or DOM layout.
    const rich = await open();
    const diagram = message("diagram", "```mermaid\nflowchart TD\n" +
      Array.from({ length: 12 }, (_, i) => `N${i}-->N${i + 1}`).join("\n") + "\n```");
    await post(rich, state([diagram]));
    await rich.locator(".mermaid-preview svg").waitFor();
    await settle(rich);
    await pauseFollowing(rich, 360);
    const before = await geometry(rich);
    assert.ok(before.top > 100, "fixture must start away from the top");
    assert.ok(before.height - before.top - before.client > 80, "fixture must start off the bottom");
    await rich.evaluate(() => {
      window.retainedDiagram = document.querySelector(".mermaid-preview svg");
      window.richTasks = [];
      window.originalQueueMicrotask = window.queueMicrotask;
      window.queueMicrotask = (task) => window.richTasks.push(task);
    });
    await post(rich, state([diagram, message("after-diagram", "```mermaid\nflowchart LR\nX-->Y\n```")]));
    const during = await geometry(rich);
    const delayed = await rich.evaluate(() => ({
      tasks: window.richTasks.length,
      previews: document.querySelectorAll(".mermaid-preview svg").length,
    }));
    await rich.evaluate(() => {
      window.queueMicrotask = window.originalQueueMicrotask;
      for (const task of window.richTasks.splice(0)) window.queueMicrotask(task);
    });
    await rich.locator(".mermaid-preview svg").nth(1).waitFor();
    await settle(rich);
    evidence.richAppend = {
      before,
      during,
      delayed,
      after: await geometry(rich),
      diagramRetained: await rich.evaluate(() => document.querySelector(".mermaid-preview svg") === window.retainedDiagram),
    };

    // A delayed acceptance must retain transcript focus. An acceptance from
    // Send must return focus to the composer without moving the document.
    const focus = await open();
    await post(focus, state([older]));
    await post(focus, { type: "setInput", text: "Draft to clear" });
    await pauseFollowing(focus, 240);
    await focus.locator("#messages .role").first().evaluate((node) => {
      window.retainedHeading = node;
      node.focus({ preventScroll: true });
    });
    const focusBefore = await geometry(focus);
    await post(focus, state([older, message("new-message", "New message while reading older text.")]));
    await post(focus, { type: "clearInput", expectedText: "Draft to clear" });
    await settle(focus);
    evidence.focus = {
      before: focusBefore,
      after: await geometry(focus),
      headingRetained: await focus.evaluate(() => document.querySelector("#messages .role") === window.retainedHeading),
      headingFocused: await focus.evaluate(() => document.activeElement === window.retainedHeading),
      inputValue: await focus.locator("#input").inputValue(),
    };
    await post(focus, { type: "setInput", text: "Second draft to clear" });
    await focus.locator("#send").evaluate((node) => node.focus({ preventScroll: true }));
    const sendBefore = await geometry(focus);
    await post(focus, { type: "clearInput", expectedText: "Second draft to clear" });
    await settle(focus);
    evidence.sendFocus = {
      before: sendBefore,
      after: await geometry(focus),
      inputFocused: await focus.locator("#input").evaluate((node) => node === document.activeElement),
    };

    const clipboard = await open();
    const output = "Literal <output> 日本語\nSecond line";
    await post(clipboard, {
      ...state([]),
      runtime: { connected: true, busy: true },
      tools: [{ id: "copy-tool", name: "bash", status: "running", input: "printf fixture", output }],
    });
    const outputSection = clipboard.locator(".tool-section").filter({ has: clipboard.getByRole("button", { name: "Copy Output", exact: true }) });
    const copy = outputSection.getByRole("button", { name: "Copy Output", exact: true });
    const feedback = outputSection.locator('[role="status"]');
    await copy.click();
    const request = await clipboard.evaluate(() => window.panelPosted.find((item) => item.type === "copyText"));
    assert.equal(request.text, output, "Copy must send literal retained tool output through host IPC");
    assert.equal(await copy.isDisabled(), true);
    await post(clipboard, { type: "copyTextResult", requestId: request.requestId + 1, ok: true });
    assert.equal(await feedback.textContent(), "", "an unrelated copy result must not acknowledge this request");
    await post(clipboard, { type: "copyTextResult", requestId: request.requestId, ok: true });
    assert.equal(await feedback.textContent(), "Output copied");
    assert.equal(await copy.isEnabled(), true);
    await copy.click();
    const failedRequest = await clipboard.evaluate(() => window.panelPosted.filter((item) => item.type === "copyText").at(-1));
    await post(clipboard, { type: "copyTextResult", requestId: failedRequest.requestId, ok: false });
    assert.match(await feedback.textContent(), /Copy failed/);

    // Synthetic ClipboardEvents exercise browser DataTransfer and FileReader,
    // not the OS clipboard or Chromium's trusted native text insertion.
    const paste = (text, lock = "") => clipboard.evaluate(({ text, lock }) => {
      const input = document.querySelector("#input");
      input.readOnly = lock === "readonly";
      input.disabled = lock === "disabled";
      const data = new DataTransfer();
      if (text) data.setData("text/plain", text);
      const bytes = Uint8Array.from(atob("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw=="), (char) => char.charCodeAt(0));
      data.items.add(new File([bytes], "fixture.gif", { type: "image/gif" }));
      const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data });
      input.dispatchEvent(event);
      return { prevented: event.defaultPrevented, text: event.clipboardData.getData("text/plain") };
    }, { text, lock });
    const mixed = await paste("Accompanying text 日本語");
    assert.equal(mixed.prevented, false, "mixed image/text paste must leave native text insertion enabled");
    assert.equal(mixed.text, "Accompanying text 日本語");
    await clipboard.waitForFunction(() => window.panelPosted.filter((item) => item.type === "pasteImage").length === 1);
    const image = await clipboard.evaluate(() => window.panelPosted.find((item) => item.type === "pasteImage"));
    assert.equal(image.mimeType, "image/gif");
    assert.equal(image.fileName, "fixture.gif");
    assert.equal(image.data, "R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==");
    assert.equal((await paste("")).prevented, true, "image-only paste must suppress native insertion");
    await clipboard.waitForFunction(() => window.panelPosted.filter((item) => item.type === "pasteImage").length === 2);
    assert.equal((await paste("Locked text", "readonly")).prevented, true);
    assert.equal((await paste("Locked text", "disabled")).prevented, true);
    await settle(clipboard);
    assert.equal(await clipboard.evaluate(() => window.panelPosted.filter((item) => item.type === "pasteImage").length), 2);
    evidence.clipboard = { copyIpc: true, correlatedResults: true, failureFeedback: true,
      mixedPasteDefaultAllowed: true, imageFileReader: true, captureLocks: true, nativeClipboard: "not run" };

    console.log("PI_PANEL_INTERACTION_MEASUREMENTS", JSON.stringify(evidence));
    assert.deepEqual(errors, []);
    assert.deepEqual(external, []);
    assert.equal(evidence.append.articleRetained, true, "append must retain the existing message article");
    assert.equal(evidence.append.contentRetained, true, "append must retain completed content nodes");
    assert.equal(evidence.append.selectionNodeRetained, true, "append must retain the selection anchor node");
    assert.equal(evidence.append.selectedText, "Selected passage", "append must retain selected transcript text");
    assert.equal(evidence.append.top, 240, "append must retain the off-bottom reading position");
    assert.ok(delayed.tasks > 0, "fixture must delay actual rich-renderer work");
    assert.equal(delayed.previews, 1, "the old preview must remain while the new diagram is pending");
    assert.equal(evidence.richAppend.diagramRetained, true, "append must not rebuild a completed Mermaid SVG");
    assert.equal(during.top, before.top, "source-only fallback must not clamp the reading position during append");
    assert.equal(evidence.richAppend.after.top, before.top, "delayed rich layout must not reset the reading position");
    assert.equal(evidence.focus.headingRetained, true, "append must retain the focused heading node");
    assert.equal(evidence.focus.headingFocused, true, "delayed acceptance must not take focus from transcript text");
    assert.equal(evidence.focus.inputValue, "");
    assert.equal(evidence.focus.after.top, focusBefore.top, "accepted send focus must not move the transcript");
    assert.equal(evidence.focus.after.pageTop, focusBefore.pageTop, "accepted send focus must not scroll the document");
    assert.equal(evidence.focus.after.pageLeft, focusBefore.pageLeft, "accepted send focus must not scroll horizontally");
    assert.equal(evidence.sendFocus.inputFocused, true, "Send acceptance must return focus to the composer");
    assert.equal(evidence.sendFocus.after.top, sendBefore.top, "Send acceptance must not move the transcript");
    assert.equal(evidence.sendFocus.after.pageTop, sendBefore.pageTop, "Send acceptance must not scroll the document");
    return evidence;
  } finally {
    await Promise.all(pages.map((page) => page.close()));
  }
}

async function post(page, data) {
  await page.evaluate((value) => window.dispatchEvent(new MessageEvent("message", { data: value })), data);
}

async function settle(page) {
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

async function pauseFollowing(page, top) {
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -10000);
  await settle(page);
  await page.locator("#conversation").evaluate((node, value) => { node.scrollTop = value; }, top);
  await settle(page);
}

async function geometry(page) {
  return page.locator("#conversation").evaluate((node) => ({
    top: node.scrollTop,
    height: node.scrollHeight,
    client: node.clientHeight,
    pageTop: window.scrollY,
    pageLeft: window.scrollX,
  }));
}
