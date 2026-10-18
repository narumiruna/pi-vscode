import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/** Actual foreground-child bridge calls and Monaco DOM. No controller access or provider. */
export async function assertNativeAnnotations({ page, directory, workspace, invoke, until, frame, pick }) {
  const codeLines = Array.from({ length: 100 }, (_, index) =>
    index === 30 ? "export const annotationTarget = 31;" : `export const line${index + 1} = ${index + 1};`,
  );
  const markdownLines = Array.from({ length: 100 }, (_, index) =>
    index === 30 ? "This Markdown paragraph is the annotation target." : `Document paragraph line ${index + 1}.`,
  );
  const code = `${codeLines.join("\n")}\n`;
  const markdown = `${markdownLines.join("\n")}\n`;
  await writeFile(path.join(workspace, "annotations.ts"), code);
  await writeFile(path.join(workspace, "annotations.md"), markdown);
  const literal = "[unsafe](command:workbench.action.closeAllEditors) **not bold** <img src=x> ![remote](https://example.invalid/image.png) https://example.invalid/path www.example.invalid test@example.invalid &copy; &#64; &amp;";
  const marks = (lines, offset = 0) => [{
    startLine: 31 + offset,
    endLine: 32 + offset,
    expectedText: lines.slice(30, 32).join("\n"),
    message: literal,
  }];
  let sequence = 0;
  const bridge = async (extra) => {
    const id = ++sequence;
    await writeFile(path.join(directory, "annotation-request.tmp"), JSON.stringify({ id, action: "annotate", ...extra }));
    await rename(path.join(directory, "annotation-request.tmp"), path.join(directory, "annotation-request.json"));
    const response = await until(async () => {
      const value = await readFile(path.join(directory, "annotation-result.json"), "utf8").then(JSON.parse).catch(() => undefined);
      return value?.id === id && value;
    }, "foreground annotation bridge response");
    const { id: _, ...result } = response;
    return result;
  };
  const annotate = (file, annotations = marks(file === "code" ? codeLines : markdownLines)) => bridge({
    path: file === "code" ? "annotations.ts" : "annotations.md", annotations,
  });
  const state = () => invoke("annotationsState");
  const settled = async () => {
    let previous;
    return until(async () => {
      const next = await state();
      const serialized = JSON.stringify(next);
      if (serialized === previous) return next;
      previous = serialized;
    }, "editor selection and scroll settled");
  };
  const focus = () => page.evaluate(() => {
    const active = document.activeElement;
    return {
      tag: active?.tagName, className: active?.className, label: active?.getAttribute("aria-label"),
      viewports: Array.from(document.querySelectorAll(".monaco-editor .view-lines")).map((element) => {
        const bounds = element.getBoundingClientRect();
        return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
      }),
    };
  });
  // Only decoration-generated whole-line nodes count. An accepted bridge response
  // or a hover provider result alone does not prove that a highlight was painted.
  const decorations = () => page.evaluate(() => Array.from(
    document.querySelectorAll(".monaco-editor .view-overlays [class*='ced-']"),
  ).filter((element) => {
    const style = getComputedStyle(element);
    return style.borderTopStyle === "solid" && style.borderTopWidth === "1px" &&
      (style.backgroundColor !== "rgba(0, 0, 0, 0)" || style.borderTopColor !== "rgba(0, 0, 0, 0)") &&
      element.getBoundingClientRect().height > 0;
  }).map((element) => ({ className: element.className, background: getComputedStyle(element).backgroundColor })));
  const rendered = async (present = true) => until(async () => {
    const nodes = await decorations();
    return present ? nodes.length >= 2 && nodes : nodes.length === 0;
  }, present ? "actual whole-line annotation decoration DOM" : "annotation decoration DOM removed");
  const unchanged = async (before, beforeFocus) => {
    assert.deepEqual(await settled(), before, "Annotation calls must preserve tabs, buffers, selection and scroll");
    assert.deepEqual(await focus(), beforeFocus, "Annotation calls must preserve native input focus and pixel scroll geometry");
    assert.equal(await readFile(path.join(workspace, "annotations.ts"), "utf8"), code);
    assert.equal(await readFile(path.join(workspace, "annotations.md"), "utf8"), markdown);
  };
  const hover = async (target) => {
    const line = page.locator(".monaco-editor .view-lines .view-line").filter({ hasText: target }).first();
    await line.hover({ position: { x: 80, y: 8 } });
    const explanation = page.locator(".monaco-hover").filter({ hasText: "Pi annotation" }).first();
    await explanation.waitFor({ state: "visible" });
    const text = (await explanation.innerText()).replaceAll("\u00a0", " ");
    const activeMarkup = await explanation.locator("a, img, strong").evaluateAll((elements) => elements.map((element) => element.outerHTML));
    assert.deepEqual(activeMarkup, [], "Hover must not create links, images or model markup");
    assert.ok(text.includes(literal), `Model markup must remain literal hover text: ${JSON.stringify(text)}`);
    await page.mouse.move(0, 0);
    await page.keyboard.press("Escape");
  };
  const remember = async () => assert.deepEqual(await bridge({ action: "remember" }), { ok: true, remembered: true });
  const stale = async () => assert.deepEqual(await bridge({
    action: "stale", path: "annotations.ts", annotations: marks(codeLines),
  }), { ok: false, stage: "annotate" });
  const prompts = () => readFile(path.join(directory, "prompts.jsonl"), "utf8").catch(() => "");

  // Clear is local, including before any foreground Pi process exists.
  await assert.rejects(readFile(path.join(directory, "pids.jsonl")), { code: "ENOENT" });
  await invoke("command", { command: "pi.clearAnnotations" });
  await assert.rejects(readFile(path.join(directory, "pids.jsonl")), { code: "ENOENT" });
  await invoke("command", { command: "pi.openChat" });
  let pi = await frame();
  await until(async () => (await pi.locator("body").innerText()).includes("Ready"), "annotation foreground ready");
  await until(async () => (await readFile(path.join(directory, "pids.jsonl"), "utf8").catch(() => "")).trim(), "foreground fixture started");
  await invoke("annotationsOpen", { file: "markdown" });
  await invoke("annotationsOpen", { file: "code" });
  await rendered(false);
  let before = await settled();
  let beforeFocus = await focus();
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await rendered();
  await unchanged(before, beforeFocus);

  // The window token does not authorize a terminal, forged credential, session or cwd.
  for (const reject of ["terminal", "credential", "session", "cwd"]) {
    assert.deepEqual(await bridge({ reject, path: "annotations.ts", annotations: marks(codeLines) }), { ok: false, stage: "origin" });
  }
  assert.deepEqual(await annotate("code", [{ ...marks(codeLines)[0], expectedText: "stale source" }]), { ok: false, stage: "annotate" });
  await rendered();
  await unchanged(before, beforeFocus);
  await hover(codeLines[30]);

  // Retain an inactive Markdown tab without displaying or navigating to it.
  before = await settled();
  beforeFocus = await focus();
  assert.deepEqual(await annotate("markdown"), { ok: true, count: 1, visible: false });
  await unchanged(before, beforeFocus);
  await invoke("annotationsOpen", { file: "markdown" });
  await rendered();
  await hover(markdownLines[30]);
  for (const theme of ["Default Light Modern", "Default Dark Modern", "Default High Contrast", "Default High Contrast Light"]) {
    await invoke("theme", { theme });
    await rendered();
  }
  assert.deepEqual(await annotate("markdown", []), { ok: true, count: 0, visible: true });
  await rendered(false);
  await invoke("annotationsOpen", { file: "code" });
  await rendered();

  // A user edit clears rather than relocates ranges. Dirty buffers can be marked,
  // but neither marking nor clear saves their text to disk.
  await invoke("annotationsEdit", { file: "code" });
  await rendered(false);
  before = await settled();
  beforeFocus = await focus();
  assert.ok(before.documents.find((document) => document.uri.endsWith("annotations.ts")).dirty);
  assert.deepEqual(await annotate("code", marks(codeLines, 1)), { ok: true, count: 1, visible: true });
  await rendered();
  await unchanged(before, beforeFocus);
  await invoke("command", { command: "undo" });
  await rendered(false);
  assert.equal((await state()).documents.find((document) => document.uri.endsWith("annotations.ts")).text, code);

  await invoke("annotationsOpen", { file: "markdown" });
  assert.deepEqual(await annotate("markdown"), { ok: true, count: 1, visible: true });
  await rendered();
  await invoke("annotationsClose", { file: "markdown" });
  await until(async () => !(await state()).tabs.includes("annotations.md"), "annotated tab closed");
  assert.deepEqual(await annotate("markdown"), { ok: false, stage: "annotate" }, "Cached closed tabs must not accept new annotations");
  await invoke("annotationsOpen", { file: "markdown" });
  await rendered(false);
  await invoke("annotationsOpen", { file: "code" });

  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  assert.deepEqual(await annotate("markdown"), { ok: true, count: 1, visible: false });
  await remember();
  // Exercise the actual contributed Command Palette entry, not a controller method.
  await page.keyboard.press("F1");
  await page.locator(".quick-input-widget input[type=text]").fill(">Pi: Clear Annotations");
  await page.keyboard.press("Enter");
  await rendered(false);
  await stale();
  await rendered(false);
  await invoke("annotationsOpen", { file: "markdown" });
  await rendered(false);
  await invoke("annotationsOpen", { file: "code" });

  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await remember();
  const reload = await invoke("command", { command: "pi.reloadResources" }, false);
  await page.getByRole("button", { name: "Reload Resources", exact: true }).click();
  await reload();
  await rendered(false);
  await stale();

  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await remember();
  const branch = await invoke("command", { command: "pi.browseSessionTree" }, false);
  await pick("Clone active branch into a new session");
  await branch();
  await rendered(false);
  await stale();
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await rendered();

  await writeFile(path.join(directory, "extension-dialog.tmp"), JSON.stringify({ type: "fixture_exit" }));
  await rename(path.join(directory, "extension-dialog.tmp"), path.join(directory, "extension-dialog.json"));
  await rendered(false);
  pi = await frame();
  await pi.locator("#reconnect").waitFor({ state: "visible" });
  await pi.locator("#reconnect").click();
  await until(async () => !(await pi.locator("#reconnect").isVisible()), "replacement annotation foreground connected");
  await invoke("annotationsOpen", { file: "code" });
  await rendered(false);
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await rendered();
  await invoke("command", { command: "pi.clearAnnotations" });
  await rendered(false);
  assert.equal(await prompts(), "", "Annotation, clear and lifecycle checks must not submit any model prompt");
  assert.equal(await readFile(path.join(workspace, "annotations.ts"), "utf8"), code);
  assert.equal(await readFile(path.join(workspace, "annotations.md"), "utf8"), markdown);
  console.log("PI_NATIVE_ANNOTATIONS", JSON.stringify({
    bridge: "foreground child authenticated annotationOrigin + annotate; no tool-registry loading in fixture",
    rendered: "code and Markdown whole-line decoration DOM, literal safe hover, inactive tab, four themes",
    preserved: "native focus, multiple selections, visible ranges, tabs, buffer versions and file bytes",
    cleared: "edit, Undo, close/reopen, empty array, Command Palette, resource reload, cloned session, disconnect/replacement",
    rejected: "terminal-style missing credential, forged credential/session/cwd, stale text, expired origins",
    provider: "no provider and no model prompts",
  }));
}
