import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Real native editors and keyboard commands. Pi emits only deterministic public RPC records. */
export async function assertExtensionEditorDialogs({ page, directory, invoke, until, frame }) {
  const send = async (event) => {
    await writeFile(path.join(directory, "extension-dialog.tmp"), JSON.stringify(event));
    await rename(path.join(directory, "extension-dialog.tmp"), path.join(directory, "extension-dialog.json"));
  };
  const responses = async () => (await readFile(path.join(directory, "extension-dialog-responses.jsonl"), "utf8")
    .catch(() => "")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const response = (id) => until(async () => (await responses()).find((entry) => entry.id === id), `editor response ${id}`);
  const state = () => invoke("extensionEditorState");
  const discard = async () => {
    const button = page.getByRole("button", { name: /Don't Save|Do not save/i });
    if (await button.waitFor({ state: "visible", timeout: 1500 }).then(() => true).catch(() => false)) await button.click();
  };
  const closed = async () => {
    await until(async () => {
      const button = page.getByRole("button", { name: /Don't Save|Do not save/i });
      if (await button.isVisible()) await button.click();
      return (await state()).ownedTabs === 0;
    }, "owned editor closed/discarded");
    assert.equal(await page.getByText("Submit to Pi", { exact: false }).isVisible().catch(() => false), false);
  };
  const open = async (id, prefill, fields = {}) => {
    await send({ type: "extension_ui_request", id, method: "editor", title: `Native editor ${id}`, prefill, ...fields });
    // Stable VS Code keeps a dismissed picker visible but inert during its close animation.
    // Wait for this request, not the previous privacy picker's retained row.
    const widget = page.locator(".quick-input-widget:not(.quick-input-widget-closing):not([inert])")
      .filter({ has: page.getByText(`Pi extension editor: Native editor ${id}`, { exact: true }) });
    const picker = widget.locator(".quick-input-list .monaco-list-row")
      .filter({ hasText: "Open Non-Secret Editor" });
    await picker.waitFor({ state: "visible" });
    assert.match(await picker.innerText(), /hot-exit backups/);
    // Confirmation and every editor action can be completed without a mouse.
    await page.keyboard.press("Enter");
    await until(async () => (await state()).scheme === "untitled", `native editor ${id}`);
    assert.equal((await state()).text, prefill);
  };

  for (const [index, prefill] of ["  first\n\tsecond\n\n", "first\r\nsecond\r\n", "", "Unicode \u2028 \u2029\n"].entries()) {
    const id = `native-editor-exact-${index}`;
    await open(id, prefill);
    if (index === 0) {
      await invoke("extensionEditorOtherDocument");
      assert.equal((await responses()).some((entry) => entry.id === id), false, "other editors cannot submit or cancel");
      await invoke("extensionEditorRefocus");
      await invoke("extensionEditorEdit", { text: "  edited\n\tsecond\n\n" });
    }
    if (index === 3) {
      // VS Code asks about LS/PS in ordinary text documents. Keep them, never strip fixture input.
      await page.getByRole("button", { name: "Ignore", exact: true }).waitFor();
      await page.getByRole("button", { name: "Ignore", exact: true }).click();
    }
    const expected = index === 0 ? "  edited\n\tsecond\n\n" : prefill;
    await page.keyboard.press("Control+Enter");
    assert.deepEqual(await response(id), { type: "extension_ui_response", id, value: expected });
    await closed();
    await invoke("command", { command: "pi.extensionEditor.submit" });
    assert.equal((await responses()).filter((entry) => entry.id === id).length, 1);
  }

  await open("native-editor-cancel", "keep\nno partial value");
  await invoke("extensionEditorEdit", { text: "partial\nprivate draft" });
  await page.keyboard.press("Control+Escape");
  assert.deepEqual(await response("native-editor-cancel"), {
    type: "extension_ui_response", id: "native-editor-cancel", cancelled: true,
  });
  await closed();

  await open("native-editor-close", "close\nmeans cancel");
  const close = await invoke("extensionEditorClose", {}, false);
  await discard();
  await close();
  assert.deepEqual(await response("native-editor-close"), {
    type: "extension_ui_response", id: "native-editor-close", cancelled: true,
  });
  await closed();

  await send({ type: "extension_ui_request", method: "editor", id: "native-editor-decline", prefill: "not opened" });
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Open Non-Secret Editor" }).waitFor();
  await page.keyboard.press("Escape");
  assert.equal((await response("native-editor-decline")).cancelled, true);
  assert.equal((await state()).ownedTabs, 0);

  // A timeout during editing closes the owned tab locally. Pi, not VS Code, supplies its timeout default.
  await open("native-editor-timeout", "expires\nlocally", { timeout: 5000 });
  await closed();
  assert.equal((await responses()).some((entry) => entry.id === "native-editor-timeout"), false);

  const fullPermission = "日本語 permission\n" + "full command text ".repeat(500);
  await send({ type: "extension_ui_request", method: "confirm", id: "native-timed-confirm", message: fullPermission, timeout: 15000 });
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Review Full Message" }).click();
  await until(async () => (await state()).scheme === "pi-extension-confirmation", "full timed confirmation review");
  const review = await invoke("extensionConfirmationState");
  assert.ok(review.text.includes(fullPermission));
  // VS Code can acknowledge TextEditor.edit as true while leaving a content-provider model unchanged.
  assert.equal(review.unchanged, true, "API edits must not change the review text");
  await page.keyboard.type("forbidden");
  assert.equal((await state()).text, review.text, "native typing must not change read-only review text");
  await invoke("extensionEditorOtherDocument");
  await invoke("command", { command: "pi.extensionDialog.allow" });
  await invoke("command", { command: "pi.extensionDialog.block" });
  assert.equal((await responses()).some((entry) => entry.id === "native-timed-confirm"), false);
  await invoke("extensionConfirmationRefocus");
  await page.keyboard.press("F1");
  await page.locator(".quick-input-widget input[type=text]").fill(">Pi: Allow Reviewed Extension Action");
  await page.keyboard.press("Enter");
  assert.equal((await response("native-timed-confirm")).confirmed, true);
  await until(async () => (await state()).confirmationTabs === 0, "confirmation review closed");

  await send({ type: "extension_ui_request", method: "confirm", id: "native-confirm-timeout", message: fullPermission, timeout: 2000 });
  await page.locator(".quick-input-list .monaco-list-row").filter({ hasText: "Review Full Message" }).click();
  await until(async () => (await state()).confirmationTabs === 1, "expiring confirmation review opened");
  await until(async () => (await state()).confirmationTabs === 0, "timed confirmation closed locally");
  await invoke("command", { command: "pi.extensionDialog.allow" });
  assert.equal((await responses()).some((entry) => entry.id === "native-confirm-timeout"), false);

  await open("native-editor-replacement", "old\nprocess draft");
  await send({ type: "fixture_exit" });
  await closed();
  const pi = await frame();
  await pi.locator("#reconnect").waitFor({ state: "visible" });
  await pi.locator("#reconnect").click();
  await until(async () => !(await pi.locator("#reconnect").isVisible()), "replacement Pi connected");
  await invoke("command", { command: "pi.extensionEditor.submit" });
  await invoke("command", { command: "pi.extensionEditor.cancel" });
  assert.equal((await responses()).some((entry) => entry.id === "native-editor-replacement"), false);
  await open("native-editor-new-process", "new\norigin");
  await page.keyboard.press("Control+Enter");
  assert.equal((await response("native-editor-new-process")).value, "new\norigin");
  await closed();
  console.log("PI_NATIVE_EDITOR exact LF/CRLF/empty/Unicode, edited revision, keyboard Submit/Cancel, close/discard, privacy decline, timeout, read-only Unicode/multiline timed confirmation and process replacement passed");
}
