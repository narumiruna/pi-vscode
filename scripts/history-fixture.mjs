import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

export function historyFixtureMessages(count = 205) {
  return Array.from({ length: count }, (_, index) => ({
    role: index % 2 ? "assistant" : "user",
    timestamp: 42,
    content: [
      {
        type: "text",
        text: `History ${String(index).padStart(3, "0")} duplicate label 日本語 🐈 [.*]\n\n\`\`\`js\nliteral_code_${index}\n\`\`\``,
      },
    ],
  }));
}

// Real native frame entry point. The runner supplies historyFixture to seed its deterministic RPC
// fixture with historyFixtureMessages(), then refreshes history. It must not submit a prompt.
export async function assertNativeConversationHistory({ pi, invoke }) {
  await invoke("historyFixture", historyFixtureMessages());
  await pi.locator("#history-earlier:not([disabled])").waitFor();
  await assertHistoryControls(pi);
  await pi.locator("#history-earlier").click();
  await pi.locator("#history-scope").filter({ hasText: "Earlier window" }).waitFor();
  assert.match(await pi.locator("#messages").innerText(), /History 005/);
  assert.doesNotMatch(await pi.locator("#messages").innerText(), /History 204/);
  assert.ok((await pi.locator("#messages .message").count()) <= 100);
  await pi.locator("#history-latest").click();
  await pi.locator("#history-scope").filter({ hasText: "Latest window" }).waitFor();
  assert.match(await pi.locator("#messages").innerText(), /History 204/);
  return { native: "earlier/latest replacement, literal search, source, Unicode, focus" };
}

async function assertHistoryControls(frame) {
  await frame.locator("#history-search-open").click();
  const input = frame.locator("#history-search-input");
  await input.fill("[.*]");
  assert.match(await frame.locator("#history-search-count").innerText(), /1 of 100 in this window/);
  await input.press("Enter");
  assert.match(await frame.locator("#history-search-count").innerText(), /2 of 100/);
  await input.press("Shift+Enter");
  assert.match(await frame.locator("#history-search-count").innerText(), /1 of 100/);
  await input.fill("literal_code_204");
  assert.match(await frame.locator("#history-search-count").innerText(), /1 of 1/);
  await input.fill("日本語 🐈");
  assert.match(await frame.locator("#history-search-count").innerText(), /1 of 100/);
  await input.fill("absent text");
  assert.equal(await frame.locator("#history-search-count").innerText(), "No matches in this window.");
  await input.press("Escape");
  assert.equal(await frame.locator("#history-search-bar").isVisible(), false);
  assert.equal(await frame.locator("#history-search-open").evaluate((node) => document.activeElement === node), true);
}

export async function assertHistoryBrowser(browser) {
  const {
    conversationHistoryControlsHtml,
    conversationHistoryStyles,
    conversationHistoryScript,
  } = require("../out/conversationHistoryHtml.js");
  const { renderSafeMarkdown } = require("../out/markdown.js");
  const page = await browser.newPage({ viewport: { width: 280, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(`<!doctype html><style>${conversationHistoryStyles()}#conversation{height:400px;overflow:auto}.content pre{overflow:auto}</style>
    ${conversationHistoryControlsHtml()}<section id="conversation"><div id="messages"></div></section>
    <script>const posts=[]; const vscode={postMessage(message){posts.push(message)}};
    ${conversationHistoryScript()}
    window.historyTest={posts,search:conversationHistory,render(state){conversationHistory.beforeRender(state);
      const root=document.getElementById('messages');root.replaceChildren();
      for(const message of state.messages){const article=document.createElement('article');article.className='message';article.messageId=message.id;
      const content=document.createElement('div');content.className='content';content.innerHTML=message.html;article.append(content);root.append(article)}
      conversationHistory.onState(state)}};</script>`);
  const all = historyFixtureMessages().map((message, index) => ({
    id: `fixture-${index}`,
    role: message.role,
    html: renderSafeMarkdown(message.content[0].text),
  }));
  const latest = {
    messages: all.slice(-100),
    runtime: { connected: true, busy: false, sessionId: "a" },
    history: {
      generation: 1,
      mode: "latest",
      start: 105,
      end: 205,
      total: 205,
      omittedBefore: 105,
      omittedAfter: 0,
      available: true,
      loading: false,
      canNavigate: true,
    },
  };
  const send = (state) => page.evaluate((state) => window.historyTest.render(state), state);
  await send(latest);
  await assertHistoryControls(page);
  await page.locator("#history-search-open").click();
  const input = page.locator("#history-search-input");
  await input.fill("[.*]");
  await input.press("Enter");
  const beforeSource = await page.locator("#messages pre code").last().textContent();
  const start = performance.now();
  for (let index = 0; index < 20; index += 1) {
    await send({
      ...latest,
      runtime: { ...latest.runtime, busy: true },
      history: { ...latest.history, generation: 2, available: false, canNavigate: false },
      messages: [
        ...latest.messages.slice(0, -1),
        { ...latest.messages.at(-1), html: `${latest.messages.at(-1).html}<p>stream ${index}</p>` },
      ],
    });
    assert.match(await page.locator("#history-search-count").innerText(), /2 of 100/);
  }
  assert.equal(
    await page.locator("#messages pre code").last().textContent(),
    beforeSource,
    "highlights never mutate code/source",
  );
  const streamMilliseconds = performance.now() - start;
  await send(latest);
  await page.locator("#history-earlier").click();
  assert.deepEqual(await page.evaluate(() => window.historyTest.posts.at(-1)), {
    type: "historyWindow",
    direction: "earlier",
    generation: 1,
  });
  await send({
    ...latest,
    messages: all.slice(5, 105),
    history: {
      ...latest.history,
      generation: 3,
      mode: "earlier",
      start: 5,
      end: 105,
      omittedBefore: 5,
      omittedAfter: 100,
    },
  });
  assert.equal(await page.evaluate(() => window.historyTest.search.isEarlier()), true);
  assert.equal(await page.evaluate(() => window.historyTest.search.latest()), true);
  assert.equal((await page.evaluate(() => window.historyTest.posts.at(-1))).direction, "latest");
  await send({ ...latest, runtime: { ...latest.runtime, sessionId: "replacement" } });
  assert.equal(await input.inputValue(), "", "session replacement clears the search selection");
  await send({ ...latest, history: { ...latest.history, truncated: true } });
  assert.match(await page.locator("#history-scope").innerText(), /omitted portions of long messages cannot be browsed/);
  const limit = {
    ...latest,
    messages: [{ id: "limit", role: "assistant", html: `<pre><code>${"x".repeat(250000)}</code></pre>` }],
  };
  const limitStart = performance.now();
  await send(limit);
  await input.fill("x");
  const limitRenderSearchMilliseconds = Math.round(performance.now() - limitStart);
  assert.match(await page.locator("#history-search-count").innerText(), /1000\+ \(match limit\)/);
  assert.equal(await page.evaluate(() => CSS.highlights.get("pi-conversation-matches").size), 1000);
  await page.setViewportSize({ width: 200, height: 700 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
  await page.close();
  return {
    windowMessages: 100,
    searchCharacters: 250000,
    highlights: 1000,
    streamUpdates: 20,
    streamMilliseconds: Math.round(streamMilliseconds),
    limitRenderSearchMilliseconds,
    native: "not run",
  };
}

export async function assertPublicHistoryApi(cli) {
  const { PiRpcClient } = require("../out/piRpcClient.js");
  const metadata = JSON.parse(await readFile(path.resolve(cli, "../../package.json"), "utf8"));
  const root = await mkdtemp(path.join(tmpdir(), "pi-history-public-contract-"));
  const env = {
    PATH: process.env.PATH,
    HOME: root,
    PI_CODING_AGENT_DIR: path.join(root, "agent"),
    PI_OFFLINE: "1",
    PI_SKIP_VERSION_CHECK: "1",
    PI_TELEMETRY: "0",
  };
  await mkdir(env.PI_CODING_AGENT_DIR);
  const args = [
    path.resolve(cli),
    "--offline",
    "--no-mcp",
    "--no-extensions",
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
  ];
  const timestamp = new Date(0).toISOString();
  const session = (messages) =>
    [
      { type: "session", version: 3, id: "history-fixture-session", timestamp, cwd: root },
      ...messages.map((message, index) => ({
        type: "message",
        id: `entry-${index}`,
        parentId: index ? `entry-${index - 1}` : null,
        timestamp,
        message,
      })),
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n";
  const run = async (messages, action) => {
    const sessionPath = path.join(root, "history.jsonl");
    await writeFile(sessionPath, session(messages));
    const client = new PiRpcClient({
      executablePath: process.execPath,
      executableArgs: args,
      cwd: root,
      env,
      unsetEnv: Object.keys(process.env).filter((key) => !(key in env)),
      sessionPath,
      requestTimeoutMs: 10000,
    });
    try {
      await client.start();
      await action(client);
    } finally {
      await client.stop();
    }
  };
  try {
    const values = historyFixtureMessages();
    await run(values, async (client) => {
      const actual = await client.getMessages();
      assert.equal(actual.length, 205);
      assert.deepEqual(actual[0], values[0]);
      assert.deepEqual(actual.at(-1), values.at(-1));
    });
    await run([{ role: "user", timestamp: 0, content: "x".repeat(5 * 1024 * 1024) }], async (client) => {
      await assert.rejects(client.getMessages(), /5 MiB/);
    });
    return {
      version: metadata.version,
      messages: 205,
      source: "public get_messages returns complete active branch",
      frameLimit: "unchanged 5 MiB; oversized response rejected",
      modelCalls: 0,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv[2] === "--public-api")
    console.log("PI_HISTORY_PUBLIC_API", JSON.stringify(await assertPublicHistoryApi(process.argv[3])));
  else if (process.argv[2] === "--browser") {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ headless: true });
    try {
      console.log("PI_HISTORY_BROWSER", JSON.stringify(await assertHistoryBrowser(browser)));
    } finally {
      await browser.close();
    }
  } else throw new Error("Use --browser or --public-api /path/to/pi/dist/cli.js");
}
