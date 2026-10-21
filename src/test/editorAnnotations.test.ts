import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { EditorAnnotations } = require("../editorAnnotations") as typeof import("../editorAnnotations");
const filesystem = require("node:fs/promises");
const mark = (overrides: Record<string, unknown> = {}) => ({
  startLine: 1,
  endLine: 2,
  expectedText: "first\nsecond",
  message: "An explanation.",
  ...overrides,
});

function documentFor(file: string, text = "first\nsecond\n\nlast") {
  const lines = text.split("\n");
  return {
    uri: MockUri.file(file),
    version: 1,
    isClosed: false,
    isDirty: true,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line]! }),
    getText: () => {
      throw new Error("Whole source reads are not needed.");
    },
    save: () => {
      throw new Error("Must not save documents.");
    },
  };
}

function editorFor(document: any) {
  const editor = {
    document,
    calls: [] as { type: any; options: any[] }[],
    setDecorations(type: any, options: any[]) {
      this.calls.push({ type, options });
    },
    revealRange() {
      throw new Error("Must not navigate.");
    },
    get selection() {
      return { unchanged: true };
    },
    set selection(_value: unknown) {
      throw new Error("Must not change selection.");
    },
  };
  return editor;
}

async function fixture(
  run: (context: {
    root: string;
    canonical: string;
    directory: string;
    file: string;
    document: ReturnType<typeof documentFor>;
    editor: ReturnType<typeof editorFor>;
    controller: InstanceType<typeof EditorAnnotations>;
    settings: Map<string, unknown>;
    origin: { cwd: string; root: string; assertCurrent: () => void };
    annotate: (annotations?: unknown, extra?: Record<string, unknown>) => Promise<{ count: number; visible: boolean }>;
  }) => Promise<void>,
  alias = false,
) {
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-annotations-")));
  const canonical = path.join(directory, "workspace");
  await mkdir(canonical);
  const root = alias ? path.join(directory, "alias") : canonical;
  if (alias) await symlink(canonical, root, "junction");
  const file = path.join(root, "source.ts");
  await writeFile(file, "disk text differs from the dirty buffer\n");
  const document = documentFor(file);
  const editor = editorFor(document);
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: MockUri.file(root), name: "Fixture", index: 0 }];
  vscode.workspace.textDocuments = [document];
  vscode.window.visibleTextEditors = [editor];
  vscode.window.activeTextEditor = editor;
  vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputText(document.uri) }] }];
  vscode.window.decorationTypes = [];
  vscode.comments.controllers = [];
  const forbidden = () => {
    throw new Error("No file/editor actions are permitted.");
  };
  vscode.workspace.openTextDocument = forbidden;
  vscode.workspace.applyEdit = forbidden;
  vscode.workspace.fs = { readFile: forbidden, writeFile: forbidden };
  vscode.window.showTextDocument = forbidden;
  vscode.commands.executeCommand = forbidden;
  const settings = new Map<string, unknown>();
  const getConfiguration = vscode.workspace.getConfiguration;
  vscode.workspace.getConfiguration = (section: string) => {
    assert.equal(section, "pi", "Annotation display must not change shared Comments settings.");
    return { get: (key: string) => settings.get(key) };
  };
  const controller = new EditorAnnotations();
  const origin = { cwd: root, root: canonical, assertCurrent() {} };
  try {
    await run({
      root,
      canonical,
      directory,
      file,
      document,
      editor,
      controller,
      settings,
      origin,
      annotate: (annotations = [mark()], extra = {}) =>
        controller.annotate({ path: file, annotations, ...extra }, origin),
    });
  } finally {
    controller.dispose();
    vscode.workspace.getConfiguration = getConfiguration;
    vscode.window.tabGroups.all = [];
    await rm(directory, { recursive: true, force: true });
  }
}

function pauseFilesystem(method: "realpath" | "lstat", when: (file: string, call: number) => boolean = () => true) {
  const original = filesystem[method];
  let release!: () => void;
  let started!: () => void;
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  let paused = false;
  filesystem[method] = async (...args: any[]) => {
    const result = await original(...args);
    if (!paused && when(String(args[0]), ++calls)) {
      paused = true;
      started();
      await resumed;
    }
    return result;
  };
  return { reached, release, restore: () => (filesystem[method] = original) };
}

const lastOptions = (editor: ReturnType<typeof editorFor>) => editor.calls.at(-1)?.options;

test.each([false, true])("annotations use dirty whole lines and every visible editor (root alias: %s)", async (alias) =>
  fixture(async ({ annotate, document, editor, controller, file }) => {
    assert.equal(vscode.window.decorationTypes.length, 0, "Decoration creation is lazy.");
    const second = editorFor(document);
    const unrelated = editorFor(documentFor(path.join(path.dirname(file), "other.ts")));
    vscode.window.visibleTextEditors = [editor, second, unrelated];
    const original = await readFile(file, "utf8");
    const originalMethods = ["readFile", "open", "writeFile"].map((method) => [method, filesystem[method]] as const);
    try {
      for (const [method] of originalMethods)
        filesystem[method] = () => {
          throw new Error("Source disk I/O is forbidden.");
        };
      assert.deepEqual(await annotate([mark({ expectedText: "first\r\nsecond" })]), { count: 1, visible: true });
    } finally {
      for (const [method, implementation] of originalMethods) filesystem[method] = implementation;
    }
    const options = lastOptions(editor)!;
    assert.equal(options.length, 1);
    assert.equal(lastOptions(second), options);
    assert.equal(unrelated.calls.length, 0);
    assert.deepEqual(options[0].range.start, { line: 0, character: 0 });
    assert.deepEqual(options[0].range.end, { line: 1, character: 6 });
    assert.deepEqual(editor.selection, { unchanged: true });
    assert.equal(vscode.window.activeTextEditor, editor);
    assert.equal(await readFile(file, "utf8"), original);
    const retained = [...(controller as any).entries.values()];
    assert.deepEqual(Object.keys(retained[0]).sort(), ["options", "threads", "version"]);
    assert.equal(retained[0].threads[0], vscode.comments.controllers[0].threads[0]);
    assert.doesNotMatch(JSON.stringify(retained), /expectedText|first|second/);
    const style = vscode.window.decorationTypes[0].options;
    assert.equal(style.rangeBehavior, vscode.DecorationRangeBehavior.ClosedClosed);
    assert.equal(style.isWholeLine, true);
    assert.ok(style.backgroundColor instanceof vscode.ThemeColor);
    assert.ok(style.borderColor instanceof vscode.ThemeColor);
    assert.equal(style.borderStyle, "solid");
    assert.equal(style.borderWidth, "1px");
  }, alias),
);

test("hover labels and model markup use only untrusted plain text", async () =>
  fixture(async ({ annotate, editor }) => {
    const message =
      "[execute](command:evil) <img src=x> **bold** $(zap) https://example.invalid www.example.invalid a@example.invalid";
    const result = await annotate([mark({ message })]);
    const hover = lastOptions(editor)![0].hoverMessage;
    assert.deepEqual(hover.appendedText, ["Pi annotation\n\n", message]);
    assert.equal(hover.isTrusted, false);
    assert.equal(hover.supportHtml, false);
    assert.notEqual(hover.value, `Pi annotation\n\n${message}`);
    const { marked } = await import("marked");
    const html = marked.parse(hover.value) as string;
    assert.doesNotMatch(html, /<(a|img|strong)\b/i);
    assert.ok(html.includes("https://example.invalid"));
    assert.ok(html.includes("www.example.invalid"));
    assert.ok(html.includes("a@example.invalid"));
    assert.deepEqual(Object.keys(result).sort(), ["count", "visible"]);
    assert.doesNotMatch(JSON.stringify(result), /execute|first|explanation/);
  }));

test("hover keeps model-provided HTML character references literal", async () =>
  fixture(async ({ annotate, editor }) => {
    await annotate([mark({ message: "&copy; &#64; &amp;" })]);
    const { marked } = await import("marked");
    const html = marked.parse(lastOptions(editor)![0].hoverMessage.value) as string;
    assert.ok(html.includes("&amp;copy; &amp;#64; &amp;amp;"));
  }));

test("successful replacement and empty clearing reuse one decoration type", async () =>
  fixture(async ({ annotate, editor }) => {
    await annotate();
    await annotate([mark(), mark({ message: "Second annotation" })]);
    assert.equal(lastOptions(editor)?.length, 2);
    assert.deepEqual(await annotate([]), { count: 0, visible: true });
    assert.deepEqual(lastOptions(editor), []);
    assert.equal(vscode.window.decorationTypes.length, 1);
    await annotate();
    assert.equal(lastOptions(editor)?.length, 1);
  }));

test("inactive documents render when visible without opening or activating them", async () =>
  fixture(async ({ annotate, document, editor }) => {
    vscode.window.visibleTextEditors = [];
    assert.deepEqual(await annotate(), { count: 1, visible: false });
    assert.equal(editor.calls.length, 0);
    const second = editorFor(document);
    vscode.window.visibleTextEditors = [editor, second];
    vscode.workspaceEvents.emit("visibleEditors", [editor, second]);
    assert.equal(lastOptions(editor)?.length, 1);
    assert.equal(lastOptions(second), lastOptions(editor));
  }));

test("native controller is lazy, uses a fixed Pi id, and is disposed only with its owner", async () =>
  fixture(async ({ annotate, controller }) => {
    controller.clear();
    await annotate([]);
    await assert.rejects(annotate([mark({ expectedText: "stale" })]));
    assert.equal(vscode.comments.controllers.length, 0);
    await annotate();
    const native = vscode.comments.controllers[0];
    assert.equal(native.id, "pi.annotations");
    assert.equal(native.label, "Pi annotations");
    assert.equal(native.commentingRangeProvider, undefined);
    assert.equal(native.reactionHandler, undefined);
    const first = native.threads[0];
    await annotate([]);
    assert.equal(first.disposeCalls, 1);
    assert.equal(native.disposed, false);
    await annotate();
    const second = native.threads[1];
    controller.clear();
    controller.clear();
    assert.equal(second.disposeCalls, 1);
    assert.equal(native.disposed, false);
    await annotate();
    controller.dispose();
    controller.dispose();
    assert.equal(vscode.comments.controllers.length, 1);
    assert.equal(native.disposeCalls, 1);
    assert.ok(native.threads.every((thread: any) => thread.disposeCalls === 1));
  }));

test("native threads group by validated end line and keep messages in input order", async () =>
  fixture(async ({ annotate, document, controller }) => {
    const result = await annotate([
      mark({ startLine: 4, endLine: 4, expectedText: "last", message: "EOF" }),
      mark({ message: "First passage" }),
      mark({ startLine: 2, expectedText: "second", message: "Same end line" }),
      mark({ startLine: 3, endLine: 3, expectedText: "", message: "Blank line" }),
    ]);
    assert.deepEqual(result, { count: 4, visible: true }, "Count inputs, not groups.");
    const threads = vscode.comments.controllers[0].threads;
    assert.equal(threads.length, 3);
    assert.deepEqual(
      threads.map((thread: any) => [thread.range.start, thread.range.end]),
      [
        [
          { line: 3, character: 4 },
          { line: 3, character: 4 },
        ],
        [
          { line: 1, character: 6 },
          { line: 1, character: 6 },
        ],
        [
          { line: 2, character: 0 },
          { line: 2, character: 0 },
        ],
      ],
    );
    assert.deepEqual(
      threads[1].comments.map((comment: any) => comment.body.appendedText),
      [["First passage"], ["Same end line"]],
    );
    for (const thread of threads) {
      assert.equal(thread.uri, document.uri);
      assert.equal(thread.label, "Pi annotation");
      assert.equal(thread.canReply, false);
      assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
      for (const comment of thread.comments) {
        assert.equal(comment.mode, vscode.CommentMode.Preview);
        assert.deepEqual(comment.author, { name: "Pi" });
        assert.equal(comment.command, undefined);
        assert.equal(comment.contextValue, undefined);
      }
    }
    assert.deepEqual((controller as any).entries.get(document).threads, threads);
  }));

test.each([undefined, "collapsed", "expanded", "invalid", false])(
  "native thread initial state follows the setting with a safe API default: %j",
  async (value) =>
    fixture(async ({ annotate, settings }) => {
      settings.set("annotations.initialState", value);
      await annotate();
      const thread = vscode.comments.controllers[0].threads[0];
      assert.equal(
        thread.collapsibleState,
        value === "expanded"
          ? vscode.CommentThreadCollapsibleState.Expanded
          : vscode.CommentThreadCollapsibleState.Collapsed,
      );
    }),
);

test("default annotations do not assign the API collapsible state", async () =>
  fixture(async ({ annotate }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const create = native.createCommentThread;
    native.createCommentThread = function (...args: any[]) {
      const thread = create.apply(this, args);
      Object.defineProperty(thread, "collapsibleState", {
        get: () => vscode.CommentThreadCollapsibleState.Collapsed,
        set: () => {
          throw new Error("The API default must not be overwritten.");
        },
      });
      return thread;
    };
    try {
      await annotate();
    } finally {
      native.createCommentThread = create;
    }
  }));

test("display changes affect new replacements without resetting retained user state", async () =>
  fixture(async ({ annotate, settings, document, editor }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const first = native.threads[0];
    first.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
    settings.set("annotations.initialState", "expanded");
    vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    vscode.window.visibleTextEditors = [];
    vscode.workspaceEvents.emit("visibleEditors", []);
    vscode.window.visibleTextEditors = [editor];
    vscode.workspaceEvents.emit("visibleEditors", [editor]);
    assert.equal(native.threads.length, 1);
    assert.equal(first.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    await annotate();
    const second = native.threads[1];
    assert.equal(second.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
    assert.equal(first.disposeCalls, 1);
    second.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    vscode.workspaceEvents.emit("visibleEditors", [editor]);
    assert.equal(second.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    settings.delete("annotations.initialState");
    vscode.configurationEvents.emit("change", { affectsConfiguration: () => true });
    assert.equal(second.disposed, false);
    assert.equal(native.threads.length, 2);
    await annotate();
    const third = native.threads[2];
    assert.equal(third.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    assert.equal(third.uri, document.uri);
    assert.equal(second.disposeCalls, 1);
  }));

test.each(["", "last", "last\n"])("native EOF anchors stay inside complete lines: %j", async (text) =>
  fixture(async ({ annotate, document }) => {
    const lines = text.split("\n");
    document.lineCount = lines.length;
    document.lineAt = (line: number) => {
      assert.ok(line >= 0 && line < lines.length, "Do not request a synthetic line after EOF.");
      return { text: lines[line]! };
    };
    await annotate([mark({ startLine: 1, endLine: lines.length, expectedText: text })]);
    const range = vscode.comments.controllers[0].threads[0].range;
    const anchor = { line: lines.length - 1, character: lines.at(-1)!.length };
    assert.deepEqual(range.start, anchor);
    assert.deepEqual(range.end, anchor);
  }),
);

test("native bodies use the same literal Markdown escaping as hovers", async () =>
  fixture(async ({ annotate, editor }) => {
    const message =
      "[execute](command:evil) <img src=x> **bold** $(zap) https://example.invalid www.example.invalid a@example.invalid\n&copy; &#64; &amp;";
    await annotate([mark({ message })]);
    const body = vscode.comments.controllers[0].threads[0].comments[0].body;
    const hover = lastOptions(editor)![0].hoverMessage;
    assert.equal(body.isTrusted, false);
    assert.equal(body.supportHtml, false);
    assert.deepEqual(body.appendedText, [message.replace(/&/g, "&amp;")]);
    assert.equal(hover.value, `Pi annotation\n\n${body.value}`);
    const { marked } = await import("marked");
    const html = marked.parse(body.value) as string;
    assert.doesNotMatch(html, /<(a|img|strong)\b/i);
    assert.ok(html.includes("https://example.invalid"));
    assert.ok(html.includes("www.example.invalid"));
    assert.ok(html.includes("a@example.invalid"));
    assert.ok(html.includes("&amp;copy; &amp;#64; &amp;amp;"));
  }));

test("redraw retains native handles and the user's collapsed state across hidden and split editors", async () =>
  fixture(async ({ annotate, document, editor, file, controller }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const threads = (controller as any).entries.get(document).threads;
    threads[0].collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    vscode.window.visibleTextEditors = [];
    vscode.workspaceEvents.emit("visibleEditors", []);
    const second = editorFor(document);
    vscode.window.visibleTextEditors = [editor, second];
    vscode.workspaceEvents.emit("visibleEditors", [editor, second]);
    editor.document = documentFor(path.join(path.dirname(file), "reused.ts"));
    vscode.workspaceEvents.emit("visibleEditors", [editor, second]);
    assert.deepEqual(lastOptions(editor), []);
    assert.equal(lastOptions(second)?.length, 1);
    assert.equal(native.threads.length, 1);
    assert.equal((controller as any).entries.get(document).threads, threads);
    assert.equal(threads[0].disposed, false);
    assert.equal(threads[0].collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
  }));

test("accepted handles stay retained until all replacement threads are prepared", async () =>
  fixture(async ({ annotate, document, editor, controller }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const previous = (controller as any).entries.get(document);
    const create = native.createCommentThread;
    const options = lastOptions(editor);
    native.createCommentThread = function (...args: any[]) {
      assert.equal((controller as any).entries.get(document), previous);
      assert.equal(previous.threads[0].disposed, false);
      assert.equal(lastOptions(editor), options);
      return create.apply(this, args);
    };
    try {
      await annotate([mark({ message: "New" }), mark({ startLine: 4, endLine: 4, expectedText: "last" })]);
    } finally {
      native.createCommentThread = create;
    }
    assert.equal(previous.threads[0].disposeCalls, 1);
    assert.equal((controller as any).entries.get(document).threads.length, 2);
    assert.ok(native.threads.slice(1).every((thread: any) => !thread.disposed));
  }));

test.each(["create-first", "create-second", "label", "canReply", "collapsibleState"])(
  "failed native replacement releases partial handles and keeps accepted state: %s",
  async (failure) =>
    fixture(async ({ annotate, document, editor, controller, settings }) => {
      settings.set("annotations.initialState", "expanded");
      await annotate();
      const native = vscode.comments.controllers[0];
      const previous = (controller as any).entries.get(document);
      const options = lastOptions(editor);
      const revision = (controller as any).revisions.get(document);
      const create = native.createCommentThread;
      let calls = 0;
      native.createCommentThread = function (...args: any[]) {
        calls++;
        if ((failure === "create-first" && calls === 1) || (failure === "create-second" && calls === 2))
          throw new Error("Native creation failed.");
        const thread = create.apply(this, args);
        if (!failure.startsWith("create-") && calls === 2)
          Object.defineProperty(thread, failure, {
            set() {
              throw new Error("Native property failed.");
            },
          });
        return thread;
      };
      try {
        await assert.rejects(annotate([mark(), mark({ startLine: 4, endLine: 4, expectedText: "last" })]), /Native/);
      } finally {
        native.createCommentThread = create;
      }
      assert.equal((controller as any).entries.get(document), previous);
      assert.equal((controller as any).revisions.get(document), revision);
      assert.equal(lastOptions(editor), options);
      assert.equal(previous.threads[0].disposed, false);
      assert.ok(native.threads.slice(1).every((thread: any) => thread.disposeCalls === 1));
      await annotate();
      assert.equal(previous.threads[0].disposeCalls, 1);
      assert.equal(native.threads.at(-1).disposed, false);
    }),
);

test("native controller creation failure can be retried without retained state", async () =>
  fixture(async ({ annotate, controller, editor }) => {
    const create = vscode.comments.createCommentController;
    vscode.comments.createCommentController = () => {
      throw new Error("Controller unavailable.");
    };
    try {
      await assert.rejects(annotate(), /Controller unavailable/);
    } finally {
      vscode.comments.createCommentController = create;
    }
    assert.equal((controller as any).entries.size, 0);
    assert.equal(editor.calls.length, 0);
    await annotate();
    assert.equal(vscode.comments.controllers.length, 1);
  }));

test.each(["origin", "trust", "content", "version", "clear", "edit", "close", "tabs", "dispose"])(
  "final checks reject invalidation during native preparation and release new handles: %s",
  async (kind) =>
    fixture(async ({ annotate, controller, document, origin, editor }) => {
      await annotate();
      const native = vscode.comments.controllers[0];
      const previous = (controller as any).entries.get(document);
      const options = lastOptions(editor);
      const create = native.createCommentThread;
      native.createCommentThread = function (...args: any[]) {
        const thread = create.apply(this, args);
        if (kind === "origin")
          origin.assertCurrent = () => {
            throw new Error("Expired origin.");
          };
        if (kind === "trust") vscode.workspace.isTrusted = false;
        if (kind === "content") document.lineAt = () => ({ text: "changed" });
        if (kind === "version") document.version++;
        if (kind === "clear") controller.clear();
        if (kind === "edit") vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [{}] });
        if (kind === "close") {
          document.isClosed = true;
          vscode.workspaceEvents.emit("closeDocument", document);
        }
        if (kind === "tabs") vscode.window.tabGroups.all = [];
        if (kind === "dispose") controller.dispose();
        return thread;
      };
      try {
        await assert.rejects(annotate());
      } finally {
        native.createCommentThread = create;
      }
      const invalidated = ["clear", "edit", "close", "dispose"].includes(kind);
      assert.equal((controller as any).entries.get(document), invalidated ? undefined : previous);
      assert.equal(previous.threads[0].disposed, invalidated);
      assert.equal(native.threads[1].disposed, true);
      if (!invalidated) assert.equal(lastOptions(editor), options);
    }),
);

test("native preparation, final checks and commit have no asynchronous gap", async () =>
  fixture(async ({ annotate, controller, document, origin }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const previous = (controller as any).entries.get(document);
    const create = native.createCommentThread;
    let committed = false;
    native.createCommentThread = function (...args: any[]) {
      const thread = create.apply(this, args);
      queueMicrotask(() => {
        committed = (controller as any).entries.get(document) !== previous && previous.threads[0].disposed;
        origin.assertCurrent = () => {
          throw new Error("Expired after synchronous commit.");
        };
      });
      return thread;
    };
    try {
      assert.equal((await annotate()).count, 1);
      assert.equal(committed, true);
    } finally {
      native.createCommentThread = create;
    }
  }));

const invalidAnnotations = [
  null,
  {},
  "annotations",
  Array.from({ length: 21 }, () => mark()),
  [null],
  new Array(1),
  [[]],
  ["mark"],
  [{}],
  [mark({ startLine: 0 })],
  [mark({ startLine: -1 })],
  [mark({ startLine: 1.1 })],
  [mark({ startLine: "1" })],
  [mark({ startLine: Number.MAX_SAFE_INTEGER + 1 })],
  [mark({ endLine: 1.5 })],
  [mark({ endLine: 0 })],
  [mark({ endLine: 201 })],
  [mark({ endLine: 5 })],
  [mark({ expectedText: null })],
  [mark({ expectedText: "x".repeat(10_001) })],
  [mark({ expectedText: "first\nsecond\n" })],
  [mark({ expectedText: " first\nsecond" })],
  [mark({ expectedText: "first\rsecond" })],
  [mark({ message: null })],
  [mark({ message: "" })],
  [mark({ message: "x".repeat(1_001) })],
  [mark({ severity: "info" })],
  [mark(), mark({ expectedText: "stale" })],
];
test.each(invalidAnnotations.map((value, index) => [index, value] as const))(
  "invalid annotation replacement %s is atomic",
  async (_index, annotations) =>
    fixture(async ({ annotate, editor }) => {
      await annotate();
      const options = lastOptions(editor);
      const calls = editor.calls.length;
      const thread = vscode.comments.controllers[0].threads[0];
      await assert.rejects(annotate(annotations));
      assert.equal(editor.calls.length, calls);
      assert.equal(lastOptions(editor), options);
      assert.equal(thread.disposed, false);
      assert.equal(vscode.comments.controllers[0].threads.length, 1);
    }),
);

test.each([{ path: "source.ts" }, { path: "/bad\0path" }, { path: 5 }, { path: "file:///source.ts" }, { extra: true }])(
  "invalid top-level parameters fail without decorations: %j",
  async (extra) =>
    fixture(async ({ annotate, editor }) => {
      await assert.rejects(annotate([mark()], extra));
      assert.equal(editor.calls.length, 0);
      assert.equal(vscode.window.decorationTypes.length, 0);
      assert.equal(vscode.comments.controllers.length, 0);
    }),
);

test("inclusive range, text, message and per-call limits accept exact boundaries", async () =>
  fixture(async ({ annotate, document, editor }) => {
    const lines = Array.from({ length: 200 }, (_, index) => (index === 0 ? "x".repeat(9_801) : ""));
    document.lineCount = lines.length;
    document.lineAt = (line: number) => ({ text: lines[line]! });
    const annotation = mark({ endLine: 200, expectedText: lines.join("\n"), message: "x".repeat(1_000) });
    assert.equal(annotation.expectedText.length, 10_000);
    assert.deepEqual(await annotate(Array.from({ length: 20 }, () => annotation)), { count: 20, visible: true });
    assert.equal(lastOptions(editor)![0].range.end.line, 199);
    await annotate([mark({ startLine: 200, endLine: 200, expectedText: "", message: "x" })]);
    assert.equal(lastOptions(editor)?.length, 1, "Empty complete lines and one-character messages are valid.");
  }));

test.each(["untrusted", "outside", "cwd", "virtual", "closed", "unopened", "missing", "directory", "uri-query"])(
  "unsafe or unavailable target is rejected: %s",
  async (kind) =>
    fixture(async ({ annotate, origin, document, file, directory }) => {
      let target = file;
      if (kind === "untrusted") vscode.workspace.isTrusted = false;
      if (kind === "outside") target = path.join(directory, "outside.ts");
      if (kind === "cwd") origin.cwd = directory;
      if (kind === "virtual") document.uri = new MockUri("untitled", file);
      if (kind === "closed") document.isClosed = true;
      if (kind === "unopened") vscode.workspace.textDocuments = [];
      if (kind === "missing") await rm(file);
      if (kind === "directory") {
        await rm(file);
        await mkdir(file);
      }
      if (kind === "uri-query") document.uri = document.uri.with({ query: "variant" });
      await assert.rejects(annotate([mark()], { path: target }));
      assert.equal(vscode.window.decorationTypes.length, 0);
    }),
);

test.each(["file-link", "directory-link", "hard-link", "document-link", "ambiguous"])(
  "rejects unsafe file aliases and ambiguous buffers: %s",
  async (kind) =>
    fixture(async ({ annotate, document, file, root, directory }) => {
      const other = path.join(directory, "other.ts");
      await writeFile(other, "outside");
      let target = file;
      if (kind === "file-link") {
        await rm(file);
        await symlink(other, file);
      }
      if (kind === "hard-link") {
        await rm(file);
        await link(other, file);
      }
      if (kind === "directory-link") {
        await symlink(directory, path.join(root, "nested"), "junction");
        target = path.join(root, "nested", "other.ts");
        document.uri = MockUri.file(target);
      }
      if (kind === "document-link" || kind === "ambiguous") {
        const alias = path.join(root, "alias.ts");
        await symlink(file, alias);
        if (kind === "document-link") document.uri = MockUri.file(alias);
        else vscode.workspace.textDocuments.push(documentFor(alias));
      }
      await assert.rejects(annotate([mark()], { path: target }));
      assert.equal(vscode.window.decorationTypes.length, 0);
    }),
);

test("canonical paths work with a workspace-root alias and duplicate alias/canonical documents fail", async () =>
  fixture(async ({ annotate, canonical, document }) => {
    const target = path.join(canonical, "source.ts");
    await annotate([mark()], { path: target });
    vscode.workspace.textDocuments.push(documentFor(target));
    await assert.rejects(annotate([mark()], { path: target }), /unambiguous/);
    vscode.workspace.textDocuments = [documentFor(target)];
    vscode.window.tabGroups.all = [{ tabs: [{ input: new vscode.TabInputText(MockUri.file(target)) }] }];
    await annotate([mark()], { path: target });
    assert.equal(document.isClosed, false);
  }, true));

test("the originating canonical root must match before accepting an aliased workspace", async () =>
  fixture(async ({ annotate, origin, directory }) => {
    origin.root = directory;
    await assert.rejects(annotate(), /originating root/);
    assert.equal(vscode.window.decorationTypes.length, 0);
  }, true));

test("missing unrelated open files and non-file documents do not block annotation", async () =>
  fixture(async ({ annotate, root }) => {
    vscode.workspace.textDocuments.push(documentFor(path.join(root, "missing.ts")));
    const virtual = documentFor(path.join(root, "source.ts"));
    virtual.uri = new MockUri("untitled", virtual.uri.fsPath);
    vscode.workspace.textDocuments.push(virtual);
    await annotate();
  }));

test.each(["edit", "close", "clear", "dispose", "version-on-redraw"])(
  "lifecycle cleanup removes visible and inactive annotations: %s",
  async (kind) =>
    fixture(async ({ annotate, document, editor, controller }) => {
      await annotate();
      const native = vscode.comments.controllers[0];
      const thread = native.threads[0];
      if (kind === "edit") vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [{}] });
      if (kind === "close") vscode.workspaceEvents.emit("closeDocument", document);
      if (kind === "clear") controller.clear();
      if (kind === "dispose") controller.dispose();
      if (kind === "version-on-redraw") {
        document.version++;
        vscode.workspaceEvents.emit("visibleEditors", [editor]);
      }
      assert.deepEqual(lastOptions(editor), []);
      assert.equal(thread.disposeCalls, 1);
      assert.equal(native.disposed, kind === "dispose");
      const newcomer = editorFor(document);
      vscode.window.visibleTextEditors = [newcomer];
      vscode.workspaceEvents.emit("visibleEditors", [newcomer]);
      assert.ok(!lastOptions(newcomer)?.length);
      if (kind === "dispose") assert.equal(vscode.window.decorationTypes[0].disposed, true);
    }),
);

test.each(["edit", "close"])("inactive document %s cleanup cannot restore annotations on visibility", async (kind) =>
  fixture(async ({ annotate, document, editor }) => {
    await annotate();
    const thread = vscode.comments.controllers[0].threads[0];
    vscode.window.visibleTextEditors = [];
    if (kind === "edit") vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [{}] });
    else vscode.workspaceEvents.emit("closeDocument", document);
    const newcomer = editorFor(document);
    vscode.window.visibleTextEditors = [newcomer];
    vscode.workspaceEvents.emit("visibleEditors", [newcomer]);
    assert.deepEqual(lastOptions(newcomer), []);
    assert.equal(editor.calls.length, 1);
    assert.equal(thread.disposeCalls, 1);
  }),
);

test("manual clear removes cached decorations when the same hidden editor becomes visible again", async () =>
  fixture(async ({ annotate, document, editor, controller }) => {
    await annotate();
    vscode.window.visibleTextEditors = [];
    controller.clear();
    assert.equal(lastOptions(editor)?.length, 1, "The hidden editor still has its last submitted decoration.");
    vscode.window.visibleTextEditors = [editor];
    vscode.workspaceEvents.emit("visibleEditors", [editor]);
    assert.deepEqual(lastOptions(editor), []);
    assert.equal(document.isClosed, false);
  }));

test("save-only dirty-state events preserve annotations and pending replacements", async () =>
  fixture(async ({ annotate, document, editor }) => {
    await annotate();
    const native = vscode.comments.controllers[0];
    const thread = native.threads[0];
    thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
    document.isDirty = false;
    vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [] });
    assert.equal(lastOptions(editor)?.length, 1);
    assert.equal(thread.disposed, false);
    assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
    assert.equal(native.threads.length, 1);
    const pause = pauseFilesystem("realpath");
    const pending = annotate([mark({ message: "Kept after save" })]);
    try {
      await pause.reached;
      vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [] });
      pause.release();
      assert.deepEqual(await pending, { count: 1, visible: true });
      assert.equal(thread.disposeCalls, 1);
      assert.equal(native.threads[1].disposed, false);
    } finally {
      pause.release();
      pause.restore();
    }
  }));

test.each(["text", "diff"])("last %s tab close clears a cached document and pending work", async (kind) =>
  fixture(async ({ annotate, document, editor }) => {
    await annotate();
    const input =
      kind === "text"
        ? new vscode.TabInputText(document.uri)
        : new vscode.TabInputTextDiff(MockUri.file("/original"), document.uri);
    const pause = pauseFilesystem("realpath");
    const pending = annotate();
    try {
      await pause.reached;
      vscode.window.tabGroups.all = [];
      vscode.workspaceEvents.emit("tabs", { closed: [{ input }], opened: [], changed: [] });
      assert.equal(document.isClosed, false, "The model remains cached after tab close.");
      assert.deepEqual(lastOptions(editor), []);
      pause.release();
      await assert.rejects(pending, /changed/);
    } finally {
      pause.release();
      pause.restore();
    }
    vscode.workspaceEvents.emit("visibleEditors", [editor]);
    assert.deepEqual(lastOptions(editor), []);
  }),
);

test("a fresh request rejects a cached document after its last tab has closed", async () =>
  fixture(async ({ annotate, document, editor }) => {
    await annotate();
    vscode.window.tabGroups.all = [];
    vscode.workspaceEvents.emit("tabs", {
      closed: [{ input: new vscode.TabInputText(document.uri) }],
      opened: [],
      changed: [],
    });
    assert.equal(document.isClosed, false);
    await assert.rejects(annotate(), /already-open/);
    assert.deepEqual(lastOptions(editor), []);
  }));

test.each(["text", "diff"])("closing one split tab retains annotations in a remaining %s tab", async (kind) =>
  fixture(async ({ annotate, document, editor }) => {
    await annotate();
    const remaining =
      kind === "text"
        ? new vscode.TabInputText(document.uri)
        : new vscode.TabInputTextDiff(MockUri.file("/original"), document.uri);
    vscode.window.tabGroups.all = [{ tabs: [{ input: remaining }] }];
    try {
      vscode.workspaceEvents.emit("tabs", {
        closed: [{ input: new vscode.TabInputText(document.uri) }],
        opened: [],
        changed: [],
      });
      assert.equal(lastOptions(editor)?.length, 1);
    } finally {
      vscode.window.tabGroups.all = [];
    }
  }),
);

test("dispose removes listeners and clear requires neither Pi nor decoration creation", async () =>
  fixture(async ({ controller, annotate }) => {
    controller.clear();
    assert.equal(vscode.window.decorationTypes.length, 0);
    assert.equal(vscode.comments.controllers.length, 0);
    assert.ok(vscode.workspaceEvents.listenerCount("changeDocument") > 0);
    controller.dispose();
    controller.dispose();
    assert.equal(vscode.workspaceEvents.listenerCount("changeDocument"), 0);
    assert.equal(vscode.workspaceEvents.listenerCount("closeDocument"), 0);
    assert.equal(vscode.workspaceEvents.listenerCount("visibleEditors"), 0);
    await assert.rejects(annotate(), /current/);
  }));

test.each(["clear", "edit", "close", "dispose", "version", "removed", "trust", "origin", "folders", "cwd", "root"])(
  "pending annotation cannot commit after %s",
  async (kind) =>
    fixture(async ({ annotate, document, controller, origin, root, directory, editor }) => {
      await annotate();
      const pause = pauseFilesystem("realpath");
      const pending = annotate();
      try {
        await pause.reached;
        if (kind === "clear") controller.clear();
        if (kind === "edit") vscode.workspaceEvents.emit("changeDocument", { document, contentChanges: [{}] });
        if (kind === "close") {
          vscode.workspaceEvents.emit("closeDocument", document);
          document.isClosed = true;
        }
        if (kind === "dispose") controller.dispose();
        if (kind === "version") document.version++;
        if (kind === "removed") vscode.workspace.textDocuments = [];
        if (kind === "trust") vscode.workspace.isTrusted = false;
        if (kind === "origin")
          origin.assertCurrent = () => {
            throw new Error("Expired foreground origin.");
          };
        if (kind === "folders") vscode.workspace.workspaceFolders = [{ uri: MockUri.file(directory) }];
        if (kind === "cwd") origin.cwd = `${root}/changed`;
        if (kind === "root") origin.root = directory;
        const calls = editor.calls.length;
        const native = vscode.comments.controllers[0];
        const handles = [...native.threads];
        pause.release();
        await assert.rejects(pending);
        assert.equal(editor.calls.length, calls, "Late validation cannot draw again.");
        assert.deepEqual(native.threads, handles, "Late validation cannot create native threads.");
      } finally {
        pause.release();
        pause.restore();
      }
    }),
);

test.each([false, true])("concurrent stale replacement cannot overwrite newer annotations (empty: %s)", async (empty) =>
  fixture(async ({ annotate, editor }) => {
    const pause = pauseFilesystem("realpath");
    const older = annotate(empty ? [] : [mark({ message: "Old" })]);
    try {
      await pause.reached;
      await annotate([mark({ message: "New" })]);
      const options = lastOptions(editor);
      const native = vscode.comments.controllers[0];
      const thread = native.threads[0];
      pause.release();
      await assert.rejects(older, /changed/);
      assert.equal(lastOptions(editor), options);
      assert.equal(native.threads.length, 1);
      assert.equal(thread.disposed, false);
      assert.equal(options![0].hoverMessage.appendedText[1], "New");
    } finally {
      pause.release();
      pause.restore();
    }
  }),
);

test("a failed concurrent replacement preserves pending work", async () =>
  fixture(async ({ annotate, editor }) => {
    const pause = pauseFilesystem("realpath");
    const pending = annotate();
    try {
      await pause.reached;
      await assert.rejects(annotate([mark({ expectedText: "stale" })]));
      pause.release();
      assert.equal((await pending).count, 1);
      assert.equal(lastOptions(editor)?.length, 1);
    } finally {
      pause.release();
      pause.restore();
    }
  }));

test("a successful unrelated-document replacement does not invalidate pending work", async () =>
  fixture(async ({ annotate, root, controller, origin }) => {
    const otherFile = path.join(root, "other.ts");
    await writeFile(otherFile, "disk");
    const otherDocument = documentFor(otherFile);
    vscode.workspace.textDocuments.push(otherDocument);
    vscode.window.tabGroups.all[0].tabs.push({ input: new vscode.TabInputText(otherDocument.uri) });
    const pause = pauseFilesystem("realpath");
    const pending = annotate();
    try {
      await pause.reached;
      await controller.annotate({ path: otherFile, annotations: [mark()] }, origin);
      pause.release();
      assert.equal((await pending).count, 1);
    } finally {
      pause.release();
      pause.restore();
    }
  }));

test.each(["alias", "leaf-link", "leaf-hardlink", "leaf-replaced", "version", "origin", "clear", "ambiguous"])(
  "final asynchronous validation detects late %s changes",
  async (kind) =>
    fixture(async ({ annotate, root, canonical, directory, file, document, origin, controller, editor }) => {
      // Pause the final safe-path check before the independent final leaf stat.
      let leafCalls = 0;
      const pause = pauseFilesystem(
        "lstat",
        (target) => target === path.join(canonical, "source.ts") && ++leafCalls === 3,
      );
      const pending = annotate();
      try {
        await pause.reached;
        if (kind === "alias") {
          await rm(root);
          const replacement = path.join(directory, "replacement");
          await mkdir(replacement);
          await symlink(replacement, root, "junction");
        }
        if (["leaf-link", "leaf-hardlink", "leaf-replaced"].includes(kind)) {
          const other = path.join(directory, "replacement.ts");
          await writeFile(other, "replacement");
          await rm(file);
          if (kind === "leaf-link") await symlink(other, file);
          if (kind === "leaf-hardlink") await link(other, file);
          if (kind === "leaf-replaced") await rename(other, file);
        }
        if (kind === "version") document.version++;
        if (kind === "origin")
          origin.assertCurrent = () => {
            throw new Error("Expired origin.");
          };
        if (kind === "clear") controller.clear();
        if (kind === "ambiguous") vscode.workspace.textDocuments.push(documentFor(file));
        pause.release();
        await assert.rejects(pending);
        assert.equal(editor.calls.length, 0);
        assert.equal(vscode.comments.controllers.length, 0);
      } finally {
        pause.release();
        pause.restore();
      }
    }, true),
);

test("100 retained annotations are capped atomically without eviction", async () =>
  fixture(async ({ annotate, controller, origin, root, editor }) => {
    const twenty = Array.from({ length: 20 }, () => mark());
    await annotate(twenty);
    for (let index = 1; index < 5; index++) {
      const file = path.join(root, `file-${index}.ts`);
      await writeFile(file, "disk");
      const document = documentFor(file);
      vscode.workspace.textDocuments.push(document);
      vscode.window.tabGroups.all[0].tabs.push({ input: new vscode.TabInputText(document.uri) });
      await controller.annotate({ path: file, annotations: twenty }, origin);
    }
    const extraFile = path.join(root, "extra.ts");
    await writeFile(extraFile, "disk");
    const extra = documentFor(extraFile);
    vscode.workspace.textDocuments.push(extra);
    vscode.window.tabGroups.all[0].tabs.push({ input: new vscode.TabInputText(extra.uri) });
    const native = vscode.comments.controllers[0];
    const retained = [...native.threads];
    assert.equal(retained.length, 5, "Twenty messages sharing each anchor use one thread per document.");
    assert.ok(retained.every((thread: any) => thread.comments.length === 20));
    await assert.rejects(controller.annotate({ path: extraFile, annotations: [mark()] }, origin), /retention/);
    assert.deepEqual(native.threads, retained, "Retention rejection creates no handles and evicts none.");
    assert.ok(retained.every((thread: any) => !thread.disposed));
    assert.equal(lastOptions(editor)?.length, 20);
    await annotate(twenty);
    assert.equal(retained[0].disposeCalls, 1);
    assert.ok(retained.slice(1).every((thread: any) => !thread.disposed));
    const replacement = native.threads.at(-1);
    await annotate([mark()]);
    assert.equal(replacement.disposeCalls, 1);
    await controller.annotate({ path: extraFile, annotations: [mark()] }, origin);
    assert.equal(native.threads.filter((thread: any) => !thread.disposed).length, 6);
  }));

test("20 retained documents are capped and clearing a document frees its slot", async () =>
  fixture(async ({ annotate, controller, origin, root }) => {
    await annotate();
    for (let index = 1; index <= 20; index++) {
      const file = path.join(root, `file-${index}.ts`);
      await writeFile(file, "disk");
      const document = documentFor(file);
      vscode.workspace.textDocuments.push(document);
      vscode.window.tabGroups.all[0].tabs.push({ input: new vscode.TabInputText(document.uri) });
      const request = () => controller.annotate({ path: file, annotations: [mark()] }, origin);
      if (index < 20) await request();
      else {
        await assert.rejects(request(), /retention/);
        await annotate([]);
        await request();
      }
    }
    assert.equal((controller as any).entries.size, 20);
    const threads = vscode.comments.controllers[0].threads.filter((thread: any) => !thread.disposed);
    assert.equal(threads.length, 20);
    controller.clear();
    assert.equal((controller as any).entries.size, 0);
    assert.ok(threads.every((thread: any) => thread.disposeCalls === 1));
  }));
