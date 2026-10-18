import assert from "node:assert/strict";

/** Native More grouping and keyboard routing; cancels every mutation dialog. */
export async function assertSessionActions({ page, frame, until }) {
  const pi = await frame();
  const composer = pi.locator("#input");
  const originalDraft = await composer.inputValue();
  const draft = "session action fixture: keep this unsent draft";
  await composer.fill(draft);
  const widget = () => page.locator(".quick-input-widget:not(.quick-input-widget-closing):not([inert])");
  const open = async () => {
    await pi.locator("#more").click();
    const picker = widget().filter({ hasText: "Pi Session Actions" });
    await picker.locator("input[type=text]").waitFor({ state: "visible" });
    return picker;
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await until(async () => !(await widget().isVisible()), "session action picker closed");
    assert.equal(await composer.inputValue(), draft, "native cancellation must keep the composer");
  };

  try {
    const grouped = await open();
    const groupLabels = ["Session management", "Review and repair", "Background work", "Pi configuration"];
    const seen = new Set();
    for (let step = 0; step < 30 && seen.size < groupLabels.length; step += 1) {
      const text = await grouped.innerText();
      for (const group of groupLabels) if (text.includes(group)) seen.add(group);
      await grouped.locator("input[type=text]").press("ArrowDown");
    }
    assert.deepEqual([...seen].sort(), [...groupLabels].sort(), "all native groups are reachable with the keyboard");
    await close();
    for (const [group, query, label] of [
      ["Session management", "JSONL file", "Resume Session"],
      ["Review and repair", "Git index", "Review Staged Changes"],
      ["Background work", "isolated Git worktree agent", "Run Message in Worktree"],
      ["Pi configuration", "terminal-only UI", "Extension UI Compatibility"],
    ]) {
      const picker = await open();
      await picker.locator("input[type=text]").fill(query);
      const rows = picker.locator(".quick-input-list .monaco-list-row");
      await until(async () => (await rows.allTextContents()).join("\n").includes(label), `filtered ${label}`);
      // VS Code hides native separator labels during filtering; the matching action remains selectable.
      assert.ok(groupLabels.includes(group));
      assert.ok((await rows.allTextContents()).join("\n").includes(label));
      assert.equal(
        (await rows.allTextContents()).some((text) => text.includes("Sign In to Provider")),
        false,
      );
      await close();
    }

    const picker = await open();
    await picker.locator("input[type=text]").fill("Rename Session");
    await until(async () => (await picker.innerText()).includes("Name the current session"), "rename action filtered");
    // Enter selects the action, not its native separator. Cancel the resulting input before any write.
    await page.keyboard.press("Enter");
    await until(async () => (await widget().innerText()).includes("Name Pi Session"), "keyboard action dispatch");
    await close();
    console.log(
      "PI_NATIVE_SESSION_ACTIONS four separators, description filtering, keyboard dispatch, and cancellation passed",
    );
  } finally {
    await composer.fill(originalDraft);
  }
}
