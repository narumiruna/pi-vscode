import assert from "node:assert/strict";
import { readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";

async function piLogs(directory) {
  const files = [];
  async function visit(root) {
    for (const entry of await readdir(root, { withFileTypes: true }).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    })) {
      const file = path.join(root, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile() && /^(?:\d+-)?Pi\.log$/.test(entry.name)) files.push(file);
    }
  }
  await visit(path.join(directory, "logs"));
  return Promise.all(files.map(async (file) => ({ file, text: await readFile(file, "utf8") })));
}

/** Real Sidebar, RPC parser, Output panel and keyboard; only the offline Pi process is simulated. */
export async function assertNativeOutputDiagnostics({ page, directory, userData, invoke, until, frame, version }) {
  const pi = await frame();
  await until(
    async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected",
    "diagnostics fixture runtime connected",
  );
  const prompts = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  assert.equal(await prompts(), "", "Activation must not request a model response");
  assert.equal(await page.locator(".part.panel").isVisible(), false, "Activation must not reveal a panel");
  assert.equal(await page.locator(".monaco-dialog-box:visible").count(), 0, "Activation must not show a modal");
  await invoke("source");
  const before = await invoke("state");
  const focusedEditor = await page.evaluateHandle(() => document.activeElement);
  assert.ok(await focusedEditor.evaluate((element) => !!element?.closest(".monaco-editor")), "Source editor must own focus");

  // Detect transient modal/panel/notification reveals and focus transfers, not just final state.
  await page.evaluate(() => {
    const initialFocus = document.activeElement;
    const violations = [];
    const visible = (selector) => Array.from(document.querySelectorAll(selector)).some((element) => {
      const rect = element.getBoundingClientRect();
      return element.checkVisibility() && rect.width > 0 && rect.height > 0;
    });
    const add = (message) => { if (violations.length < 20 && !violations.includes(message)) violations.push(message); };
    const sample = () => {
      if (visible(".monaco-dialog-box")) add("modal");
      if (visible(".part.panel")) add("panel");
      if (visible(".notifications-toasts .notification-toast")) add("notification");
    };
    const focus = () => { if (document.activeElement !== initialFocus) add("focus"); };
    const observer = new MutationObserver(sample);
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden"] });
    document.addEventListener("focusin", focus, true);
    sample();
    window.__piOutputDiagnosticsGuard = {
      stop() {
        sample();
        focus();
        observer.disconnect();
        document.removeEventListener("focusin", focus, true);
        return violations;
      },
    };
  });

  const sentinel = "OUTPUT_DIAGNOSTICS_PRIVATE_SENTINEL";
  const privateText = `${sentinel} /private/${sentinel}/session.jsonl token=${sentinel}`;
  let summary;
  let records;
  try {
    // Atomic test-only IPC causes malformed stdout and private stderr in the actual RPC child.
    await writeFile(path.join(directory, "extension-dialog.tmp"), JSON.stringify({ type: "fixture_invalid_json", text: privateText }));
    await rename(path.join(directory, "extension-dialog.tmp"), path.join(directory, "extension-dialog.json"));
    const action = pi.locator("#notice").getByRole("button", { name: "Show Output", exact: true });
    await action.waitFor({ state: "visible" });
    summary = await pi.locator("#notice").innerText();
    assert.match(summary, /^Pi sent an invalid response\./);
    assert.ok(summary.length < 200, "The Sidebar must retain a short recovery summary");
    assert.ok(!summary.includes(sentinel));
    assert.equal(await pi.locator("#notice").getByRole("button", { name: "View diagnostic", exact: true }).count(), 0);
    records = await until(async () => {
      const logs = await piLogs(userData);
      return logs.some(({ text }) => /runtime-warning .*"category":"invalid-frame"/.test(text)) && logs;
    }, "safe diagnostics written before Show Output");
    assert.equal(records.length, 1, "Exactly one Pi log channel must exist");
    const warnings = records[0].text.split("\n").filter((line) => line.includes("runtime-warning "));
    assert.equal(warnings.length, 1, "One malformed frame must have one record owner");
    const metadata = JSON.parse(warnings[0].slice(warnings[0].indexOf("runtime-warning ") + "runtime-warning ".length));
    assert.equal(metadata.category, "invalid-frame");
    assert.equal(metadata.warningCode, "protocol-error");
    assert.ok(Number.isSafeInteger(metadata.generation));
    assert.ok(!records[0].text.includes(sentinel), "Neither stderr nor the invalid JSON line may reach Output");
    assert.ok(!(await pi.locator("body").innerText()).includes(sentinel), "Raw diagnostics must not enter the webview");
    assert.deepEqual(await invoke("state"), before, "Failure must preserve source, tabs and active editor");
    assert.ok(await focusedEditor.evaluate((element) => element === document.activeElement), "Failure must preserve exact editor input focus");
  } finally {
    await focusedEditor.dispose();
    const violations = await page.evaluate(() => {
      const result = window.__piOutputDiagnosticsGuard.stop();
      delete window.__piOutputDiagnosticsGuard;
      return result;
    });
    assert.deepEqual(violations, [], "Logging must not reveal UI or transfer focus before explicit action");
  }

  // Reach the existing notice action through native Tab traversal, then activate with Enter.
  // Do not call a host Output command or synthesize a webview message.
  const action = pi.locator("#notice").getByRole("button", { name: "Show Output", exact: true });
  assert.match(await action.ariaSnapshot(), /^- button "Show Output"/);
  await pi.locator("#input").focus();
  let reached = false;
  for (let attempt = 0; attempt < 40; attempt++) {
    await page.keyboard.press("Tab");
    reached = await action.evaluate((element) => element === document.activeElement);
    if (reached) break;
  }
  assert.ok(reached, "Show Output must be reachable with Tab from the composer");
  const keyboardFocus = await pi.evaluateHandle(() => document.activeElement);
  const nativeFocus = await page.evaluateHandle(() => document.activeElement);
  try {
    await page.keyboard.press("Enter");
    await page.locator(".part.panel .output-view").waitFor({ state: "visible" });
    // Narrow panels collapse named tabs into Additional Views. The active document and
    // native toolbar identify Output even when its tab label is not displayed.
    assert.equal(await page.locator(".part.panel").getByRole("document", { name: "Pi - Output", exact: true }).isVisible(), true);
    assert.equal(await page.locator(".part.panel").getByRole("toolbar", { name: "Output actions", exact: true }).isVisible(), true);
    await until(async () => {
      const selected = await page.locator(".part.panel .monaco-select-box").evaluateAll((elements) => elements.map((element) =>
        element instanceof HTMLSelectElement ? element.selectedOptions[0]?.textContent?.trim() : element.textContent?.trim(),
      ));
      return selected.includes("Pi");
    }, "native Output channel selector selects Pi");
    await until(
      async () => (await page.locator(".part.panel .output-view .view-lines").innerText()).includes("invalid-frame"),
      "safe failure category rendered in the selected Pi channel",
    );
    assert.ok(await keyboardFocus.evaluate((element) => element === document.activeElement), "show(true) must preserve Sidebar keyboard focus");
    assert.ok(await nativeFocus.evaluate((element) => element === document.activeElement), "Output must not take native input focus");
    assert.equal(await pi.locator("#notice").innerText(), summary, "Opening Output must retain the Sidebar recovery summary");
    assert.equal(await page.locator(".monaco-dialog-box:visible").count(), 0, "Show Output must not open the old diagnostic modal");
  } finally {
    await keyboardFocus.dispose();
    await nativeFocus.dispose();
  }
  assert.equal(await prompts(), "", "Diagnostics and Output navigation must not call a model");
  assert.equal((await readFile(path.join(directory, "pids.jsonl"), "utf8")).trim().split("\n").length, 1, "No automatic process restart");
  assert.ok((await piLogs(userData)).every(({ text }) => !text.includes(sentinel)), "The explicit action must not log private details");
  console.log("PI_NATIVE_OUTPUT_DIAGNOSTICS", JSON.stringify({
    version,
    platform: process.platform,
    failure: "offline malformed RPC stdout and private stderr; safe invalid-frame category only",
    sidebar: "short summary retained before and after Show Output; no private sentinel",
    passive: "no modal, panel, notification or exact editor-focus change during failure/logging",
    explicit: "native Tab/Enter on existing Show Output; Output selected, Pi channel selected; focus preserved",
    provider: "deterministic fixture; no model prompt, process restart, installation or installed-profile change",
  }));
}
