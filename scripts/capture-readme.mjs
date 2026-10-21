import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { chromium } from "playwright-core";

// Capture the real sidebar document with sample data and simulated VS Code IPC.
// No Pi process, provider, workspace files, or native Preview/Apply actions are used.
const require = createRequire(import.meta.url);
const { getSidebarHtml } = require("../out/sidebarHtml.js");
const { renderSafeMarkdown } = require("../out/markdown.js");
const output = new URL("../resources/screenshots/", import.meta.url);
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 540, height: 620 }, deviceScaleFactor: 2 });
  const errors = [];
  const requests = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.route("**/*", (route) => {
    requests.push(route.request().url());
    return route.abort();
  });
  await page.evaluate(() => {
    window.posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (message) => window.posted.push(message) });
  });
  await page.setContent(getSidebarHtml(100000, 5000000));
  await page.evaluate(() => {
    document.body.className = "vscode-dark";
    const colors = {
      "font-family": "Arial",
      "font-size": "13px",
      foreground: "#cccccc",
      descriptionForeground: "#aaaaaa",
      disabledForeground: "#999999",
      "sideBar-background": "#181818",
      "sideBar-border": "#333333",
      "editor-background": "#181818",
      "editorWidget-background": "#252526",
      "input-background": "#313131",
      "input-foreground": "#cccccc",
      "input-border": "#454545",
      "dropdown-background": "#313131",
      "dropdown-border": "#454545",
      "button-background": "#0078d4",
      "button-foreground": "#ffffff",
      "textLink-foreground": "#4daafc",
      focusBorder: "#0078d4",
    };
    for (const [key, value] of Object.entries(colors)) document.body.style.setProperty(`--vscode-${key}`, value);
  });
  const post = (data) => page.evaluate((data) => window.dispatchEvent(new MessageEvent("message", { data })), data);
  const runtime = {
    connected: true,
    busy: false,
    sessionFile: "/sample/session.jsonl",
    sessionId: "sample-session",
    model: { name: "Sample model", provider: "sample", id: "sample" },
    thinkingLevel: "high",
    availableThinkingLevels: ["off", "minimal", "low", "medium", "high"],
  };
  const attachment = { id: "selection", type: "context", label: "src/validation.ts · selection" };
  const state = async (extra) =>
    post({
      type: "state",
      status: "Ready",
      runtime,
      history: { available: true, canNavigate: true, mode: "latest", total: 2, omittedBefore: 0, omittedAfter: 0 },
      attachments: [],
      ...extra,
    });
  const snapshot = async (name) => {
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, [], "the renderer must not fail during capture");
    assert.deepEqual(requests, [], "screenshots must not request external resources");
    await page.screenshot({ path: new URL(name, output).pathname, animations: "disabled" });
  };
  await post({ type: "showSessionDetail" });
  const question = "How does this function validate a name?";
  await state({
    messages: [
      { id: "question", role: "user", html: renderSafeMarkdown(question) },
      {
        id: "explanation",
        role: "assistant",
        html: renderSafeMarkdown(
          "The function checks the name before saving it:\n\n- It removes leading and trailing spaces.\n- It rejects an empty value.\n- It returns the validated name.",
        ),
      },
    ],
    attachments: [attachment],
    attachmentEstimate: { characters: 142, estimatedTextTokens: 36 },
  });
  await post({ type: "setInput", text: "Which edge cases should I test for this selection?" });
  assert.equal(await page.getByRole("button", { name: "Send message", exact: true }).isEnabled(), true);
  await snapshot("attach-and-ask.png");

  await post({ type: "setInput", text: "" });
  await state({
    messages: [
      {
        id: "request",
        role: "user",
        html: renderSafeMarkdown("Simplify the selected validation without changing its behavior."),
        attachments: [attachment],
      },
      {
        id: "proposal-explanation",
        role: "assistant",
        html: renderSafeMarkdown(
          "The proposal removes a repeated check and keeps the existing error message.\n\nReview the selected hunks in the diff before applying them.",
        ),
      },
    ],
    proposals: [
      { id: "sample-edit", label: "Simplify src/validation.ts", status: "ready", totalHunks: 2, selected: [0, 1] },
    ],
  });
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  assert.equal(await preview.isEnabled(), true);
  assert.equal(await page.getByRole("button", { name: "Apply", exact: true }).isEnabled(), false);
  await snapshot("review-proposal.png");
  // Check the real renderer action without running a native diff or changing files.
  await preview.click();
  assert.ok(
    await page.evaluate(() =>
      window.posted.some((message) => message.type === "proposalAction" && message.action === "preview"),
    ),
  );
  console.log("Captured two sidebar screenshots with offline sample data; native diff and Apply were not run.");
} finally {
  await browser.close();
}
