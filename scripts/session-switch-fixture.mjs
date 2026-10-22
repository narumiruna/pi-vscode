import assert from "node:assert/strict";
import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

const stamp = "2026-10-22T00:00:00.000Z";
const ids = ["native-ui-session", "switch-b-002", "switch-c-003"];
const title = "Shared switch fixture";

/** Three saved sessions in the active store, with different history and deterministic recency. */
export async function seedSessionSwitch(directory, cwd) {
  for (const [index, name] of ["switch-b.jsonl", "switch-c.jsonl"].entries()) {
    const id = ids[index + 1];
    const entries = [
      { type: "session", version: 3, id, cwd, timestamp: stamp },
      {
        type: "message", id: `${id}-user`, parentId: null, timestamp: stamp,
        message: { role: "user", content: [{ type: "text", text: `Saved history ${id}` }], timestamp: 1 },
      },
      { type: "session_info", id: `${id}-name`, parentId: `${id}-user`, timestamp: stamp, name: title },
    ];
    await writeFile(path.join(directory, name), `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  }
  await resetRecency(directory);
}

async function resetRecency(directory) {
  const now = Date.now() - 10_000;
  for (const [index, name] of ["session.jsonl", "switch-b.jsonl", "switch-c.jsonl"].entries()) {
    const date = new Date(now - index * 1_000);
    await utimes(path.join(directory, name), date, date);
  }
}

/** Native Quick Pick, real keyboard dispatch and authoritative fixture RPC history; no model. */
export async function assertNativeSessionSwitch({ page, directory, workspace, invoke, until, frame }) {
  const optional = (name) => readFile(path.join(directory, name), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const switches = async () => (await optional("switches.jsonl")).trim().split("\n").filter(Boolean).map(JSON.parse);
  const count = async () => (await switches()).length;
  const promptsBefore = await optional("prompts.jsonl");
  const switchesBefore = await optional("switches.jsonl");
  const widget = () => page.locator(".quick-input-widget:not(.quick-input-widget-closing):not([inert])");
  const input = () => widget().locator("input[type=text]");
  const rows = () => widget().locator(".quick-input-list .monaco-list-row");
  const chord = async (key) => {
    await page.keyboard.press("Control+k");
    await page.keyboard.press(`Control+Alt+Shift+${key}`);
  };
  const pi = await frame();
  const composer = pi.locator("#input");
  const originalDraft = await composer.inputValue();
  const draft = "session switch cancellation keeps this draft";
  await composer.fill(draft);
  const start = async () => {
    const commandId = await invoke("startCommand", { command: "pi.switchSession" });
    await input().waitFor({ state: "visible" });
    assert.match(await widget().innerText(), /Switch Pi Session/);
    return async () => {
      const result = await until(async () => {
        const state = await invoke("commandResult", { commandId });
        return state?.complete && state;
      }, "session picker command completed");
      return result;
    };
  };
  const close = async () => {
    await page.keyboard.press("Escape");
    await until(async () => !(await widget().isVisible()), "session picker cancelled");
  };
  const history = async (id) => {
    await until(async () => {
      const current = (await switches()).at(-1);
      return current?.sessionId === id;
    }, `fixture switched to ${id}`);
    await until(async () => (await pi.locator("#messages").innerText()).includes(
      id === ids[0] ? "ACTIVE_BRANCH_ONLY" : `Saved history ${id}`,
    ), `authoritative history ${id}`);
    await until(async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected",
      "session switch UI idle");
    assert.equal(await pi.locator("#app").evaluate((node) => node.classList.contains("sessions-layer")), false);
  };
  const choose = async (id) => {
    const before = await count();
    const done = await start();
    await input().fill(id);
    await until(async () => (await rows().allTextContents()).some((text) => text.includes(id)), `ID filter ${id}`);
    await input().press("Enter");
    const result = await done();
    assert.equal(result.error, undefined);
    await until(async () => await count() === before + 1, "exactly one session switch RPC");
    await history(id);
  };
  try {
    // The generated native defaults include platform rules and built-in extension contributions.
    const defaults = await invoke("sessionSwitchDefaults");
    const bindings = [...defaults.matchAll(/\{\s*"key"\s*:\s*"([^"]+)"\s*,\s*"command"\s*:\s*"([^"]+)"/g)]
      .map((match) => ({ key: match[1].toLowerCase(), command: match[2] }));
    assert.ok(bindings.length > 100, "Native default keybinding inspection must not silently parse an empty document");
    const candidates = ["ctrl+k ctrl+alt+shift+s", "ctrl+k ctrl+alt+shift+left", "ctrl+k ctrl+alt+shift+right"];
    const commands = ["pi.switchSession", "pi.previousSession", "pi.nextSession"];
    const normalizeKey = (value) => value.split(" ").map((stroke) => stroke.split("+").sort().join("+")).join(" ");
    const resolvedDefaults = [];
    for (const [index, key] of candidates.entries()) {
      const matches = bindings.filter((binding) => normalizeKey(binding.key) === normalizeKey(key));
      resolvedDefaults.push(...matches);
      assert.ok(matches.some((binding) => binding.command === commands[index]), `Missing native default ${key}`);
      assert.deepEqual(matches.filter((binding) => binding.command !== commands[index]), [], `Built-in conflict: ${key}`);
    }
    await invoke("source");
    const before = await count();
    let done = await start();
    await input().fill(title);
    await until(async () => (await rows().allTextContents()).filter((text) => text.includes(title)).length === 2,
      "duplicate session titles remain searchable");
    await input().fill(ids[1]);
    await until(async () => (await rows().allTextContents()).filter((text) => text.includes(ids[1])).length === 1,
      "description matching distinguishes duplicate titles");
    await close();
    assert.equal((await done()).error, undefined);
    assert.equal(await count(), before);
    assert.equal(await composer.inputValue(), draft);
    assert.equal((await invoke("state")).active.endsWith("/source.ts"), true, "Cancellation preserves editor focus");
    done = await start();
    await input().fill(ids[0]);
    await until(async () => (await rows().allTextContents()).some((text) => /current/i.test(text)), "current marker");
    await input().press("Enter");
    assert.equal((await done()).error, undefined);
    assert.equal(await count(), before, "Selecting the active session is a no-op");
    assert.equal(await composer.inputValue(), draft);

    await choose(ids[1]);
    assert.equal(await composer.inputValue(), draft, "Successful switching preserves newer text for explicit review");
    await composer.fill("");
    await choose(ids[0]);
    await resetRecency(directory);
    // Explicit search selection starts a new cycle from the refreshed recent order.
    await choose(ids[1]);
    await choose(ids[0]);
    for (const [command, expected] of [
      ["pi.nextSession", ids[1]], ["pi.nextSession", ids[2]], ["pi.nextSession", ids[0]],
      ["pi.previousSession", ids[2]], ["pi.previousSession", ids[1]], ["pi.previousSession", ids[0]],
    ]) {
      const n = await count();
      await invoke("command", { command });
      await history(expected);
      assert.equal(await count(), n + 1);
      // A write makes each selected file newest: a naive MRU rebuild will bounce between two files.
      const selected = (await switches()).at(-1).sessionFile;
      const now = new Date(Date.now() + 5_000);
      await utimes(selected, now, now);
    }

    // All three default chords dispatch from the source editor and the Pi composer.
    for (const focus of [async () => invoke("source"), async () => composer.focus()]) {
      await focus();
      await chord("s");
      await input().waitFor({ state: "visible" });
      assert.match(await widget().innerText(), /Switch Pi Session/);
      await close();
      let n = await count();
      await focus();
      await chord("ArrowRight");
      await until(async () => await count() === n + 1, "Next Session keybinding");
      const nextId = (await switches()).at(-1).sessionId;
      await history(nextId);
      n = await count();
      await focus();
      await chord("ArrowLeft");
      await until(async () => await count() === n + 1, "Previous Session keybinding");
      await history(ids[0]);
    }

    // An existing Quick Pick must retain its value and must not be replaced by the session picker.
    await pi.locator("#more").click();
    await input().waitFor({ state: "visible" });
    await input().fill("Word wrap");
    const pickerBefore = await widget().innerText();
    const n = await count();
    for (const key of ["s", "ArrowLeft", "ArrowRight"]) await chord(key);
    assert.equal(await input().inputValue(), "Word wrap");
    assert.equal(await widget().innerText(), pickerBefore);
    assert.equal(await count(), n);
    await close();

    await invoke("sessionSwitchTerminal", { operation: "open" });
    await page.locator(".terminal.xterm.focus, .terminal .xterm.focus, .xterm.focus").first().waitFor({ state: "visible" });
    for (const key of ["s", "ArrowLeft", "ArrowRight"]) await chord(key);
    await page.keyboard.type("terminal-no-capture");
    await until(async () => (await invoke("sessionSwitchTerminal", { operation: "state" })).input.includes("terminal-no-capture"),
      "ordinary terminal input reaches the fixture terminal");
    assert.equal(await count(), n, "Session chords do not switch over terminal input");
    assert.equal(await widget().isVisible(), false);
    await invoke("sessionSwitchTerminal", { operation: "close" });

    // Change a destination's cwd after offering it; no cross-workspace RPC is permitted.
    const destination = path.join(directory, "switch-c.jsonl");
    const bytes = await readFile(destination, "utf8");
    done = await start();
    await input().fill(ids[2]);
    await until(async () => (await rows().allTextContents()).some((text) => text.includes(ids[2])), "stale destination offered");
    await writeFile(destination, bytes.replace(JSON.stringify(workspace), JSON.stringify(path.dirname(workspace))));
    await input().press("Enter");
    await done();
    assert.equal(await count(), n, "A changed workspace header fails closed before switch_session");
    await writeFile(destination, bytes);
    await invoke("command", { command: "notifications.clearAll" });
    assert.equal(await optional("prompts.jsonl"), promptsBefore, "Session navigation never requests a model");
    console.log("PI_NATIVE_SESSION_SWITCH", JSON.stringify({
      defaults: resolvedDefaults, conflicts: [],
      picker: "title/description filtering, duplicate titles, cancellation, current no-op, authoritative history",
      cycle: "three sessions, both wraparound directions, stable after selected-file mtime changes",
      keyboard: "editor/composer dispatch; terminal and open Quick Pick excluded",
      staleDestination: "changed cwd rejected before RPC", provider: "fixture only",
    }));
  } finally {
    await invoke("sessionSwitchTerminal", { operation: "close" });
    await composer.fill(originalDraft);
    // Keep this fixture's RPC ledger separate from later transfer assertions in the shared runner.
    if (switchesBefore) await writeFile(path.join(directory, "switches.jsonl"), switchesBefore);
    else await rm(path.join(directory, "switches.jsonl"), { force: true });
    await rm(path.join(directory, "switch-b.jsonl"), { force: true });
    await rm(path.join(directory, "switch-c.jsonl"), { force: true });
  }
}
