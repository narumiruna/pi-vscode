import assert from "node:assert/strict";

export async function assertStreamedRichContent(browser, html, render, origin) {
  async function open(blockMermaid = false) {
    const page = await browser.newPage({ viewport: { width: 570, height: 670 } });
    const requests = [];
    page.on("request", (request) => requests.push(request.url()));
    if (blockMermaid) {
      await page.route(`${origin}/mermaid.js`, (route) => route.fulfill({ status: 404, body: "not found" }));
    }
    await page.evaluate(() => {
      window.ready = 0;
      window.acquireVsCodeApi = () => ({ postMessage(message) { if (message.type === "ready") window.ready++; } });
    });
    await page.setContent(html);
    assert.equal(await page.evaluate(() => window.ready), 1);
    assert.ok(!requests.includes(`${origin}/mermaid.js`), "startup did not fetch Mermaid");
    assert.equal(await page.evaluate(() => window.piMermaid), undefined);
    let revision = 0;
    const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
    await post({ type: "showSessionDetail" });
    const state = (content) => post({ type: "state", transcriptRevision: ++revision, runtime: { connected: true, busy: true },
      messages: [{ id: "answer", role: "assistant", html: render(content), content }] });
    const tail = (content) => post({ type: "transcriptTailPatch", id: "answer", baseRevision: revision++, html: render(content), content });
    const loads = () => requests.filter((url) => url === `${origin}/mermaid.js`).length;
    return { page, state, tail, loads };
  }

  const opening = "```mermaid\nflowchart LR\nA[Stream A]-->B[Stream B]";
  const diagram = opening + "\n```";
  const { page, state, tail, loads } = await open();
  const content = page.locator("#messages .content");
  try {
    await state("Plain Markdown with $x^2$.");
    await content.locator(".katex").waitFor();
    await state("```mermaid\npie\n\"Not eligible\": 1\n```");
    assert.equal(await content.locator('.mermaid-source[aria-label="Diagram not rendered; source follows"]').count(), 1);
    const code = Array.from({ length: 500 }, (_, i) => `const marker${i} = ${i};`).join("\n");
    const prefix = `[Details](https://example.com)\n\n\`\`\`ts\n${code}\n\`\`\`\n\n`;
    await state(prefix + opening);
    assert.equal(await content.locator(".mermaid-source").count(), 0);
    assert.equal(loads(), 0, "plain, rejected and open-fence messages did not fetch Mermaid");
    await content.evaluate((target) => { window.streamCode = target.querySelector("pre"); });
    await tail(prefix + diagram);
    await content.locator(".mermaid-preview svg").waitFor();
    assert.equal(loads(), 1);
    assert.equal(await content.evaluate((target) => target.querySelector("pre") === window.streamCode), true);
    await content.evaluate((target) => { window.streamSvg = target.querySelector(".mermaid-preview svg"); });

    await page.locator("#history-search-open").click();
    await page.locator("#history-search-input").fill("Fresh streaming phrase");
    assert.equal(await page.locator("#history-search-count").innerText(), "No matches in this window.");
    const complete = prefix + diagram + "\n\nFresh streaming phrase.";
    await tail(complete);
    assert.match(await page.locator("#history-search-count").innerText(), /^1 of 1 in this window/);
    await page.locator("#history-search-input").fill("marker0");
    await page.locator("#history-search-input").press("Enter");
    await page.locator("#history-search-close").click();
    await content.locator("a").focus();
    const readingTop = await page.locator("#conversation").evaluate((target) => target.scrollTop);
    await content.evaluate((target) => {
      const range = document.createRange();
      range.selectNodeContents(target.querySelector(".hljs-keyword"));
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      window.streamRemoved = [];
      // Collect actual mutation records across asynchronous IPC updates.
      window.streamObserver = new MutationObserver((records) => {
        for (const record of records) window.streamRemoved.push(...record.removedNodes);
      });
      window.streamObserver.observe(target, { childList: true });
    });
    for (let i = 1; i <= 8; i++) await tail(complete + ".".repeat(i));
    assert.deepEqual(await content.evaluate((target) => ({
      code: target.querySelector("pre") === window.streamCode,
      svg: target.querySelector(".mermaid-preview svg") === window.streamSvg,
      selected: window.getSelection().toString(),
      focused: document.activeElement?.textContent,
      removed: window.streamRemoved.map((node) => node.nodeName),
      top: document.querySelector("#conversation").scrollTop,
    })), { code: true, svg: true, selected: "const", focused: "Details", removed: Array(8).fill("P"), top: readingTop });
    await content.evaluate(() => window.streamObserver.disconnect());
    assert.match(await content.locator(".mermaid-source code").textContent(), /A\[Stream A\]-->B\[Stream B\]/);
    assert.match(await content.locator(".language-ts").textContent(), /marker499/);
    await page.evaluate(() => { document.body.className = "vscode-dark"; });
    await page.waitForFunction(() => document.querySelector(".mermaid-preview svg") !== window.streamSvg);
    assert.equal(await content.evaluate((target) => target.querySelector("pre") === window.streamCode), true);
    assert.equal(loads(), 1, "theme changes do not reload the asset");

    const final = complete + "\n\n| Column |\n| --- |\n| Value |\n\n<img src=x onerror=alert(1)>";
    await tail(final);
    assert.equal(await content.locator("table td").textContent(), "Value");
    assert.equal(await content.locator("img, script, [onerror]").count(), 0);
    const snapshot = await content.evaluate((target, rendered) => {
      const full = document.createElement("div");
      window.piRichContent.setContent(full, rendered, () => {});
      const withoutPreview = target.cloneNode(true);
      withoutPreview.querySelector(".mermaid-preview").remove();
      return [withoutPreview.innerHTML, full.innerHTML];
    }, render(final));
    assert.equal(snapshot[0], snapshot[1], "retained source and tail equal a fully sanitized render");

    const unresolved = "[Docs][reference]\n\n```ts\nconst a = 1;\n```\n\nTail";
    await state(unresolved);
    await content.evaluate((target) => { window.oldCode = target.querySelector("pre"); });
    await tail(unresolved + "\n\n[reference]: https://example.com/path");
    assert.equal(await content.locator("a").getAttribute("href"), "https://example.com/path");
    assert.equal(await content.evaluate((target) => target.querySelector("pre") === window.oldCode), false,
      "full replacement when a later definition changes the earlier rendered prefix");
    await state(diagram);
    await content.locator(".mermaid-preview svg").waitFor();
    await tail(diagram + " invalid closer");
    assert.equal(await content.locator(".mermaid-source").count(), 0);
    assert.match(await content.locator("pre").textContent(), /``` invalid closer/);
    assert.equal(loads(), 1);
  } finally {
    await page.close();
  }

  const failure = await open(true);
  try {
    await failure.state(diagram);
    await failure.page.locator('.mermaid-source[aria-label="Diagram not rendered; source follows"]').waitFor();
    await failure.state(diagram.replace("Stream A", "After load failure"));
    await failure.page.locator('.mermaid-source[aria-label="Diagram not rendered; source follows"]').waitFor();
    assert.match(await failure.page.locator(".mermaid-source code").textContent(), /After load failure/);
    assert.equal(failure.loads(), 1, "load failure keeps source visible without retry");
  } finally {
    await failure.page.close();
  }
  return { mermaidLoads: 1, noDiagramAndOpenFenceLoads: 0, failedLoads: 1, completedBlocksRetained: true, shortDeltaReplacedNodes: 1 };
}
