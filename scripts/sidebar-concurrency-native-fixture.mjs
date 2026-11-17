import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { nativeSidebarFixture } from "./session-switch-fixture.mjs";

/** Run last: accepted fixture prompts remain in primary history and the RPC ledger. */
export async function assertNativeSidebarConcurrency(options) {
  const { page, directory, workspace, until } = options;
  const ui = await nativeSidebarFixture(options);
  const { pi, optional, records, modal, choose, selected, closeSelected } = ui;
  const composer = pi.locator("#input");
  const a = await pi.locator("#session").inputValue();
  assert.ok(a, "Concurrency starts in the connected Primary detail");
  const b = "sidebar-concurrency-b";
  const primaryFile = (await records("starts.jsonl")).filter((entry) => entry.sessionId === a).at(-1)?.sessionFile;
  assert.ok(primaryFile, "Seed saved B in the current Primary store, including a configured/imported store");
  const bFile = path.join(path.dirname(primaryFile), "sidebar-concurrency-b.jsonl");
  const responseBefore = await readFile(path.join(directory, "response.txt"), "utf8");
  const extensionUiBefore = await optional("extension-ui.json");
  const switchesBefore = await optional("switches.jsonl");
  const originalDraft = await composer.inputValue();
  const captures = ["before", "sessions"].map((state) => path.join(tmpdir(), `pi-sidebar-concurrency-${state}.png`));
  await page.screenshot({ path: captures[0] });
  const eventOffset = (await records("sidebar-events.jsonl")).length;
  const startOffset = (await records("starts.jsonl")).length;
  const aDraft = "A-only retained native draft 日本語";
  const bDraft = "B-only retained native draft";
  const cDraft = "C-only retained native draft";
  let c;
  let d;
  let dOpened = false;
  let bOpened = false;
  let cOpened = false;
  const events = async () => (await records("sidebar-events.jsonl")).slice(eventOffset);
  const release = (id) => writeFile(path.join(directory, `sidebar-release-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`), "release");
  const busy = async (id) => {
    await selected(id);
    await until(async () => await pi.locator("#cancel").isVisible() &&
      await pi.locator("#runtime").getAttribute("data-connection") === "busy", `${id} still running`);
  };
  const hold = async (id, prompt, result) => {
    await writeFile(path.join(directory, "response.txt"), `HOLD_SIDEBAR_CONCURRENCY\n${result}`);
    await composer.fill(prompt);
    await pi.locator("#send").click();
    await until(async () => (await events()).some((event) => event.type === "prompt" &&
      event.sessionId === id && event.message.includes(prompt)), `${id} accepted origin-bound prompt`);
    await busy(id);
    await until(async () => await composer.inputValue() === "", `${id} accepted composer cleared`);
  };
  const currentEntry = async () => {
    // Hidden list nodes are intentionally not patched during transcript streaming.
    await pi.locator("#back-to-sessions").click();
    const row = pi.locator('#recent-session-list .session-row[aria-current="page"]');
    await row.waitFor({ state: "visible" });
    const id = await row.getAttribute("data-session-id");
    await row.click();
    await pi.locator("#conversation").waitFor({ state: "visible" });
    return id;
  };
  try {
    // Disable unrelated extension dialogs only for these fixture-owned prompts.
    await rm(path.join(directory, "extension-ui.json"), { force: true });
    const stamp = new Date().toISOString();
    await writeFile(bFile, `${[
      { type: "session", version: 3, id: b, cwd: workspace, timestamp: stamp },
      { type: "message", id: "sidebar-b-history", parentId: null, timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: "Sidebar B saved history only" }], timestamp: 1 } },
    ].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    await hold(a, "Native Sidebar A-only held request", "Native Sidebar A-only final result");
    await composer.fill(aDraft);
    const aEntry = await currentEntry();

    // A stays active while an existing saved B starts in its own process.
    await choose(b, true);
    bOpened = true;
    const bStart = (await records("starts.jsonl")).slice(startOffset).filter((entry) => entry.sessionId === b);
    assert.equal(bStart.length, 1);
    assert.equal(bStart[0].sessionArgument, bFile);
    assert.equal(await composer.inputValue(), "", "B must not inherit A's composer");
    assert.match(await pi.locator("#messages").innerText(), /Sidebar B saved history only/);
    assert.doesNotMatch(await pi.locator("#messages").innerText(), /Native Sidebar A-only/);
    await hold(b, "Native Sidebar B-only held request", "Native Sidebar B-only hidden final result");
    await composer.fill(bDraft);
    const bEntry = await currentEntry();

    // Delay B input across native navigation; its completion must not attach to A/C.
    await pi.evaluate(() => {
      const NativeFileReader = window.FileReader;
      window.nativeSidebarFileReader = NativeFileReader;
      window.FileReader = class extends NativeFileReader {
        readAsDataURL(blob) {
          window.nativeSidebarImageDone = new Promise((resolve) => this.addEventListener("loadend", () => resolve(), { once: true }));
          window.finishNativeSidebarImage = () => super.readAsDataURL(blob);
        }
      };
      const bytes = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6MZkAAAAASUVORK5CYII="), (value) => value.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "B-origin-only.png", { type: "image/png" }));
      document.getElementById("input").dispatchEvent(new ClipboardEvent("paste", { clipboardData: clipboard }));
    });
    assert.equal(await pi.evaluate(() => typeof window.finishNativeSidebarImage), "function", "B paste really starts a delayed read");
    await pi.locator("#new-session").click();
    await modal("Open Session");
    cOpened = true;
    await until(async () => await pi.locator("#input").inputValue() === "" &&
      await pi.locator("#session").inputValue() === "", "fresh C independent composer and session");
    await writeFile(path.join(directory, "response.txt"), "Native Sidebar C-only final result");
    await composer.fill("Native Sidebar C-only new request");
    await pi.locator("#send").click();
    await until(async () => (await pi.locator("#messages").innerText()).includes("Native Sidebar C-only final result") &&
      !(await pi.locator("#cancel").isVisible()), "new C completes independently while A/B run");
    c = await pi.locator("#session").inputValue();
    assert.ok(c && c !== a && c !== b);
    await until(async () => await composer.inputValue() === "", "cold C first Send clears only its accepted draft");
    await composer.fill(cDraft);
    const freshStarts = (await records("starts.jsonl")).slice(startOffset);
    const cStarts = freshStarts.filter((entry) => entry.sessionId === c);
    assert.equal(cStarts.length, 1);
    assert.equal(cStarts[0].sessionArgument, null, "C starts fresh without --session");
    assert.notEqual(cStarts[0].sessionFile, path.join(directory, "session.jsonl"), "Fresh C cannot duplicate Primary writer");
    assert.notEqual(cStarts[0].sessionFile, bFile);
    assert.notEqual(cStarts[0].pid, bStart[0].pid);
    const warmStarts = await optional("starts.jsonl");

    // Return to the running origin, then complete B while its detail is hidden.
    await choose(a);
    await busy(a);
    assert.equal(await composer.inputValue(), aDraft);
    assert.doesNotMatch(await pi.locator("#messages").innerText(), /Native Sidebar [BC]-only/);
    const aAttachments = await pi.locator("#attachments").innerText();
    await pi.evaluate(async () => {
      window.finishNativeSidebarImage();
      await window.nativeSidebarImageDone;
      window.FileReader = window.nativeSidebarFileReader;
    });
    await until(async () => !(await pi.locator("#composer-status").textContent()).includes("Loading pasted"),
      "late B input cannot leave A pending");
    assert.equal(await composer.inputValue(), aDraft, "B input completion must not change A text");
    assert.equal(await pi.locator("#attachments").innerText(), aAttachments, "B input completion must not attach to A");
    const inputId = `sidebar-input-${b.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
    await writeFile(path.join(directory, inputId), "request");
    await until(async () => (await ui.widget().innerText()).includes("B input while A is selected"), "source-labelled inactive B input");
    assert.equal(await pi.locator("#session").inputValue(), a, "B input does not replace selected A");
    await ui.input().fill("B-only native input value");
    await ui.input().press("Enter");
    await until(async () => (await records("extension-dialog-responses.jsonl")).some((entry) =>
      entry.id === inputId && entry.value === "B-only native input value"), "response returned to B origin");
    await busy(a);
    await release(b);
    await until(async () => (await events()).some((event) => event.type === "completed" && event.sessionId === b),
      "hidden B result completed");
    await busy(a);
    assert.equal(await pi.locator("#attachments").innerText(), aAttachments, "Late B input stays out of A after host processing");
    await pi.locator("#back-to-sessions").click();
    await until(() => pi.locator("#sessions").isVisible(), "Sessions shows background result");
    const bRow = pi.locator(`#recent-session-list .session-row[data-session-id="${bEntry}"]`);
    const aRow = pi.locator(`#recent-session-list .session-row[data-session-id="${aEntry}"]`);
    await until(async () => await bRow.locator(".session-row-activity").textContent() === "Completed" &&
      await bRow.locator(".session-unread-dot").isVisible(), "hidden B completed result stays unread");
    assert.equal(await aRow.locator(".session-row-activity").textContent(), "Running");
    await page.screenshot({ path: captures[1] });
    assert.notEqual(await pi.locator("#input").inputValue(), aDraft, "Sessions launcher does not inherit A draft");
    await choose(b);
    assert.equal(await composer.inputValue(), bDraft);
    assert.match(await pi.locator("#messages").innerText(), /Native Sidebar B-only hidden final result/);
    assert.doesNotMatch(await pi.locator("#messages").innerText(), /Native Sidebar [AC]-only/);
    await pi.locator("#back-to-sessions").click();
    await bRow.waitFor({ state: "visible" });
    await until(async () => await bRow.locator(".session-unread-dot").getAttribute("hidden") !== null,
      "visible latest B result acknowledged on return to Sessions");
    await bRow.click();
    await selected(b);
    // A delayed origin-bound image may be discarded; it must never enter another session.
    for (const button of await pi.locator("#attachments [data-remove-attachment]").all()) await button.click();

    await hold(b, "Native Sidebar B-only request to stop", "B STOPPED RESULT MUST NOT EXIST");
    await composer.fill(bDraft);
    const abortsBefore = (await events()).filter((event) => event.type === "abort").length;
    await pi.locator("#cancel").click();
    await until(async () => !(await pi.locator("#cancel").isVisible()), "B Stop settled only B");
    const aborts = (await events()).filter((event) => event.type === "abort").slice(abortsBefore);
    assert.deepEqual(aborts.map((event) => event.sessionId), [b], "B Stop must dispatch only to B origin");
    await choose(c);
    assert.equal(await composer.inputValue(), cDraft);
    assert.match(await pi.locator("#messages").innerText(), /Native Sidebar C-only final result/);
    assert.doesNotMatch(await pi.locator("#messages").innerText(), /Native Sidebar [AB]-only/);
    await choose(a);
    await busy(a);
    assert.equal(await composer.inputValue(), aDraft, "Stopping B leaves A draft and operation intact");
    await release(a);
    await until(async () => (await pi.locator("#messages").innerText()).includes("Native Sidebar A-only final result") &&
      !(await pi.locator("#cancel").isVisible()), "A continues to its own final result after B Stop");
    assert.equal(await composer.inputValue(), aDraft);
    assert.equal(await optional("starts.jsonl"), warmStarts, "A/B/C reselection never restarts retained runtimes");
    assert.equal(await optional("switches.jsonl"), switchesBefore, "Concurrent navigation never calls switch_session");
    // The Sessions composer promotes its own entry and changes recovery bindings during acceptance.
    await pi.locator("#back-to-sessions").click();
    await composer.fill("Native launcher first-send acceptance");
    await writeFile(path.join(directory, "response.txt"), "Native launcher accepted result");
    const launcherStarts = (await records("starts.jsonl")).length;
    await pi.locator("#send").click();
    await modal("Open Session");
    dOpened = true;
    await until(async () => (await pi.locator("#messages").innerText()).includes("Native launcher accepted result") &&
      !(await pi.locator("#cancel").isVisible()), "Sessions composer creates its own settled conversation");
    d = await pi.locator("#session").inputValue();
    await until(async () => await composer.inputValue() === "", "promoted launcher clears its exact accepted draft");
    assert.equal((await records("starts.jsonl")).length, launcherStarts + 1);
    await closeSelected(a);
    dOpened = false;
    const bHistory = await readFile(bFile, "utf8");
    assert.ok(!bHistory.includes("B STOPPED RESULT MUST NOT EXIST"));
    assert.ok(!bHistory.includes("Native Sidebar A-only") && !bHistory.includes("Native Sidebar C-only"));
    console.log("PI_NATIVE_SIDEBAR_CONCURRENCY", JSON.stringify({
      navigation: "A running -> saved B cold -> new C -> retained A",
      coldStarts: freshStarts.length, freshFilesDistinct: true, hiddenResultUnread: true,
      originBoundInput: true, independentDrafts: 3, coldFirstSendClear: true, launcherAcceptedClear: true, stop: "B stopped; A continued to completion",
      switchSessionCalls: 0, captures, provider: "fixture only",
    }));
  } catch (error) {
    console.error("PI_NATIVE_SIDEBAR_FAILURE", JSON.stringify({
      error: String(error.stack ?? error),
      session: await pi.locator("#session").inputValue(),
      status: await pi.locator("#status").textContent(),
      notice: await pi.locator("#notice").textContent(),
      messages: (await pi.locator("#messages").innerText()).slice(-4_000),
      starts: await records("starts.jsonl"),
      events: await events(),
    }));
    throw error;
  } finally {
    await pi.evaluate(() => {
      if (window.nativeSidebarFileReader) window.FileReader = window.nativeSidebarFileReader;
    });
    // Stop any surviving held work before closing its runtime; preserve saved history.
    if (dOpened && d) {
      await choose(d);
      await closeSelected(a);
    }
    if (cOpened && c) {
      await choose(c);
      await closeSelected(a);
    }
    if (bOpened) {
      await choose(b);
      if (await pi.locator("#cancel").isVisible()) await pi.locator("#cancel").click();
      await closeSelected(a);
    }
    await choose(a);
    if (await pi.locator("#cancel").isVisible()) {
      await pi.locator("#cancel").click();
      await until(async () => !(await pi.locator("#cancel").isVisible()), "cleanup Primary stopped");
    }
    await composer.fill(originalDraft);
    await writeFile(path.join(directory, "response.txt"), responseBefore);
    if (extensionUiBefore) await writeFile(path.join(directory, "extension-ui.json"), extensionUiBefore);
    else await rm(path.join(directory, "extension-ui.json"), { force: true });
    for (const id of [a, b, c].filter(Boolean)) {
      await rm(path.join(directory, `sidebar-release-${id.replace(/[^a-zA-Z0-9_-]/g, "_")}`), { force: true });
    }
  }
}
