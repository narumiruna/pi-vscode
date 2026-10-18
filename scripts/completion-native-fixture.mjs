import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

// Called by the isolated native UI runner. Pi is its deterministic RPC fixture.
export async function assertNativeFileCompletion({ pi, page, invoke, pick, until, directory, workspace }) {
  const log = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");
  const before = await log();
  await writeFile(path.join(workspace, "completion-capture.txt"), "completion disk snapshot\n");
  await writeFile(path.join(workspace, "completion-path with spaces.txt"), "must not attach path-only bytes\n");
  await writeFile(path.join(workspace, "completion-binary.bin"), Buffer.from([0, 1, 2]));
  const input = pi.locator("#input");
  const menu = pi.locator("#file-completions");
  const search = async text => {
    await input.fill(text);
    await menu.waitFor({ state: "visible" });
  };
  await invoke("completionDirty");
  await search("Explain @completion-capture");
  assert.match(await menu.innerText(), /completion-capture\.txt/);
  await input.press("Enter");
  await until(async () => (await input.inputValue()) === "Explain ", "completion attachment token removed");
  assert.match(await pi.locator("#attachments").innerText(), /completion-capture/);
  await pi.locator("#add-context").click(); await pick("View attachments");
  await until(async () => (await invoke("completionInspection")).includes("completion dirty snapshot"), "completion snapshot inspection");
  await page.keyboard.press("Escape");

  await search("See ./completion-path");
  await input.press("Tab");
  await until(async () => (await input.inputValue()) === 'See "completion-path with spaces.txt"', "path-only insertion");
  assert.equal(await pi.locator("#attachments [data-remove-attachment]").count(), 1);
  await search("Keep @completion-binary"); await input.press("Enter");
  await until(async () => !(await input.evaluate(item => item.readOnly)), "failed capture released composer");
  assert.equal(await input.inputValue(), "Keep @completion-binary");
  assert.equal(await pi.locator("#attachments [data-remove-attachment]").count(), 1);

  await input.fill("@completion-capture"); await input.fill("A newer draft");
  await pi.waitForTimeout(300);
  assert.equal(await input.inputValue(), "A newer draft"); assert.equal(await menu.isVisible(), false);
  assert.equal(await log(), before, "completion, capture and inspection must not send a model request");
  await input.fill("Use the captured completion snapshot once"); await input.press("Enter");
  await until(async () => (await log()).length > before.length, "explicit completion Send recorded");
  await until(async () => !(await pi.locator("#cancel").isVisible()), "completion Send settled");
  const added = (await log()).slice(before.length).trim().split("\n").map(JSON.parse);
  assert.equal(added.length, 1);
  assert.equal(added[0].message.split("completion dirty snapshot").length - 1, 1);
  assert.doesNotMatch(added[0].message, /must not attach path-only bytes|completion disk snapshot/);
  await until(async () => (await pi.locator("#attachments [data-remove-attachment]").count()) === 0, "captured snapshot consumed once");
  console.log("PI_NATIVE_COMPLETION search, dirty capture, inspection, path-only Tab, failed capture, newer draft and explicit single Send passed");
}
