import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { AnnotationThreadPrototype } =
  require("./annotationThreadPrototype") as typeof import("./annotationThreadPrototype");

function documentFor(file = "/workspace/source.ts", text = "first\n第二行\nlast") {
  const lines = text.split("\n");
  return {
    uri: MockUri.file(file),
    isClosed: false,
    lineCount: lines.length,
    lineAt: (line: number) => ({ text: lines[line]! }),
    getText: () => {
      throw new Error("Whole source reads are not needed.");
    },
    save: () => {
      throw new Error("Must not save documents.");
    },
  } as unknown as import("vscode").TextDocument;
}

function fixture(run: (prototype: InstanceType<typeof AnnotationThreadPrototype>) => void) {
  vscode.comments.controllers = [];
  const prototype = new AnnotationThreadPrototype();
  try {
    run(prototype);
  } finally {
    prototype.dispose();
  }
}

const controller = () => vscode.comments.controllers[0];
const mark = (endLine = 2, message = "An explanation.") => ({ endLine, message });

test("prototype owns one lazy controller and groups read-only expanded threads by end line", () =>
  fixture((prototype) => {
    const document = documentFor();
    prototype.clear();
    prototype.replace(document, []);
    assert.equal(vscode.comments.controllers.length, 0);
    prototype.replace(document, [mark(2, "First"), mark(3, "EOF"), mark(2, "Second")]);
    assert.equal(vscode.comments.controllers.length, 1);
    assert.equal(controller().id, "pi.annotation-thread-prototype");
    assert.equal(controller().label, "Pi annotations");
    const [grouped, eof] = controller().threads;
    assert.equal(controller().threads.length, 2);
    assert.equal(grouped.uri, document.uri);
    assert.deepEqual(grouped.range.start, { line: 1, character: 3 });
    assert.deepEqual(grouped.range.end, grouped.range.start);
    assert.deepEqual(eof.range.start, { line: 2, character: 4 });
    assert.deepEqual(eof.range.end, eof.range.start, "EOF does not require a trailing newline.");
    assert.deepEqual(
      grouped.comments.map((comment: any) => comment.body.appendedText),
      [["First"], ["Second"]],
    );
    for (const thread of controller().threads) {
      assert.equal(thread.label, "Pi annotation");
      assert.equal(thread.canReply, false);
      assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Expanded);
      for (const comment of thread.comments) {
        assert.equal(comment.mode, vscode.CommentMode.Preview);
        assert.deepEqual(comment.author, { name: "Pi" });
        assert.deepEqual(Object.keys(comment).sort(), ["author", "body", "mode"]);
      }
    }
    assert.equal(controller().commentingRangeProvider, undefined);
    assert.equal(controller().reactionHandler, undefined);
    assert.equal(controller().options, undefined);
    prototype.replace(documentFor("/workspace/other.ts"), [mark(1)]);
    assert.equal(vscode.comments.controllers.length, 1);
  }));

test("prototype uses existing literal-text escaping for multiline and Chinese text", () =>
  fixture((prototype) => {
    const message = "中文\n**bold** ![image](https://example.com/a) [run](command:work) <b>html</b> &copy; a@b.com";
    prototype.replace(documentFor(), [mark(1, message)]);
    const body = controller().threads[0].comments[0].body;
    assert.ok(body instanceof vscode.MarkdownString);
    assert.equal(body.isTrusted, false);
    assert.equal(body.supportHtml, false);
    assert.deepEqual(body.appendedText, [message.replace(/&/g, "&amp;")]);
    const expected = new vscode.MarkdownString();
    expected.appendText(message.replace(/&/g, "&amp;"));
    assert.equal(
      body.value,
      expected.value.replace(/[:@.]/g, (character: string) => `&#${character.charCodeAt(0)};`),
    );
    assert.match(body.value, /中文\n/);
    assert.match(body.value, /\\\*\\\*bold\\\*\\\*/);
    assert.match(body.value, /&amp;copy;/);
    assert.doesNotMatch(body.value, /https:|command:|a@b\.com/);
  }));

test.each([0, -1, 4, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
  "prototype rejects invalid end line %s before creating UI",
  (endLine) =>
    fixture((prototype) => {
      assert.throws(() => prototype.replace(documentFor(), [mark(endLine)]), /Invalid prototype annotation/);
      assert.equal(vscode.comments.controllers.length, 0);
    }),
);

test("prototype validates the entire replacement before changing accepted threads", () =>
  fixture((prototype) => {
    const document = documentFor();
    prototype.replace(document, [mark()]);
    const previous = controller().threads[0];
    for (const invalid of [
      [mark(1), mark(4)],
      [mark(1), mark(2, "")],
      [mark(1, "x".repeat(1_001))],
      Array.from({ length: 21 }, () => mark()),
      [undefined],
      new Array(1),
      null,
    ]) {
      assert.throws(() => prototype.replace(document, invalid as any), /Invalid prototype annotation/);
      assert.equal(controller().threads.length, 1);
      assert.equal(previous.disposed, false);
    }
    prototype.replace(document, [mark(3)]);
    assert.equal(previous.disposed, true);
    assert.equal(previous.disposeCalls, 1);
    assert.equal(controller().threads[1].disposed, false);
  }));

test("prototype disposes partial creation on failure and keeps the previous accepted replacement", () =>
  fixture((prototype) => {
    const document = documentFor();
    prototype.replace(document, [mark()]);
    const owner = controller();
    const previous = owner.threads[0];
    const create = owner.createCommentThread;
    let calls = 0;
    owner.createCommentThread = function (...args: any[]) {
      if (++calls === 2) throw new Error("Creation failed");
      assert.equal(previous.disposed, false, "Previous state survives preparation.");
      return create.apply(this, args);
    };
    assert.throws(() => prototype.replace(document, [mark(1), mark(3)]), /Creation failed/);
    assert.equal(previous.disposed, false);
    assert.equal(owner.threads[1].disposed, true);
    assert.equal(owner.threads[1].disposeCalls, 1);
    assert.equal(owner.disposed, false);
    owner.createCommentThread = create;
    prototype.replace(document, [mark(3)]);
    assert.equal(previous.disposeCalls, 1);
    assert.equal(owner.threads[2].disposed, false);
  }));

test("prototype owns new handles before setting thread properties", () =>
  fixture((prototype) => {
    const document = documentFor();
    prototype.replace(document, [mark()]);
    const owner = controller();
    const create = owner.createCommentThread;
    owner.createCommentThread = function (...args: any[]) {
      const thread = create.apply(this, args);
      Object.defineProperty(thread, "canReply", {
        set() {
          throw new Error("Property failed");
        },
      });
      return thread;
    };
    assert.throws(() => prototype.replace(document, [mark(1)]), /Property failed/);
    assert.equal(owner.threads[0].disposed, false);
    assert.equal(owner.threads[1].disposeCalls, 1);
    prototype.clear();
    assert.equal(owner.threads[0].disposeCalls, 1);
    assert.equal(owner.threads[1].disposeCalls, 1);
  }));

test("prototype retries controller creation failures without retaining partial state", () =>
  fixture((prototype) => {
    const create = vscode.comments.createCommentController;
    vscode.comments.createCommentController = () => {
      throw new Error("Controller failed");
    };
    try {
      assert.throws(() => prototype.replace(documentFor(), [mark()]), /Controller failed/);
      assert.equal(vscode.comments.controllers.length, 0);
    } finally {
      vscode.comments.createCommentController = create;
    }
    prototype.replace(documentFor(), [mark()]);
    assert.equal(vscode.comments.controllers.length, 1);
  }));

test("prototype clears individual documents, empty replacements and all threads without disposing the controller", () =>
  fixture((prototype) => {
    const first = documentFor();
    const second = documentFor("/workspace/other.ts");
    prototype.replace(first, [mark(1), mark(2)]);
    prototype.replace(second, [mark(3)]);
    const [a, b, c] = controller().threads;
    prototype.clear(first);
    prototype.clear(first);
    assert.equal(a.disposeCalls, 1);
    assert.equal(b.disposeCalls, 1);
    assert.equal(c.disposed, false);
    prototype.replace(second, []);
    assert.equal(c.disposeCalls, 1);
    prototype.replace(first, [mark()]);
    prototype.clear();
    prototype.clear();
    assert.equal(controller().threads[3].disposeCalls, 1);
    assert.equal(controller().disposed, false);
  }));

test("prototype dispose is idempotent and cannot create new UI afterward", () =>
  fixture((prototype) => {
    prototype.replace(documentFor(), [mark()]);
    const owner = controller();
    prototype.dispose();
    prototype.dispose();
    prototype.clear();
    assert.equal(owner.disposeCalls, 1);
    assert.equal(owner.threads[0].disposeCalls, 1);
    assert.throws(() => prototype.replace(documentFor(), [mark()]), /disposed/);
    assert.equal(vscode.comments.controllers.length, 1);
  }));

test("unused prototype disposal stays lazy and closed documents cannot create UI", () =>
  fixture((prototype) => {
    const document = { ...documentFor(), isClosed: true };
    assert.throws(() => prototype.replace(document, [mark()]), /closed/);
    prototype.dispose();
    assert.equal(vscode.comments.controllers.length, 0);
  }));

test("prototype performs no file or navigation actions and leaves native collapse state on visible-editor changes", () =>
  fixture((prototype) => {
    const forbidden = () => {
      throw new Error("No source or editor actions are permitted.");
    };
    const saved = {
      openTextDocument: vscode.workspace.openTextDocument,
      applyEdit: vscode.workspace.applyEdit,
      fs: vscode.workspace.fs,
      showTextDocument: vscode.window.showTextDocument,
      executeCommand: vscode.commands.executeCommand,
      activeTextEditor: vscode.window.activeTextEditor,
    };
    vscode.workspace.openTextDocument = forbidden;
    vscode.workspace.applyEdit = forbidden;
    vscode.workspace.fs = { readFile: forbidden, writeFile: forbidden };
    vscode.window.showTextDocument = forbidden;
    vscode.commands.executeCommand = forbidden;
    const editor = { selection: { unchanged: true }, revealRange: forbidden };
    vscode.window.activeTextEditor = editor;
    try {
      const document = documentFor();
      prototype.replace(document, [mark()]);
      const thread = controller().threads[0];
      thread.collapsibleState = vscode.CommentThreadCollapsibleState.Collapsed;
      vscode.workspaceEvents.emit("visibleEditors", []);
      assert.equal(thread.collapsibleState, vscode.CommentThreadCollapsibleState.Collapsed);
      assert.equal(controller().threads.length, 1);
      prototype.replace(document, [mark(3)]);
      prototype.clear();
      assert.equal(vscode.window.activeTextEditor, editor);
      assert.deepEqual(editor.selection, { unchanged: true });
    } finally {
      vscode.workspace.openTextDocument = saved.openTextDocument;
      vscode.workspace.applyEdit = saved.applyEdit;
      vscode.workspace.fs = saved.fs;
      vscode.window.showTextDocument = saved.showTextDocument;
      vscode.commands.executeCommand = saved.executeCommand;
      vscode.window.activeTextEditor = saved.activeTextEditor;
    }
  }));
