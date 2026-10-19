import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openConversationDetails } from "./composer-navigation-fixture.mjs";

// Inspect only the active row of the disposable desktop profile, not backups or SQLite free pages.
async function retainedDesktopDrafts(directory) {
  const root = path.join(directory, "user", "User", "workspaceStorage");
  const locations = [];
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const filename = path.join(root, entry.name, "state.vscdb");
    let database;
    try {
      database = new DatabaseSync(filename, { readOnly: true });
      const row = database.prepare("SELECT value FROM ItemTable WHERE key = ?").get("narumi.narumi-pi");
      if (!row) continue;
      const state = JSON.parse(Buffer.from(row.value).toString("utf8"));
      const drafts = state["pi.sidebar.drafts.v1"];
      locations.push({ filename, drafts });
    } catch (error) {
      if (!/unable to open database|database is locked/i.test(String(error))) throw error;
    } finally {
      database?.close();
    }
  }
  return locations;
}

/** Check successful local commands that do not create a new session or draft binding. */
export async function assertNativeDraftLocalCommands({ pi, page, until, directory }) {
  if (!((await pi.locator("#app").getAttribute("class")) || "").split(" ").includes("sessions-layer")) {
    await pi.locator("#back-to-sessions").click();
  }
  const input = pi.locator("#input");
  // Settle the earlier detail/layer transition before testing an idle, same-binding command.
  await page.waitForTimeout(250);
  await input.fill("");
  await pi.locator('#composer-status[data-state="empty"]').waitFor({ state: "attached" });
  assert.equal(await pi.locator("#composer-status").isVisible(), false);
  const session = await pi.locator("#session").inputValue();
  const prompts = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const before = await prompts();
  assert.equal(await pi.locator("#enable-text-drafts").evaluate((node) => node.hidden), false, "retention stays off");
  for (const command of ["/reload", "/compact"]) {
    await input.fill(command);
    await pi.locator("#send").click();
    if (command === "/reload") {
      await page.getByRole("button", { name: "Reload Resources", exact: true }).click();
    }
    await until(async () => (await input.inputValue()) === "", `${command} accepted clear`);
    await input.fill("Local command finished; this draft is never sent");
    await until(
      async () => await pi.locator("#send").isEnabled(),
      `${command} releases the same-binding draft handoff`,
    );
    assert.equal(await pi.locator("#composer-status").isVisible(), false);
    assert.equal(await pi.locator("#session").inputValue(), session, "local commands do not create another session");
    assert.ok(((await pi.locator("#app").getAttribute("class")) || "").split(" ").includes("sessions-layer"));
    await input.fill("");
  }
  assert.equal(await prompts(), before, "fixture local commands never invoke a model");
  console.log(
    "PI_NATIVE_DRAFT_LOCAL_COMMANDS Sessions /reload and /compact release accepted handoffs with retention off; same session and no prompts",
  );
}

/**
 * Run in a disposable native workspace/profile with the offline Pi RPC fixture.
 * reload must perform Developer: Reload Window, reacquire the Pi webview and return
 * that FrameLocator (or { pi: FrameLocator }). Hide/show is not an adequate substitute.
 * approveDraftRecovery can operate the native consent modal; no model is required.
 */
export async function assertNativeDraftRecovery({ pi, page, reload, until, directory, approveDraftRecovery }) {
  assert.equal(typeof reload, "function", "native draft coverage requires an actual window reload callback");
  const log = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const before = await log();
  let current = pi;
  const text = "!do-not-execute-native-draft\nUnsent 日本語 👩🏽‍💻 text";
  const sessions = async () => {
    if (!((await current.locator("#app").getAttribute("class")) || "").split(" ").includes("sessions-layer")) {
      await current.locator("#back-to-sessions").click();
    }
  };
  const expand = async () => {
    await openConversationDetails(current, page);
    const details = current.locator("#text-draft-recovery");
    if (!(await details.evaluate((item) => item.open))) await details.locator("summary").click();
  };
  const actualReload = async () => {
    const result = await reload();
    if (result) current = result.pi ?? result;
    await current.locator("#input").waitFor({ state: "visible" });
  };
  await sessions();
  await expand();
  const enable = current.locator("#enable-text-drafts");
  if (await enable.isVisible()) {
    await until(async () => !(await enable.isDisabled()), "draft identity available");
    await enable.click();
    if (approveDraftRecovery) await approveDraftRecovery();
    else await page.getByRole("button", { name: "Enable Draft Recovery", exact: true }).click();
  }
  await until(async () => await current.locator("#disable-text-drafts").isVisible(), "explicit draft consent accepted");
  assert.equal(
    await current.locator("#attachments [data-remove-attachment]").count(),
    0,
    "native draft fixture must start without attachments",
  );
  await current.locator("#conversation-details-close").click();
  await current.locator("#input").fill(text);
  await current.locator("#input").press("Tab"); // Flush the coalesced text update without submitting.
  const stored = await until(async () => {
    const locations = await retainedDesktopDrafts(directory);
    return locations.find(({ drafts }) => drafts?.records?.some((item) => item.text === text));
  }, "non-secret draft in the local desktop workspaceState database");
  assert.ok(stored.filename.startsWith(path.join(directory, "user", "User", "workspaceStorage")));
  await actualReload();
  await sessions();
  await until(
    async () => await current.locator("#text-draft-notice").isVisible(),
    "retained draft offered after actual reload",
  );
  assert.equal(await current.locator("#conversation-details").evaluate((node) => node.open), false);
  assert.equal(await current.locator("#input").inputValue(), "", "reload must not insert text automatically");
  assert.equal(await log(), before, "recovery must not submit shell syntax or a model request");
  await expand();
  await current.locator("#restore-text-draft").click();
  await until(async () => (await current.locator("#input").inputValue()) === text, "explicit Unicode draft Restore");
  assert.equal(await current.locator("#attachments [data-remove-attachment]").count(), 0);
  assert.equal(await log(), before);
  await expand();
  await current.locator("#disable-text-drafts").click();
  await until(
    async () => await current.locator("#enable-text-drafts").isVisible(),
    "draft recovery disabled and owned records discarded",
  );
  await until(async () => {
    const locations = await retainedDesktopDrafts(directory);
    return locations.length && locations.every(({ drafts }) => drafts === undefined);
  }, "Disable removes the owned key from the active desktop database row");
  await actualReload();
  await sessions();
  await expand();
  assert.equal(await current.locator("#restore-text-draft").isVisible(), false);
  assert.equal(await current.locator("#input").inputValue(), "");
  assert.equal(await log(), before);
  await current.locator("#conversation-details-close").click();
  console.log(
    "PI_NATIVE_DRAFT actual window reload, explicit text-only Restore, Unicode, consent, desktop workspaceStorage/state.vscdb active-row placement and disable/discard passed; no requests",
  );
  return current;
}
