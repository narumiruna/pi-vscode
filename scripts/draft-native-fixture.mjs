import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
  await current.locator("#input").fill(text);
  await current.locator("#input").press("Tab"); // Flush the coalesced text update without submitting.
  await page.waitForTimeout(1000);
  await actualReload();
  await sessions();
  await until(
    async () => await current.locator("#restore-text-draft").isVisible(),
    "retained draft offered after actual reload",
  );
  assert.equal(await current.locator("#input").inputValue(), "", "reload must not insert text automatically");
  assert.equal(await log(), before, "recovery must not submit shell syntax or a model request");
  await expand();
  await current.locator("#restore-text-draft").click();
  await until(async () => (await current.locator("#input").inputValue()) === text, "explicit Unicode draft Restore");
  assert.equal(await current.locator("#attachments [data-remove-attachment]").count(), 0);
  assert.equal(await log(), before);
  await current.locator("#disable-text-drafts").click();
  await until(
    async () => await current.locator("#enable-text-drafts").isVisible(),
    "draft recovery disabled and owned records discarded",
  );
  await page.waitForTimeout(1000);
  await actualReload();
  await sessions();
  await expand();
  assert.equal(await current.locator("#restore-text-draft").isVisible(), false);
  assert.equal(await current.locator("#input").inputValue(), "");
  assert.equal(await log(), before);
  console.log(
    "PI_NATIVE_DRAFT actual window reload, explicit text-only Restore, Unicode, consent and disable/discard passed; no requests",
  );
  return current;
}
