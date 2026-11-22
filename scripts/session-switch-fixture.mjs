import assert from "node:assert/strict";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const stamp = "2026-10-22T00:00:00.000Z";
const ids = ["native-ui-session", "switch-b-002", "switch-c-003"];
const title = "Shared switch fixture";

/** Three saved sessions in the active store, with different history and deterministic recency. */
export async function seedSessionSwitch(directory, cwd) {
  for (const [index, name] of ["switch-b.jsonl", "switch-c.jsonl"].entries()) {
    await writeFile(path.join(directory, name), savedSession(ids[index + 1], cwd));
  }
  await resetRecency(directory);
}

function savedSession(id, cwd) {
  return `${[
    { type: "session", version: 3, id, cwd, timestamp: stamp },
    {
      type: "message", id: `${id}-user`, parentId: null, timestamp: stamp,
      message: { role: "user", content: [{ type: "text", text: `Saved history ${id}` }], timestamp: 1 },
    },
    { type: "session_info", id: `${id}-name`, parentId: `${id}-user`, timestamp: stamp, name: title },
  ].map((entry) => JSON.stringify(entry)).join("\n")}\n`;
}

async function resetRecency(directory) {
  const now = Date.now() - 10_000;
  for (const [index, name] of ["session.jsonl", "switch-b.jsonl", "switch-c.jsonl"].entries()) {
    const date = new Date(now - index * 1_000);
    await utimes(path.join(directory, name), date, date);
  }
}

/** Shared native UI driver. Selection is checked in the real DOM, never synthesized IPC. */
export async function nativeSidebarFixture({ page, directory, invoke, until, frame }) {
  const pi = await frame();
  const optional = (name) => readFile(path.join(directory, name), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const records = async (name) => (await optional(name)).trim().split("\n").filter(Boolean).map(JSON.parse);
  const widget = () => page.locator(".quick-input-widget:not(.quick-input-widget-closing):not([inert])");
  const input = () => widget().locator("input[type=text]");
  const rows = () => widget().locator(".quick-input-list .monaco-list-row");
  const modal = async (name) => {
    const dialog = page.locator(".monaco-dialog-box");
    await dialog.waitFor({ state: "visible" });
    await dialog.getByRole("button", { name, exact: true }).click();
    await dialog.waitFor({ state: "hidden" });
  };
  const start = async () => {
    const commandId = await invoke("startCommand", { command: "pi.switchSession" });
    await input().waitFor({ state: "visible" });
    assert.match(await widget().innerText(), /Switch Pi Session/);
    return async () => until(async () => {
      const state = await invoke("commandResult", { commandId });
      return state?.complete && state;
    }, "session picker command completed");
  };
  const closePicker = async () => {
    await page.keyboard.press("Escape");
    await until(async () => !(await widget().isVisible()), "session picker cancelled");
  };
  const selected = async (id) => {
    await until(async () => await pi.locator("#session").inputValue() === id, `selected retained session ${id}`);
    await until(async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected" ||
      (await pi.locator("#runtime").getAttribute("data-connection")) === "busy", "selected runtime ready");
    assert.equal(await pi.locator("#app").evaluate((node) => node.classList.contains("sessions-layer")), false);
  };
  const choose = async (id, cold = false) => {
    const starts = await optional("starts.jsonl");
    const switches = await optional("switches.jsonl");
    const done = await start();
    await input().fill(id);
    await until(async () => (await rows().allTextContents()).filter((text) => text.includes(id)).length === 1,
      `description filter ${id}`);
    await input().press("Enter");
    assert.equal((await done()).error, undefined);
    await selected(id);
    assert.equal(await optional("switches.jsonl"), switches, "Sidebar selection never sends switch_session");
    if (!cold) assert.equal(await optional("starts.jsonl"), starts, "Retained selection never launches another process");
  };
  const closeSelected = async (primaryId = ids[0]) => {
    const id = await pi.locator("#session").inputValue();
    const pid = (await records("starts.jsonl")).filter((entry) => entry.sessionId === id).at(-1)?.pid;
    await pi.locator("#close-sidebar-session").click();
    await modal("Close Session");
    await selected(primaryId);
    if (pid) await until(() => {
      try { process.kill(pid, 0); return false; } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    }, `closed Sidebar process ${id} exited`);
  };
  return { pi, optional, records, widget, input, rows, start, closePicker, selected, choose, closeSelected };
}

/** Native Quick Pick and real keyboard dispatch over independent retained Sidebar runtimes. */
export async function assertNativeSessionSwitch(options) {
  const { page, directory, workspace, invoke, until } = options;
  const ui = await nativeSidebarFixture(options);
  const { pi, optional, records, widget, input, rows, start, closePicker, selected, choose, closeSelected } = ui;
  const composer = pi.locator("#input");
  const originalDraft = await composer.inputValue();
  const draft = "A session switch cancellation keeps this draft";
  const bDraft = "B independent retained draft 日本語";
  const promptsBefore = await optional("prompts.jsonl");
  const switchesBefore = await optional("switches.jsonl");
  const startsBefore = await records("starts.jsonl");
  const opened = new Set();
  const invalidFile = path.join(directory, "switch-invalid.jsonl");
  const chord = async (key) => {
    await page.keyboard.press("Control+k");
    await page.keyboard.press(`Control+Alt+Shift+${key}`);
  };
  try {
    await composer.fill(draft);
    const defaults = await invoke("sessionSwitchDefaults");
    const bindings = [...defaults.matchAll(/\{\s*"key"\s*:\s*"([^"]+)"\s*,\s*"command"\s*:\s*"([^"]+)"/g)]
      .map((match) => ({ key: match[1].toLowerCase(), command: match[2] }));
    assert.ok(bindings.length > 100, "Native default keybindings must not silently parse an empty document");
    const candidates = ["ctrl+k ctrl+alt+shift+s", "ctrl+k ctrl+alt+shift+left", "ctrl+k ctrl+alt+shift+right"];
    const commands = ["pi.switchSession", "pi.previousSession", "pi.nextSession"];
    const normalize = (value) => value.split(" ").map((stroke) => stroke.split("+").sort().join("+")).join(" ");
    const resolvedDefaults = [];
    for (const [index, key] of candidates.entries()) {
      const matches = bindings.filter((binding) => normalize(binding.key) === normalize(key));
      resolvedDefaults.push(...matches);
      assert.ok(matches.some((binding) => binding.command === commands[index]), `Missing native default ${key}`);
      assert.deepEqual(matches.filter((binding) => binding.command !== commands[index]), [], `Built-in conflict: ${key}`);
    }
    await invoke("source");
    const noStart = await optional("starts.jsonl");
    let done = await start();
    await input().fill(title);
    await until(async () => (await rows().allTextContents()).filter((text) => text.includes(title)).length === 2,
      "duplicate session titles searchable");
    await input().fill(ids[1]);
    await until(async () => (await rows().allTextContents()).filter((text) => text.includes(ids[1])).length === 1,
      "description matching distinguishes duplicate titles");
    await closePicker();
    assert.equal((await done()).error, undefined);
    assert.equal(await optional("starts.jsonl"), noStart);
    assert.equal(await composer.inputValue(), draft);
    assert.equal((await invoke("state")).active.endsWith("/source.ts"), true, "Cancellation preserves editor focus");
    done = await start();
    await input().fill(ids[0]);
    await until(async () => (await rows().allTextContents()).some((text) => /current/i.test(text)), "current marker");
    await input().press("Enter");
    assert.equal((await done()).error, undefined);
    assert.equal(await optional("starts.jsonl"), noStart, "Selecting current does not start another runtime");
    assert.equal(await composer.inputValue(), draft);

    await choose(ids[1], true);
    opened.add(ids[1]);
    const bStarts = (await records("starts.jsonl")).filter((entry) => entry.sessionId === ids[1]);
    assert.equal(bStarts.length, 1, "Saved B gets exactly one cold process");
    assert.equal(bStarts[0].sessionArgument, path.join(directory, "switch-b.jsonl"), "Cold B uses --session");
    assert.match(await pi.locator("#messages").innerText(), /Saved history switch-b-002/);
    assert.equal(await composer.inputValue(), "", "A draft must not become B draft");
    await composer.fill(bDraft);
    await choose(ids[0]);
    assert.equal(await composer.inputValue(), draft);
    assert.match(await pi.locator("#messages").innerText(), /ACTIVE_BRANCH_ONLY/);
    await choose(ids[1]);
    assert.equal(await composer.inputValue(), bDraft);
    await choose(ids[2], true);
    opened.add(ids[2]);
    assert.equal(await composer.inputValue(), "");
    assert.match(await pi.locator("#messages").innerText(), /Saved history switch-c-003/);
    await choose(ids[0]);
    await resetRecency(directory);
    const warmStarts = await optional("starts.jsonl");
    for (const [command, expected] of [
      ["pi.nextSession", ids[1]], ["pi.nextSession", ids[2]], ["pi.nextSession", ids[0]],
      ["pi.previousSession", ids[2]], ["pi.previousSession", ids[1]], ["pi.previousSession", ids[0]],
    ]) {
      await invoke("command", { command });
      await selected(expected);
      const file = (await records("starts.jsonl")).find((entry) => entry.sessionId === expected).sessionFile;
      const now = new Date(Date.now() + 5_000);
      await utimes(file, now, now);
      assert.equal(await optional("starts.jsonl"), warmStarts, "Stable cycling reuses each retained runtime");
    }
    for (const focus of [async () => invoke("source"), async () => composer.focus()]) {
      await focus();
      await chord("s");
      await input().waitFor({ state: "visible" });
      assert.match(await widget().innerText(), /Switch Pi Session/);
      await closePicker();
      await focus();
      await chord("ArrowRight");
      await selected(ids[1]);
      await focus();
      await chord("ArrowLeft");
      await selected(ids[0]);
    }
    await pi.locator("#more").click();
    await input().waitFor({ state: "visible" });
    await input().fill("Word wrap");
    const pickerBefore = await widget().innerText();
    for (const key of ["s", "ArrowLeft", "ArrowRight"]) await chord(key);
    assert.equal(await input().inputValue(), "Word wrap");
    assert.equal(await widget().innerText(), pickerBefore);
    await closePicker();
    await invoke("sessionSwitchTerminal", { operation: "open" });
    await page.locator(".terminal.xterm.focus, .terminal .xterm.focus, .xterm.focus").first().waitFor({ state: "visible" });
    for (const key of ["s", "ArrowLeft", "ArrowRight"]) await chord(key);
    await page.keyboard.type("terminal-no-capture");
    await until(async () => (await invoke("sessionSwitchTerminal", { operation: "state" })).input.includes("terminal-no-capture"),
      "ordinary terminal input reaches fixture terminal");
    assert.equal(await pi.locator("#session").inputValue(), ids[0], "Session chords do not switch over terminal input");
    assert.equal(await widget().isVisible(), false);
    assert.equal(await optional("starts.jsonl"), warmStarts);
    await invoke("sessionSwitchTerminal", { operation: "close" });

    // This destination has never owned a runtime. Change its header after offering it.
    const invalidId = "switch-invalid-004";
    await writeFile(invalidFile, savedSession(invalidId, workspace));
    done = await start();
    await input().fill(invalidId);
    await until(async () => (await rows().allTextContents()).some((text) => text.includes(invalidId)), "cold destination offered");
    await writeFile(invalidFile, savedSession(invalidId, path.dirname(workspace)));
    await input().press("Enter");
    await done();
    assert.equal(await optional("starts.jsonl"), warmStarts, "Changed header rejected before cold process startup");
    assert.equal(await optional("switches.jsonl"), switchesBefore, "No navigation sends switch_session");
    assert.equal(await optional("prompts.jsonl"), promptsBefore, "Navigation never requests a model");
    if (await pi.locator("#close-sidebar-session").isVisible()) await closeSelected();
    await choose(ids[0]);
    await invoke("command", { command: "notifications.clearAll" });
    console.log("PI_NATIVE_SESSION_SWITCH", JSON.stringify({
      defaults: resolvedDefaults, conflicts: [],
      picker: "duplicate titles, description search, cancel, current, saved B cold --session without confirmation",
      drafts: "A/B independent and retained", cycle: "three retained runtimes, both wraparounds, mtime stable",
      keyboard: "editor/composer dispatch; terminal and Quick Pick excluded",
      staleDestination: "invalid cold header rejected before startup", switchSessionCalls: 0,
      coldStarts: (await records("starts.jsonl")).length - startsBefore.length, provider: "fixture only",
    }));
  } finally {
    await invoke("sessionSwitchTerminal", { operation: "close" });
    for (const id of [...opened].reverse()) {
      await choose(id);
      await closeSelected();
    }
    await choose(ids[0]);
    await composer.fill(originalDraft);
    await rm(invalidFile, { force: true });
    await rm(path.join(directory, "switch-b.jsonl"), { force: true });
    await rm(path.join(directory, "switch-c.jsonl"), { force: true });
  }
}
