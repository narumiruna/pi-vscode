import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { Session } from "node:inspector/promises";
import path from "node:path";
import { chromium } from "playwright-core";
import { browserPlatformArgs } from "./test-browser-platform.mjs";

// Run against the current build, or pass the path of a preserved baseline out/ directory.
const out = path.resolve(process.argv[2] ?? "out");
const require = createRequire(import.meta.url);
const { getSidebarHtml } = require(path.join(out, "sidebarHtml.js"));
const { MarkdownRenderer } = require(path.join(out, "markdown.js"));
const server = createServer(async (request, response) => {
  const name = request.url?.slice(1) ?? "";
  if (!/^(?:rich-content|mermaid)\.(?:js|css)$/.test(name)) return response.writeHead(404).end();
  try {
    const content = await readFile(path.join(out, "rich-content", name));
    response.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : "text/css");
    response.end(content);
  } catch {
    response.writeHead(404).end();
  }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = new Session();
profile.connect();
await profile.post("Profiler.enable");
let browser;
function stats(values) {
  const ordered = [...values].sort((a, b) => a - b);
  const at = (q) => Number(ordered[Math.ceil(q * ordered.length) - 1].toFixed(2));
  return { medianMs: at(0.5), p95Ms: at(0.95) };
}
try {
  browser = await chromium.launch({ headless: true, args: browserPlatformArgs() });
  const html = getSidebarHtml(100000, 5000000, {
    source: origin,
    script: `${origin}/rich-content.js`,
    style: `${origin}/rich-content.css`,
    mermaidScript: `${origin}/mermaid.js`,
  });
  async function open() {
    const page = await browser.newPage();
    const requests = [];
    page.on("request", (request) => {
      if (request.url().startsWith(origin + "/")) requests.push(request.url().slice(origin.length + 1));
    });
    await page.evaluate(() => {
      window.acquireVsCodeApi = () => ({ postMessage(message) {
        if (message.type === "ready") window.readyAt = performance.now();
      } });
      window.loadStart = performance.now();
    });
    await page.setContent(html);
    const readyMs = await page.evaluate(() => window.readyAt - window.loadStart);
    assert.ok(Number.isFinite(readyMs));
    return { page, requests, readyMs };
  }
  const cold = [];
  for (let i = 0; i < 12; i++) {
    const { page, requests, readyMs } = await open();
    cold.push(readyMs);
    await page.close();
    assert.ok(requests.includes("rich-content.js"));
    assert.ok(!requests.includes("mermaid.js"));
  }
  const code = Array.from({ length: 500 }, (_, index) => `const item${index}: string = "sample ${index}";`).join("\n");
  const results = [];
  for (const [name, prefix] of [
    ["long", `Intro.\n\n\`\`\`ts\n${code}\n\`\`\`\n\n\`\`\`mermaid\nflowchart LR\nA-->B\n\`\`\`\n\n`],
    ["small", ""],
  ]) {
    const renderer = new MarkdownRenderer();
    const { page, requests } = await open();
    const initial = prefix + "Tail";
    await page.evaluate(({ content, html }) => {
      const send = (data) => window.dispatchEvent(new MessageEvent("message", { data }));
      send({ type: "showSessionDetail" });
      send({ type: "state", status: "Ready", runtime: { connected: true, busy: true }, transcriptRevision: 1,
        messages: [{ id: "answer", role: "assistant", html, content }] });
    }, { content: initial, html: renderer.renderBatch([initial])[0] });
    if (name === "long") await page.locator(".mermaid-preview svg").waitFor();
    const updates = Array.from({ length: 35 }, (_, index) => initial + ".".repeat(index + 1));
    const hostTimes = [];
    const rendered = updates.map((content, index) => {
      const start = performance.now();
      const [html] = renderer.renderBatch([content]);
      hostTimes.push(performance.now() - start);
      return { type: "transcriptTailPatch", id: "answer", baseRevision: index + 1, content, html };
    });
    const countedRenderer = new MarkdownRenderer();
    countedRenderer.renderBatch([initial]);
    await profile.post("Profiler.startPreciseCoverage", { callCount: true });
    for (const source of updates) countedRenderer.renderBatch([source]);
    const { result } = await profile.post("Profiler.takePreciseCoverage");
    await profile.post("Profiler.stopPreciseCoverage");
    const count = (name) => result.filter((script) => script.url.endsWith("/markdown.js")).flatMap((script) => script.functions)
      .filter((fn) => fn.functionName === name).reduce((total, fn) => total + fn.ranges[0].count, 0);
    const measurements = await page.evaluate((patches) => {
      const durations = [];
      const content = document.querySelector(".content");
      const code = content.querySelector("pre");
      const preview = content.querySelector(".mermaid-preview svg");
      const observer = new MutationObserver(() => {});
      observer.observe(content, { childList: true });
      let removed = 0;
      for (const data of patches) {
        const start = performance.now();
        window.dispatchEvent(new MessageEvent("message", { data }));
        durations.push(performance.now() - start);
        for (const record of observer.takeRecords()) removed += record.removedNodes.length;
      }
      observer.disconnect();
      return { durations, removed, codeRetained: code !== null && code === content.querySelector("pre"),
        diagramRetained: preview !== null && preview === content.querySelector(".mermaid-preview svg") };
    }, rendered);
    const { durations, ...counts } = measurements;
    results.push({ name, browser: stats(durations.slice(5)), host: stats(hostTimes.slice(5)),
      highlights: count("highlight2"), fullMarkdownRenders: count("renderSafeMarkdown"), ...counts, requests });
    await page.close();
  }
  const assetBytes = async (name) => (await readFile(path.join(out, "rich-content", name))).length;
  const initialJsBytes = await assetBytes("rich-content.js");
  const initialCssBytes = await assetBytes("rich-content.css");
  const lazyMermaidBytes = await assetBytes("mermaid.js").catch((error) => {
    if (error.code === "ENOENT") return 0;
    throw error;
  });
  console.log(JSON.stringify({ node: process.version, chromium: browser.version(), out, initialJsBytes, initialCssBytes,
    lazyMermaidBytes, noDiagramReady: stats(cold), results }, null, 2));
} finally {
  profile.disconnect();
  await browser?.close();
  server.close();
}
