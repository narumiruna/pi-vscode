import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { chromium } from "playwright-core";
import { assertRichContent, richFixture } from "./rich-content-fixture.mjs";

const require = createRequire(import.meta.url);
const { getSidebarHtml } = require("../out/sidebarHtml.js");
const { renderSafeMarkdown } = require("../out/markdown.js");
const server = createServer(async (request, response) => {
  try {
    const name = request.url?.slice(1) ?? "";
    if (!/^(?:rich-content\.(?:js|css)|fonts\/KaTeX_[A-Za-z0-9_-]+\.(?:woff2?|ttf))$/.test(name)) {
      response.writeHead(404).end();
      return;
    }
    response.setHeader(
      "Content-Type",
      name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "font/woff2",
    );
    response.end(await readFile(`out/rich-content/${name}`));
  } catch {
    response.writeHead(500).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 600, height: 800 } });
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    if (!route.request().url().startsWith(origin)) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  const html = getSidebarHtml(100000, 5000000, {
    source: origin,
    script: `${origin}/rich-content.js`,
    style: `${origin}/rich-content.css`,
  });
  // The browser runner uses the real sidebar document and renderer; only VS Code IPC is simulated.
  await page.addInitScript(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
  });
  await page.goto(origin);
  await page.evaluate(() => {
    window.acquireVsCodeApi = () => ({ postMessage() {} });
  });
  await page.setContent(html);
  await page.waitForFunction(() => Boolean(window.piRichContent));
  await page.evaluate(() => {
    window.violations = [];
    document.addEventListener("securitypolicyviolation", (event) => window.violations.push(event.violatedDirective));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "showSessionDetail" } }));
  });
  const send = (markdown) =>
    page.evaluate((rendered) => {
      window.dispatchEvent(
        new MessageEvent("message", {
          data: {
            type: "state",
            status: "Ready",
            runtime: { connected: true, busy: false },
            messages: [{ id: "answer", role: "assistant", html: rendered }],
          },
        }),
      );
    }, renderSafeMarkdown(markdown));
  await send(richFixture);
  const evidence = await assertRichContent(page).catch(async (error) => {
    console.error(errors, await page.locator(".content").innerHTML());
    throw error;
  });
  for (const name of ["vscode-light", "vscode-dark", "vscode-high-contrast", "vscode-high-contrast-light"]) {
    await page.evaluate((value) => {
      document.body.className = value;
    }, name);
    await page.locator(".mermaid-preview svg").nth(1).waitFor();
    for (const width of [280, 900]) {
      await page.setViewportSize({ width, height: 800 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  const longCell = "x".repeat(300);
  await send(`| Long |\n| --- |\n| ${longCell} |\n\n\`\`\`unknown\n${longCell}\n\`\`\`\n\n$$${"x+".repeat(150)}y$$`);
  await page.setViewportSize({ width: 280, height: 800 });
  for (const selector of [".content table", ".content pre", ".content .katex-display"]) {
    const geometry = await page
      .locator(selector)
      .evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
        overflow: getComputedStyle(element).overflowX,
      }));
    assert.equal(geometry.overflow, "auto");
    assert.ok(geometry.client <= 280);
    assert.ok(geometry.scroll > geometry.client, `${selector} must retain horizontally scrollable content`);
  }
  await send(richFixture);
  await page.locator(".mermaid-preview svg").nth(1).waitFor();
  // Tab navigation is real browser focus, not a fake-DOM assertion.
  await page.locator(".content a").focus();
  assert.equal(await page.evaluate(() => document.activeElement?.textContent), "Documentation");
  await page.keyboard.press("Tab");
  assert.notEqual(await page.evaluate(() => document.activeElement?.textContent), "Documentation");
  await send(richFixture + "\n\n" + Array.from({ length: 30 }, (_, i) => `Paragraph ${i}.`).join("\n\n"));
  await page.locator(".mermaid-preview svg").nth(1).waitFor();
  await page.locator("#conversation").hover();
  await page.mouse.wheel(0, -10000);
  await page.waitForTimeout(100);
  await page.locator("#conversation").evaluate((element) => {
    element.scrollTop = 0;
  });
  await send(richFixture + "\n\n" + "More output.\n\n".repeat(40));
  await page.locator(".mermaid-preview svg").nth(1).waitFor();
  assert.equal(await page.locator("#conversation").evaluate((element) => element.scrollTop), 0);
  assert.deepEqual(await page.evaluate(() => window.violations), []);
  const rejected = [
    "flowchart LR\nA[Broken",
    'pie\n"Unsupported type": 1',
    `flowchart LR\n${Array.from({ length: 101 }, (_, i) => `N${i}-->N${i + 1}`).join("\n")}`,
    "flowchart LR\nclick A callback",
    "%%{init:{securityLevel:'loose'}}%%\nflowchart LR\nA-->B",
    "flowchart LR\nclassDef x fill:url(https://bad.invalid/x)",
    "flowchart LR\nA[<img src=x onerror=alert(1)>]",
    "flowchart LR\n" + "A-->B\n".repeat(121),
    "flowchart LR\nA[" + "x".repeat(8001) + "]",
  ];
  for (const source of rejected) {
    await send(`\`\`\`mermaid\n${source}\n\`\`\``);
    await page.waitForTimeout(50);
    assert.equal(await page.locator(".mermaid-preview").count(), 0);
    assert.ok((await page.locator(".content code").textContent()).length);
    assert.equal(await page.locator('.mermaid-source[aria-label="Diagram not rendered; source follows"]').count(), 1);
  }
  await send(
    '<img src="https://bad.invalid/a" onerror="window.attacked=true"><script>window.attacked=true</script>\n\n[bad](javascript:alert(1))\n\n$\\includegraphics{https://bad.invalid/a}$',
  );
  assert.equal(await page.locator(".content script, .content img, .content a").count(), 0);
  assert.deepEqual(await page.evaluate(() => window.violations), []);
  // Defense in depth: even a direct untrusted HTML insertion is sanitized. CSP can report rejected event attributes while the sanitizer parses them.
  await page.evaluate(() =>
    window.piRichContent.setContent(
      document.querySelector(".content"),
      '<svg onload="window.attacked=true"><a href="javascript:alert(1)">x</a></svg><img src="https://bad.invalid/a" onerror="window.attacked=true"><script>window.attacked=true</script>',
      () => {},
    ),
  );
  assert.equal(await page.evaluate(() => Boolean(window.attacked)), false);
  assert.equal(await page.locator(".content script, .content img, .content [onload], .content [onerror]").count(), 0);
  assert.deepEqual(external, []);
  assert.deepEqual(errors, []);
  assert.ok((await page.evaluate(() => window.violations)).every((value) => value === "script-src-attr"));
  // Test script CSP independently from HTML sanitization.
  await page.evaluate(() => {
    const script = document.createElement("script");
    script.textContent = "window.attacked=true";
    document.body.append(script);
  });
  await page.waitForTimeout(50);
  assert.equal(await page.evaluate(() => Boolean(window.attacked)), false);
  assert.ok((await page.evaluate(() => window.violations)).some((value) => value.startsWith("script-src")));
  console.log("PI_RICH_BROWSER_EVIDENCE", JSON.stringify(evidence));

  // A delayed Mermaid stub proves races, cache reuse and disposal deterministically.
  const stub = await build({
    entryPoints: ["src/webview/richContent.mts"],
    bundle: true,
    write: false,
    format: "iife",
    plugins: [
      {
        name: "delayed-mermaid",
        setup(build) {
          build.onResolve({ filter: /^mermaid$/ }, () => ({ path: "mermaid", namespace: "test" }));
          build.onLoad({ filter: /.*/, namespace: "test" }, () => ({
            contents: `export default { initialize(){}, render(id, source){ window.renderCount=(window.renderCount||0)+1; return new Promise(resolve=>{ window.finishDiagram=()=>resolve({svg:'<svg xmlns="http://www.w3.org/2000/svg" id="'+id+'"><style>#'+id+'{color:red}</style><text>'+source.replaceAll('&','&amp;').replaceAll('<','&lt;')+'</text><image href="https://bad.invalid/a"/><set onbegin="window.attacked=true"/></svg>'}); if(window.autoFinish) queueMicrotask(window.finishDiagram); }); } };`,
          }));
        },
      },
    ],
  });
  const race = await browser.newPage();
  await race.setContent('<div class="content"></div>');
  await race.addScriptTag({ content: stub.outputFiles[0].text });
  const diagram = renderSafeMarkdown("```mermaid\nflowchart LR\nA-->B\n```");
  await race.evaluate(
    (value) => window.piRichContent.setContent(document.querySelector(".content"), value, () => {}),
    diagram,
  );
  await race.waitForFunction(() => Boolean(window.finishDiagram));
  await race.evaluate(() => {
    window.piRichContent.setContent(document.querySelector(".content"), "<p>Updated</p>", () => {});
    window.finishDiagram();
  });
  await race.waitForTimeout(20);
  assert.equal(await race.locator(".mermaid-preview").count(), 0);
  await race.evaluate(
    (value) => window.piRichContent.setContent(document.querySelector(".content"), value, () => {}),
    diagram,
  );
  assert.equal(await race.locator(".mermaid-preview").count(), 1);
  assert.equal(await race.evaluate(() => window.renderCount), 1, "unchanged diagrams use bounded cache");
  assert.equal(await race.locator("image, set, [onbegin]").count(), 0);
  await race.evaluate((value) => {
    const replacement = document.createElement("div");
    replacement.className = "content";
    window.piRichContent.setContent(replacement, value, () => {});
    document.querySelector(".content").replaceWith(replacement);
  }, diagram);
  await race.locator(".mermaid-preview svg").waitFor();
  assert.equal(
    await race.evaluate(() => window.renderCount),
    1,
    "cached diagrams also render on detached replacement nodes",
  );
  // Replacement and disposal while a second render is in flight cannot insert output.
  await race.evaluate(
    (value) => window.piRichContent.setContent(document.querySelector(".content"), value, () => {}),
    renderSafeMarkdown("```mermaid\nflowchart LR\nC-->D\n```"),
  );
  await race.waitForFunction(() => window.renderCount === 2);
  await race.evaluate(() => {
    const content = document.querySelector(".content");
    content.remove();
    window.finishDiagram();
  });
  await race.waitForTimeout(20);
  assert.equal(await race.locator(".mermaid-preview").count(), 0);
  await race.evaluate((value) => {
    const content = document.createElement("div");
    content.className = "content";
    document.body.append(content);
    window.piRichContent.setContent(content, value, () => {});
  }, renderSafeMarkdown("```mermaid\nflowchart LR\nE-->F\n```"));
  await race.waitForFunction(() => window.renderCount === 3);
  await race.evaluate(() => {
    window.piRichContent.dispose();
    window.finishDiagram();
  });
  await race.waitForTimeout(20);
  assert.equal(await race.locator(".mermaid-preview").count(), 0);
  const bounded = await browser.newPage();
  await bounded.setContent('<div class="content"></div>');
  await bounded.addScriptTag({ content: stub.outputFiles[0].text });
  const blocks = Array.from({ length: 110 }, (_, index) =>
    renderSafeMarkdown(`\`\`\`mermaid\nflowchart LR\nN${index}-->Z\n\`\`\``),
  ).join("");
  await bounded.evaluate((value) => {
    window.autoFinish = true;
    window.piRichContent.setContent(document.querySelector(".content"), value, () => {});
  }, blocks);
  await bounded.waitForFunction(() => window.renderCount === 100);
  await bounded.locator(".mermaid-preview svg").nth(99).waitFor();
  assert.equal(await bounded.locator(".mermaid-source").count(), 110);
  assert.equal(await bounded.locator(".mermaid-preview").count(), 100, "queue limit retains excess blocks as source");
  const rerender = (index) =>
    bounded.evaluate(
      (value) => window.piRichContent.setContent(document.querySelector(".content"), value, () => {}),
      renderSafeMarkdown(`\`\`\`mermaid\nflowchart LR\nN${index}-->Z\n\`\`\``),
    );
  await rerender(99);
  await bounded.locator(".mermaid-preview svg").waitFor();
  assert.equal(await bounded.evaluate(() => window.renderCount), 100, "recent entry is cached");
  await rerender(0);
  await bounded.waitForFunction(() => window.renderCount === 101);
  assert.equal(await bounded.locator(".mermaid-preview").count(), 1, "old entry is evicted from the 64-entry cache");
  console.log("PI_RICH_LIFECYCLE cache eviction, queue bound, stale update, detached session, disposal: passed");
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
