import assert from "node:assert/strict";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const { validateSessionJsonl } = require("../out/sessionTransfer.js");
const stamp = "2026-01-01T00:00:00.000Z";
const user = (id, parentId, text) => ({
  type: "message",
  id,
  parentId,
  timestamp: stamp,
  message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
});
export async function seedTransferSession(directory, cwd) {
  const entries = [
    user("root", null, "Native transfer root fixture-secret\u2028LS\u2029PS"),
    user("abandoned", "root", "ABANDONED_BRANCH_ONLY"),
    user("active", "root", "ACTIVE_BRANCH_ONLY"),
  ];
  const bytes = `${[{ type: "session", version: 3, id: "native-ui-session", cwd, timestamp: stamp }, ...entries]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  validateSessionJsonl(Buffer.from(bytes));
  await writeFile(path.join(directory, "session.jsonl"), bytes);
}

/** Real workbench UI, dialogs and readonly editors; only the Pi/gh boundaries are fixtures. */
export async function assertAuthTransferDialogs({ page, directory, workspace, invoke, pick, until, frame }) {
  const read = (name) => readFile(path.join(directory, name), "utf8");
  const optional = (name) =>
    read(name).catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
  const promptsBefore = await optional("prompts.jsonl");
  const sourceBefore = await read("session.jsonl");
  const command = async (name) => {
    const commandId = await invoke("startCommand", { command: name });
    return async () => {
      const result = await until(async () => {
        const state = await invoke("commandResult", { commandId });
        return state?.complete && state;
      }, `native command completed: ${name}`);
      assert.equal(result.error, undefined);
    };
  };
  const cancel = async () => page.keyboard.press("Escape");
  const dialogText = () => page.locator(".monaco-dialog-box").innerText();
  const dismissNotice = async (text) => {
    await until(async () => (await page.locator("body").innerText()).includes(text), `native notice: ${text}`);
    await invoke("command", { command: "notifications.clearAll" });
  };
  const filePath = async (filename) => {
    const input = page.locator(".quick-input-widget input[type=text]");
    await input.waitFor({ state: "visible" });
    await input.fill(filename);
    // Alias paths can first navigate to a directory. Confirm only this file input, never a later approval.
    for (let attempt = 0; attempt < 3 && await input.isVisible(); attempt++) {
      if ((await page.locator(".quick-input-widget").innerText()).includes("already exists")) break;
      await input.press("Enter");
      await page.waitForTimeout(250);
    }
    // SimpleFileDialog can first navigate to a typed full path, then need confirmation.
    await until(
      async () =>
        !(await input.isVisible()) ||
        (await page.locator(".quick-input-widget").innerText()).includes("already exists"),
      "file destination accepted",
    );
  };
  let done = await command("pi.exportSession");
  await page.getByText("Export Pi Session: Format and Scope", { exact: true }).waitFor();
  await cancel();
  await done();
  assert.equal(await read("session.jsonl"), sourceBefore);

  const output = path.join(workspace, "native-active-branch.jsonl");
  done = await command("pi.exportSession");
  await pick("JSONL — active branch only");
  await filePath(output, "Export New File");
  // A completed write must release ownership while its non-decision toast stays open.
  await done();
  await dismissNotice("Pi session exported to");
  const exported = await readFile(output);
  const parsed = validateSessionJsonl(exported);
  assert.deepEqual(
    parsed.entries.map((entry) => entry.id),
    ["root", "active"],
  );
  assert.ok(exported.toString().includes("ACTIVE_BRANCH_ONLY"));
  assert.ok(!exported.toString().includes("ABANDONED_BRANCH_ONLY"));
  assert.equal((await stat(output)).mode & 0o777, 0o600);
  assert.equal(await read("session.jsonl"), sourceBefore);

  // Approve the workbench's existing-file warning, then verify the host still refuses replacement.
  done = await command("pi.exportSession");
  await pick("JSONL — active branch only");
  await filePath(output, "Export New File");
  const replace = page.getByRole("button", { name: "OK", exact: true });
  await replace.waitFor({ state: "visible" });
  await replace.click();
  await dismissNotice("EEXIST: file already exists");
  await done();
  assert.deepEqual(await readFile(output), exported);

  const html = path.join(workspace, "native-full-tree.html");
  done = await command("pi.exportSession");
  await pick("HTML — complete session tree");
  await filePath(html, "Export New File");
  await done();
  await dismissNotice("Pi session exported to");
  const rendered = await readFile(html, "utf8");
  assert.ok(rendered.includes("ABANDONED_BRANCH_ONLY") && rendered.includes("ACTIVE_BRANCH_ONLY"));

  const importPath = path.join(workspace, "selected-import.jsonl");
  const importedBytes = `${[
    { type: "session", version: 3, id: "native-import-authoritative", cwd: workspace, timestamp: stamp },
    user("import-root", null, "IMPORTED_AUTHORITATIVE_HISTORY"),
    user("import-abandoned", "import-root", "IMPORT_ABANDONED_HIDDEN"),
    user("import-active", "import-root", "!!DO_NOT_EXECUTE_SOURCE_CONTENT fixture-secret"),
  ]
    .map((entry) => JSON.stringify(entry))
    .join("\n")}\n`;
  validateSessionJsonl(Buffer.from(importedBytes));
  await writeFile(importPath, importedBytes);
  const importDialog = async () => {
    const complete = await command("pi.importSession");
    await filePath(importPath, "Validate Import");
    await page.getByRole("button", { name: "Import Copy", exact: true }).waitFor();
    assert.match(await dialogText(), /Import 3 entries.*source and old session file stay unchanged/s);
    return complete;
  };
  done = await importDialog();
  await cancel();
  await done();
  assert.deepEqual(await readdir(path.join(directory, "configured-sessions")), []);
  done = await importDialog();
  await page.getByRole("button", { name: "Import Copy", exact: true }).click();
  await done();
  await dismissNotice("Pi imported and activated");
  const retained = await readdir(path.join(directory, "configured-sessions"));
  assert.equal(retained.length, 1);
  assert.match(retained[0], /^import-.+\.jsonl$/);
  const retainedPath = path.join(directory, "configured-sessions", retained[0]);
  assert.equal(await readFile(retainedPath, "utf8"), importedBytes);
  assert.equal(await readFile(importPath, "utf8"), importedBytes);
  assert.equal(await read("session.jsonl"), sourceBefore);
  const switches = (await read("switches.jsonl")).trim().split("\n").map(JSON.parse);
  assert.equal(switches.length, 1);
  assert.equal(switches[0].sessionFile, retainedPath);
  assert.equal(switches[0].sessionId, "native-import-authoritative");
  const pi = await frame();
  await until(
    async () => (await pi.locator("body").innerText()).includes("IMPORTED_AUTHORITATIVE_HISTORY"),
    "authoritative imported history",
  );
  assert.ok(!(await pi.locator("body").innerText()).includes("IMPORT_ABANDONED_HIDDEN"));
  await pi.locator("#session-details summary").click();
  assert.equal(await pi.locator("#session").inputValue(), "native-import-authoritative");
  assert.equal(await optional("shell.jsonl"), "", "Imported shell-like content is never executed");

  done = await command("pi.shareSession");
  await pick("GitHub non-public gist");
  const rows = () => page.locator(".quick-input-list").innerText();
  assert.ok(!(await rows()).includes("Continue to upload approval"));
  await pick("Inspect exact active-branch JSONL payload");
  const first = await invoke("transferInspection", { revision: 0 });
  assert.equal(first.unchanged, true, JSON.stringify(first));
  assert.ok(first.text.includes("fixture-secret"));
  assert.ok(!first.text.includes("IMPORT_ABANDONED_HIDDEN"));
  await pick("Redact a literal from string values");
  const masked = page.locator(".quick-input-widget input[type=password]");
  await masked.waitFor({ state: "visible" });
  await masked.fill("fixture-secret");
  await masked.press("Enter");
  await until(async () => (await rows()).includes("Inspect exact active-branch"), "new redacted revision");
  assert.ok(!(await rows()).includes("Continue to upload approval"));
  await pick("Inspect exact active-branch JSONL payload");
  const redacted = await invoke("transferInspection", { revision: 1 });
  assert.equal(redacted.unchanged, true, JSON.stringify(redacted));
  assert.ok(!redacted.text.includes("fixture-secret"));
  assert.ok(redacted.text.includes("[REDACTED]"));
  await pick("Continue to upload approval");
  await page.getByRole("button", { name: "Upload Inspected Payload", exact: true }).waitFor();
  assert.match(await dialogText(), /not confidential storage.*anyone with the link.*Delete the gist separately/s);
  assert.equal(await optional("gh-invoked"), "");
  await cancel();
  await done();
  assert.equal(await optional("gh-invoked"), "");
  assert.equal(await readFile(importPath, "utf8"), importedBytes);
  assert.equal(await readFile(retainedPath, "utf8"), importedBytes);

  const auth = async (method) => {
    const complete = await command("pi.signInProvider");
    await pick("fixture");
    await pick(method);
    await page.locator(".monaco-dialog-box").getByRole("button", { name: "Sign In", exact: true }).waitFor();
    const text = await dialogText();
    assert.ok(text.includes("this Extension Host") && text.includes(path.join(directory, "pi")));
    assert.match(text, /Pi owns credentials; VS Code does not store them/);
    await page.locator(".monaco-dialog-box").getByRole("button", { name: "Sign In", exact: true }).click();
    return complete;
  };
  done = await command("pi.signInProvider");
  await page.getByText("Sign In to Pi Provider (Built-in Providers)", { exact: true }).waitFor();
  await cancel();
  await done();
  done = await auth("API key");
  await masked.waitFor({ state: "visible" });
  await masked.fill("FAKE_NATIVE_KEY_NEVER_A_CREDENTIAL");
  await cancel();
  await dismissNotice("cancelled");
  await done();
  done = await auth("API key");
  await masked.waitFor({ state: "visible" });
  await masked.fill("FAKE_NATIVE_KEY_NEVER_A_CREDENTIAL\u2028LS\u2029PS");
  await masked.press("Enter");
  await done();
  await dismissNotice("Pi updated its stored credential.");
  await writeFile(path.join(directory, "auth-mode.txt"), "url-cancel");
  done = await auth("Browser / device sign-in");
  await page.getByText("Open Sign-in Page", { exact: true }).waitFor();
  await cancel();
  await dismissNotice("cancelled");
  await done();
  await writeFile(path.join(directory, "auth-mode.txt"), "unsupported");
  done = await command("pi.signInProvider");
  await dismissNotice("does not support the isolated Pi 1.3.0 helper");
  await done();
  await assert.rejects(stat(path.join(directory, "pi/auth.json")), { code: "ENOENT" });
  assert.equal(await optional("prompts.jsonl"), promptsBefore, "All dialogs leave model prompt count unchanged");
  assert.equal(await optional("shell.jsonl"), "");
  assert.equal(await optional("gh-invoked"), "");
  await until(
    async () => (await pi.locator("#messages").innerText()).includes("IMPORTED_AUTHORITATIVE_HISTORY"),
    "imported authoritative transcript, not only recent-session title",
  );
  await writeFile(path.join(directory, "auth-mode.txt"), "secret");
  await pi.locator("#session-details summary").click();
  console.log(
    "PI_NATIVE_AUTH_TRANSFER",
    JSON.stringify({
      export: "native format/scope + Save; validated active branch, Unicode LS/PS, exclusive file, HTML full tree",
      import:
        "native Open + modal cancel/approve; retained configured-dir copy; source unchanged; actual identity and authoritative history",
      share:
        "read-only exact payload + masked redaction + mandatory reinspection + cancelled upload modal; gh never invoked",
      auth: "provider/method + full host/store modal + masked cancel/fake success + browser approval cancelled + unsupported helper",
      modelPromptsBefore: promptsBefore.trim() ? promptsBefore.trim().split("\n").length : 0,
      modelPromptsAfter: promptsBefore.trim() ? promptsBefore.trim().split("\n").length : 0,
      externalEffects:
        "none; deterministic Pi helper, fail-closed disposable gh PATH stub; no auth/model/upload/browser",
    }),
  );
}
