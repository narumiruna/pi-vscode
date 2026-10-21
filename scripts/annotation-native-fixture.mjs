import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

// Native comments may open the Comments panel and change layout/visible ranges.
// Source state, tabs, active editor and selections must still be unchanged.
function editorIdentity({ visibleRanges: _, editors, ...state }) {
  return {
    ...state,
    editors: editors.map(({ visibleRanges: _, ...editor }) => editor),
  };
}

function inputFocus({ tag, className, label }) {
  return { tag, className, label };
}

/** Feasibility gate only: test-owned stable Comment API, not the production bridge. */
export async function assertNativeAnnotationPrototype({ page, workspace, invoke, until, version, evidenceLabel }) {
  const lines = Array.from({ length: 100 }, (_, index) => `export const line${index + 1} = ${index + 1};`);
  const code = lines.join("\n"); // EOF intentionally has no trailing newline.
  const markdown = lines.map((_, index) => `Document paragraph line ${index + 1}.`).join("\n");
  await writeFile(path.join(workspace, "annotations.ts"), code);
  await writeFile(path.join(workspace, "annotations.md"), markdown);
  const literal =
    "[unsafe](command:workbench.action.closeAllEditors) **not bold** <img src=x> ![remote](https://example.invalid/image.png) https://example.invalid/path www.example.invalid test@example.invalid &copy; &#64; &amp;";
  const chinese = "多行中文说明。原始文字必须完整显示。\n第二行说明在窄编辑器中换行，不得修改源文件。";
  const replace = (file, annotations) => invoke("annotationPrototype", { file, annotations });
  const clear = () => invoke("annotationPrototype", { operation: "clear" });
  const widgets = () => page.locator(".monaco-editor .review-widget").filter({ hasText: "Pi annotation" });
  const bodies = () => widgets().locator(".comment-body");
  const state = () => invoke("annotationsState");
  const settled = async () => {
    let previous;
    return until(async () => {
      const next = await state();
      const serialized = JSON.stringify(next);
      if (previous === serialized) return next;
      previous = serialized;
    }, "prototype editor state settled");
  };
  const focus = () =>
    page.evaluate(() => {
      const active = document.activeElement;
      return {
        tag: active?.tagName,
        className: active?.className,
        label: active?.getAttribute("aria-label"),
        panelVisible: !!document.querySelector(".part.panel")?.checkVisibility(),
        commentsVisible: !!document.querySelector(".comments-panel")?.checkVisibility(),
        editors: Array.from(document.querySelectorAll(".monaco-editor"))
          .filter((editor) => editor.checkVisibility() && editor.getBoundingClientRect().height > 0)
          .map((editor) => {
            const viewport = editor.querySelector(".view-lines");
            const firstLine = viewport?.querySelector(".view-line");
            const bounds = editor.getBoundingClientRect();
            const firstBounds = firstLine?.getBoundingClientRect();
            const scroll = editor.querySelector(".editor-scrollable");
            return {
              x: bounds.x,
              y: bounds.y,
              width: bounds.width,
              height: bounds.height,
              firstLine: firstLine?.textContent,
              firstX: firstBounds?.x,
              firstY: firstBounds?.y,
              scroll: { left: scroll?.scrollLeft, top: scroll?.scrollTop },
            };
          }),
      };
    });
  const rememberFocus = async () => ({
    snapshot: await focus(),
    element: await page.evaluateHandle(() => document.activeElement),
  });
  const unchanged = async (before, beforeFocus) => {
    try {
      assert.ok(
        await beforeFocus.element.evaluate((element) => element === document.activeElement),
        "Native threads must preserve the exact focused element",
      );
      assert.deepEqual(
        inputFocus(await focus()),
        inputFocus(beforeFocus.snapshot),
        "Native threads must preserve input focus; panel and layout changes are permitted",
      );
    } finally {
      await beforeFocus.element.dispose();
    }
    assert.deepEqual(
      editorIdentity(await settled()),
      editorIdentity(before),
      "Native threads must preserve tabs, buffers, active editor and selections",
    );
    assert.equal(await readFile(path.join(workspace, "annotations.ts"), "utf8"), code);
    assert.equal(await readFile(path.join(workspace, "annotations.md"), "utf8"), markdown);
  };
  const literalBodies = async (messages) => {
    await until(
      async () => (await bodies().count()) === messages.length,
      "expanded native comment bodies without hover",
    );
    // MarkdownString.appendText maps line breaks to native paragraphs. innerText adds
    // paragraph spacing; compare each full literal line, not that layout whitespace.
    for (const [index, message] of messages.entries()) {
      assert.deepEqual(
        (await bodies().nth(index).locator("p").allTextContents()).map((text) => text.replaceAll("\u00a0", " ")),
        message.split("\n"),
      );
    }
    for (const body of await bodies().all())
      assert.ok(await body.isVisible(), "Native comment body must be visible without hover");
    assert.equal(
      await bodies().locator("a, img, strong, code").count(),
      0,
      "Model text must not create links, images, commands or Markdown formatting",
    );
    assert.equal(
      await widgets().locator("textarea:visible, [contenteditable=true]:visible").count(),
      0,
      "Read-only threads must not expose a reply editor",
    );
    assert.equal(
      await widgets()
        .getByRole("button", { name: /edit|reply|react|new comment|add comment/i })
        .count(),
      0,
      "Threads must not expose mutation actions",
    );
  };
  const below = async (lineText) => {
    const line = page.locator(".monaco-editor .view-line").filter({ hasText: lineText }).first();
    const anchor = await line.boundingBox();
    const widget = await widgets().first().boundingBox();
    const editor = await line.evaluate((node) => {
      const bounds = node.closest(".monaco-editor").getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, right: bounds.right, bottom: bounds.bottom };
    });
    assert.ok(
      anchor &&
        widget &&
        widget.height > 0 &&
        widget.y >= anchor.y + anchor.height - 2 &&
        widget.y <= anchor.y + anchor.height * 2 + 8 &&
        widget.x >= editor.x &&
        widget.x + widget.width <= editor.right + 1 &&
        widget.y < editor.bottom &&
        widget.y + widget.height > editor.y,
      `Expanded thread must be adjacent to its range end inside the intended editor: ${JSON.stringify({ anchor, widget, editor })}`,
    );
  };
  const clearPreserving = async () => {
    const before = await settled();
    const beforeFocus = await rememberFocus();
    await clear();
    await until(async () => (await widgets().count()) === 0, "owned native widget disposed");
    await unchanged(before, beforeFocus);
  };
  await invoke("annotationsOpen", { file: "markdown" });
  await invoke("annotationsOpen", { file: "code" });
  let before = await settled();
  let beforeFocus = await rememberFocus();
  await page.screenshot({ path: path.join(tmpdir(), `pi-annotation-prototype-${evidenceLabel}-before.png`) });
  await replace("code", [
    { endLine: 32, message: literal },
    { endLine: 32, message: chinese },
  ]);
  await literalBodies([literal, chinese]);
  assert.equal(await widgets().count(), 1, "Same-anchor explanations must share one widget in input order");
  await below(lines[31]);
  await page.screenshot({ path: path.join(tmpdir(), `pi-annotation-prototype-${evidenceLabel}-expanded.png`) });
  console.log(
    "PI_ANNOTATION_PROTOTYPE_PLACEMENT",
    JSON.stringify({
      version,
      platform: process.platform,
      literal: true,
      sameAnchor: true,
      before: { focus: beforeFocus.snapshot, visibleRanges: before.visibleRanges },
      after: { focus: await focus(), visibleRanges: (await settled()).visibleRanges },
    }),
  );
  await unchanged(before, beforeFocus);

  // User-driven native collapse/reopen must survive tab changes without recreation.
  await widgets()
    .first()
    .getByRole("button", { name: /collapse|hide/i })
    .click();
  await until(async () => (await widgets().count()) === 0, "native thread collapsed");
  await invoke("annotationsOpen", { file: "markdown" });
  await invoke("annotationsOpen", { file: "code" });
  assert.equal(await widgets().count(), 0, "Tab changes must preserve collapse state");
  await page.locator(".comment-range-glyph").first().click();
  await literalBodies([literal, chinese]);
  before = await settled();
  beforeFocus = await rememberFocus();
  await replace("code", [{ endLine: 32, message: "Replacement explanation" }]);
  await literalBodies(["Replacement explanation"]);
  await unchanged(before, beforeFocus);
  await clearPreserving();

  // Inactive creation must not navigate. Explicit fixture actions represent user navigation.
  before = await settled();
  beforeFocus = await rememberFocus();
  await replace("markdown", [{ endLine: 32, message: chinese }]);
  await unchanged(before, beforeFocus);
  await invoke("annotationsOpen", { file: "markdown" });
  await literalBodies([chinese]);
  for (const theme of [
    "Default Light Modern",
    "Default Dark Modern",
    "Default High Contrast",
    "Default High Contrast Light",
  ]) {
    await invoke("theme", { theme });
    await literalBodies([chinese]);
  }
  await page.setViewportSize({ width: 720, height: 900 });
  // Explicit fixture navigation represents a user inspecting the resized native widget.
  await invoke("annotationsPosition", { file: "markdown", line: 32 });
  await literalBodies([chinese]);
  // In narrow Markdown editors, VS Code wraps the source line across DOM view lines.
  await below("line 32.");
  assert.ok(
    await bodies()
      .locator("p")
      .evaluateAll((paragraphs) => paragraphs.every((paragraph) => paragraph.scrollWidth <= paragraph.clientWidth + 1)),
    "Chinese paragraphs must wrap within the narrow comment body",
  );
  await clearPreserving();
  await invoke("annotationsPosition", { file: "code", line: 100 });
  before = await settled();
  beforeFocus = await rememberFocus();
  await replace("code", [{ endLine: 100, message: "EOF without a trailing newline" }]);
  await literalBodies(["EOF without a trailing newline"]);
  await below(lines[99]);
  await unchanged(before, beforeFocus);
  await clearPreserving();
  await invoke("annotationsDiff");
  before = await settled();
  beforeFocus = await rememberFocus();
  await replace("code", [{ endLine: 32, message: "Modified-side diff explanation" }]);
  await literalBodies(["Modified-side diff explanation"]);
  await below(lines[31]);
  await unchanged(before, beforeFocus);
  await invoke("command", { command: "workbench.action.focusCommentsPanel" });
  await until(
    async () => (await page.locator(".comments-panel").innerText()).replaceAll("\u00a0", " ").includes("Modified-side diff explanation"),
    "native Comments panel entry",
  );
  // Return focus to the source as an explicit user action before disposal. A removed
  // Comments-panel row cannot retain DOM focus after its controller is disposed.
  await invoke("annotationsPosition", { file: "code", line: 32 });
  before = await settled();
  beforeFocus = await rememberFocus();
  await invoke("annotationPrototype", { operation: "dispose" });
  await until(async () => (await widgets().count()) === 0, "all owned editor widgets removed on disposal");
  await until(
    async () => !(await page.locator(".comments-panel").innerText()).replaceAll("\u00a0", " ").includes("Modified-side diff explanation"),
    "owned Comments panel entry removed",
  );
  await unchanged(before, beforeFocus);
  assert.equal(await readFile(path.join(workspace, "annotations.ts"), "utf8"), code);
  assert.equal(await readFile(path.join(workspace, "annotations.md"), "utf8"), markdown);
  console.log(
    "PI_ANNOTATION_PROTOTYPE_GATE",
    JSON.stringify({
      version,
      platform: process.platform,
      result: "passed",
      provider: "none; test-owned controller only",
    }),
  );
}

/** Actual foreground-child bridge calls and Monaco DOM. No controller access or provider. */
export async function assertNativeAnnotations({ page, directory, workspace, invoke, until, frame, pick }) {
  const codeLines = Array.from({ length: 100 }, (_, index) =>
    index === 30 ? "export const annotationTarget = 31;" : `export const line${index + 1} = ${index + 1};`,
  );
  const markdownLines = Array.from({ length: 100 }, (_, index) =>
    index === 30 ? "This Markdown paragraph is the annotation target." : `Document paragraph line ${index + 1}.`,
  );
  const code = codeLines.join("\n"); // Exercise EOF without a trailing newline.
  const markdown = markdownLines.join("\n");
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

    };
  });
  const widgets = () => page.locator(".monaco-editor .review-widget").filter({ hasText: "Pi annotation" });
  const nativeBodies = async (messages) => {
    const bodies = widgets().locator(".comment-body");
    await until(async () => (await bodies.count()) === messages.length, "production expanded native explanations");
    for (const [index, message] of messages.entries()) {
      assert.deepEqual(
        (await bodies.nth(index).locator("p").allTextContents()).map((text) => text.replaceAll("\u00a0", " ")),
        message.split("\n"),
      );
      assert.ok(await bodies.nth(index).isVisible(), "Explanations must display without hover");
    }
    assert.equal(await bodies.locator("a, img, strong, code").count(), 0, "Native explanations must remain literal text");
    assert.equal(await widgets().locator("textarea:visible, [contenteditable=true]:visible").count(), 0);
    assert.equal(await widgets().getByRole("button", { name: /edit|reply|react|new comment|add comment/i }).count(), 0);
  };
  const below = async (target) => {
    const line = await page.locator(".monaco-editor .view-line").filter({ hasText: target }).first().boundingBox();
    const widget = await widgets().first().boundingBox();
    assert.ok(line && widget && widget.height > 0 && widget.y >= line.y + line.height - 2 &&
      widget.y <= line.y + line.height * 2 + 8, "Native explanation must appear directly below the passage end");
  };
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
    return present ? nodes.length >= 2 && nodes : nodes.length === 0 && (await widgets().count()) === 0;
  }, present ? "actual whole-line annotation decoration DOM" : "annotation decorations and native threads removed");
  const unchanged = async (before, beforeFocus) => {
    assert.deepEqual(editorIdentity(await settled()), editorIdentity(before), "Annotation calls must preserve tabs, buffers, active editor and selections");
    assert.deepEqual(await focus(), beforeFocus, "Annotation calls must preserve native input focus");
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
  await until(async () => (await pi.locator("#runtime").getAttribute("data-connection")) === "connected" &&
    (await pi.locator("#status").textContent()) === "", "annotation foreground idle");
  await until(async () => (await readFile(path.join(directory, "pids.jsonl"), "utf8").catch(() => "")).trim(), "foreground fixture started");
  await invoke("annotationsOpen", { file: "markdown" });
  await invoke("annotationsOpen", { file: "code" });
  await rendered(false);
  let before = await settled();
  let beforeFocus = await focus();
  const chinese = "多行中文说明。原始文字必须完整显示。\n第二行说明不得修改源文件。";
  assert.deepEqual(await annotate("code", [marks(codeLines)[0], { ...marks(codeLines)[0], message: chinese }]),
    { ok: true, count: 2, visible: true });
  await rendered();
  await nativeBodies([literal, chinese]);
  assert.equal(await widgets().count(), 1, "Same-anchor annotations share one native thread in input order");
  await below(codeLines[31]);
  await unchanged(before, beforeFocus);

  // User collapse survives ordinary editor visibility changes; replacement starts expanded.
  await widgets().first().getByRole("button", { name: /collapse|hide/i }).click();
  await until(async () => (await widgets().count()) === 0, "production thread collapsed");
  await invoke("annotationsOpen", { file: "markdown" });
  await invoke("annotationsOpen", { file: "code" });
  assert.equal(await widgets().count(), 0, "Tab changes must not recreate a collapsed thread");
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await nativeBodies([literal]);
  before = await settled();
  beforeFocus = await focus();

  // The window token does not authorize a terminal, forged credential, session or cwd.
  for (const reject of ["terminal", "credential", "session", "cwd"]) {
    assert.deepEqual(await bridge({ reject, path: "annotations.ts", annotations: marks(codeLines) }), { ok: false, stage: "origin" });
  }
  assert.deepEqual(await annotate("code", [{ ...marks(codeLines)[0], expectedText: "stale source" }]), { ok: false, stage: "annotate" });
  await rendered();
  await nativeBodies([literal]);
  await unchanged(before, beforeFocus);
  await hover(codeLines[30]);

  // Retain an inactive Markdown tab without displaying or navigating to it.
  before = await settled();
  beforeFocus = await focus();
  assert.deepEqual(await annotate("markdown"), { ok: true, count: 1, visible: false });
  await unchanged(before, beforeFocus);
  await invoke("annotationsOpen", { file: "markdown" });
  await rendered();
  await nativeBodies([literal]);
  await below(markdownLines[31]);
  await hover(markdownLines[30]);
  for (const theme of ["Default Light Modern", "Default Dark Modern", "Default High Contrast", "Default High Contrast Light"]) {
    await invoke("theme", { theme });
    await rendered();
    await nativeBodies([literal]);
  }
  assert.deepEqual(await annotate("markdown", []), { ok: true, count: 0, visible: true });
  await rendered(false);
  await invoke("annotationsOpen", { file: "code" });
  await rendered();

  await invoke("annotationsPosition", { file: "code", line: 100 });
  before = await settled();
  beforeFocus = await focus();
  const eofMessage = "EOF explanation without a trailing newline";
  assert.deepEqual(await annotate("code", [{ startLine: 100, endLine: 100, expectedText: codeLines[99], message: eofMessage }]),
    { ok: true, count: 1, visible: true });
  await nativeBodies([eofMessage]);
  await below(codeLines[99]);
  await unchanged(before, beforeFocus);
  await invoke("annotationsOpen", { file: "code" });
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await nativeBodies([literal]);

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
  // Exercise the production bridge in a real modified-side diff editor as well.
  await invoke("annotationsDiff");
  before = await settled();
  beforeFocus = await focus();
  assert.deepEqual(await annotate("code"), { ok: true, count: 1, visible: true });
  await nativeBodies([literal]);
  await below(codeLines[31]);
  await unchanged(before, beforeFocus);
  await invoke("command", { command: "workbench.action.focusCommentsPanel" });
  await until(async () => (await page.locator(".comments-panel").innerText()).replaceAll("\u00a0", " ").includes(literal),
    "production Comments panel explanation");
  await invoke("command", { command: "pi.clearAnnotations" });
  await rendered(false);
  await until(async () => !(await page.locator(".comments-panel").innerText()).replaceAll("\u00a0", " ").includes(literal),
    "production Comments panel entry removed");
  assert.equal(await prompts(), "", "Annotation, clear and lifecycle checks must not submit any model prompt");
  assert.equal(await readFile(path.join(workspace, "annotations.ts"), "utf8"), code);
  assert.equal(await readFile(path.join(workspace, "annotations.md"), "utf8"), markdown);
  console.log("PI_NATIVE_ANNOTATIONS", JSON.stringify({
    bridge: "foreground child authenticated annotationOrigin + annotate; no tool-registry loading in fixture",
    rendered: "code/Markdown highlights, expanded native below-code literal/Chinese explanations, same-anchor grouping, collapse retention, EOF, modified-side diff, Comments panel cleanup, safe hover, inactive tab, four themes",
    preserved: "native focus, multiple selections, active editor, tabs, buffer versions and file bytes; native panel/layout changes permitted",
    cleared: "edit, Undo, close/reopen, empty array, Command Palette, resource reload, cloned session, disconnect/replacement",
    rejected: "terminal-style missing credential, forged credential/session/cwd, stale text, expired origins",
    provider: "no provider and no model prompts",
  }));
}
