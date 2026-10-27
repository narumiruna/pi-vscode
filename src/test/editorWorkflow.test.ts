import assert from "node:assert/strict";
import type {
  EditProposalInput,
  PiEditorConversationController,
  PreparedEditorRequestOptions,
} from "../conversationController";
import type { ChatReferenceContext } from "../prompts";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("selection actions stage captured read-only requests; explicit Send creates proposals with Preview and Apply guards", async () => {
  const vscode = installVscodeMock();
  const providers = new Map<string, any>();
  const codeActionProviders: { provider: any; metadata: any }[] = [];
  const position = (line: number, character: number) => ({ line, character });
  vscode.Range = class {
    public start: any;
    public end: any;
    public get isEmpty() {
      return this.start.line === this.end.line && this.start.character === this.end.character;
    }
    constructor(start: any, end: any) {
      this.start = start;
      this.end = end;
    }
  };
  vscode.EndOfLine = { LF: 1, CRLF: 2 };
  vscode.FilePermission = { Readonly: 1 };
  const refactorRewrite = {
    value: "refactor.rewrite",
    append: (part: string) => ({ value: `refactor.rewrite.${part}` }),
  };
  vscode.CodeActionKind = { QuickFix: "quickfix", RefactorRewrite: refactorRewrite };
  vscode.CodeAction = class {
    public command: any;
    constructor(
      public title: string,
      public kind: any,
    ) {}
  };
  vscode.languages = {
    registerCodeActionsProvider: (_selector: unknown, provider: any, metadata: any) => {
      codeActionProviders.push({ provider, metadata });
      return { dispose() {} };
    },
  };
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: unknown) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: 0 }) };
  let text = "a\nb\nc\n";
  let version = 1;
  let applications = 0;
  const document = {
    uri: MockUri.file("/tmp/editor-workflow.ts"),
    eol: 1,
    languageId: "typescript",
    isClosed: false,
    isUntitled: false,
    get version() {
      return version;
    },
    getText: (range?: { start: ReturnType<typeof position>; end: ReturnType<typeof position> }) =>
      range ? text.slice(range.start.line * 2 + range.start.character, range.end.line * 2 + range.end.character) : text,
    offsetAt: (p: any) => p.line * 2 + p.character,
    positionAt: (offset: number) => position(Math.floor(offset / 2), offset % 2),
  };
  const editor = {
    document,
    selection: { isEmpty: false, start: position(0, 0), end: position(3, 0) },
  };
  const otherEditor = { document: { uri: MockUri.file("/tmp/other.ts") } };
  vscode.window.activeTextEditor = editor;
  vscode.WorkspaceEdit = class {
    edits: any[] = [];
    replace(uri: any, range: any, value: string) {
      this.edits.push({ uri, range, value });
    }
  };
  vscode.workspace.applyEdit = async (edit: any) => {
    assert.equal(edit.edits.length, 1);
    text = edit.edits[0].value;
    version++;
    applications++;
    return true;
  };
  let previewText: string | undefined;
  let proposal: EditProposalInput | undefined;
  vscode.commands.executeCommand = async (command: string, _before: unknown, after: any) => {
    if (command === "vscode.diff") previewText = providers.get(after.scheme).provideTextDocumentContent(after);
  };
  const { registerEditorActions } = require("../editorActions") as typeof import("../editorActions");
  const context: any = { subscriptions: [] };
  let prepared:
    | { request: string; contexts: readonly ChatReferenceContext[]; options: PreparedEditorRequestOptions }
    | undefined;
  let sends = 0;
  const conversation: PiEditorConversationController = {
    prepareEditorRequest: async (request, contexts, options) => {
      prepared = { request, contexts, options };
      // Revealing the Sidebar can change focus before the user sends the request.
      vscode.window.activeTextEditor = otherEditor;
    },
    sendRequest: async (_request, _contexts, options) => {
      options?.validate?.();
      assert.equal(options?.policy, "read-only");
      sends++;
      const response = "<<<PI_VSCODE_REPLACEMENT_START>>>\nA\nb\nC\n\n<<<PI_VSCODE_REPLACEMENT_END>>>";
      await options?.onResponse?.(response);
      return response;
    },
    addEditProposal: (input) => {
      proposal = input;
      return "id";
    },
  };
  const submit = async (detail = "") => {
    assert.ok(prepared);
    assert.ok(!prepared.options.requiresInput || detail.trim());
    await conversation.sendRequest(
      [prepared.request, detail].filter(Boolean).join("\n\n"),
      prepared.contexts,
      prepared.options,
    );
  };
  registerEditorActions(context, conversation);
  try {
    let inputOptions: { title?: string; prompt?: string } | undefined;
    vscode.window.showInputBox = async (options: typeof inputOptions) => {
      inputOptions = options;
      return undefined;
    };
    await vscode.registrations.get("pi.inlineEdit")();
    assert.deepEqual(inputOptions, {
      title: "Inline Edit with Pi",
      prompt: "How should Pi change the selected code or current line?",
      placeHolder: "Make this easier to read without changing behavior",
      ignoreFocusOut: true,
    });

    const selectionProvider = codeActionProviders.find(({ metadata }) =>
      metadata.providedCodeActionKinds.some((kind: any) => kind.value === "refactor.rewrite.pi"),
    )?.provider;
    assert.ok(selectionProvider);
    const selectionActions = await selectionProvider.provideCodeActions(
      document,
      new vscode.Range(position(0, 0), position(1, 0)),
      {},
      { isCancellationRequested: false },
    );
    assert.deepEqual(
      selectionActions.map((action: any) => [action.title, action.kind.value, action.command.command]),
      [
        ["Ask Pi", "refactor.rewrite.pi", "pi.askSelection"],
        ["Modify with Pi", "refactor.rewrite.pi", "pi.modifySelection"],
      ],
    );

    let popups = 0;
    vscode.window.showInputBox = async () => {
      popups++;
      return "This must not be used";
    };
    vscode.window.showQuickPick = async () => {
      popups++;
      return undefined;
    };
    vscode.window.showWarningMessage = vscode.window.showErrorMessage = async () => {
      popups++;
      return undefined;
    };
    const actions = [
      ["pi.modifySelection", "Modify Selection (Preview)", ""],
      ["pi.explainSelection", "Explain Selection", "Explain this code, including its behavior and assumptions."],
      [
        "pi.reviewSelection",
        "Review Selection",
        "Review this code for correctness, security, maintainability, performance, and missing tests. Prioritize actionable findings.",
      ],
      [
        "pi.fixSelection",
        "Fix Selection (Preview)",
        "Fix bugs and diagnostics in this code while preserving intended behavior.",
      ],
      [
        "pi.documentSelection",
        "Document Selection (Preview)",
        "Add or improve idiomatic documentation for this code without changing its behavior.",
      ],
      [
        "pi.generateTests",
        "Generate Tests (Preview)",
        "Keep the selected code and append comprehensive idiomatic tests that cover normal behavior and important edge cases.",
      ],
    ] as const;
    for (const [command, label, request] of actions) {
      vscode.window.activeTextEditor = editor;
      await vscode.registrations.get(command)();
      assert.ok(prepared);
      assert.equal(prepared.request, request);
      assert.equal(prepared.options.label, label);
      assert.equal(prepared.options.resource, document.uri);
      assert.equal(prepared.options.policy, "read-only");
      assert.equal(prepared.contexts[0]?.label, "/tmp/editor-workflow.ts:1:1-4:1");
      assert.match(prepared.contexts[0]!.content, /a\nb\nc\n$/);
      assert.match(prepared.options.instructions!, /Do not modify files/);
      assert.equal(Boolean(prepared.options.requiresInput), command === "pi.modifySelection");
      assert.equal(sends, 0, `${command} must not send at staging`);
      assert.equal(popups, 0, `${command} must not open a request popup`);
      assert.equal(proposal, undefined);
      assert.equal(vscode.window.activeTextEditor, otherEditor);
      if (label.endsWith("(Preview)")) {
        assert.match(
          prepared.options.instructions ?? "",
          /Replacement target reference: "\/tmp\/editor-workflow\.ts:1:1-4:1"/,
        );
        assert.match(prepared.options.instructions ?? "", /other references as context, not replacement targets/);
        assert.equal(typeof prepared.options.onResponse, "function");
        version++;
        await assert.rejects(submit("Additional request detail"), /document changed or closed/i);
        version--;
        document.isClosed = true;
        await assert.rejects(submit("Additional request detail"), /document changed or closed/i);
        document.isClosed = false;
        assert.equal(sends, 0, "Source validation must run before generation");
      } else {
        assert.equal(prepared.options.onResponse, undefined);
      }
    }

    // Capture exact same-line columns before focus changes, not the later active editor.
    editor.selection = { isEmpty: false, start: position(0, 0), end: position(0, 1) };
    vscode.window.activeTextEditor = editor;
    await vscode.registrations.get("pi.modifySelection")();
    assert.equal(prepared!.contexts[0]?.label, "/tmp/editor-workflow.ts:1:1-1:2");
    assert.match(prepared!.contexts[0]!.content, /\n\na$/);
    assert.equal(prepared!.request, "");
    assert.equal(prepared!.options.requiresInput, true);
    editor.selection = { isEmpty: false, start: position(0, 0), end: position(3, 0) };
    vscode.window.activeTextEditor = editor;
    await vscode.registrations.get("pi.modifySelection")();
    assert.equal(sends, 0);
    await submit("Make the first and last lines uppercase");
    assert.equal(sends, 1);
    assert.ok(proposal);
    assert.equal(proposal.label, "editor-workflow.ts:1-4");
    await assert.rejects(proposal.onApply(["h0"]), /Preview the current hunk selection/);
    assert.equal(proposal.hunks?.length, 2);
    await proposal.onPreview(["h0"]);
    assert.equal(previewText, "A\nb\nc\n");
    version++;
    text = "manual\n";
    await assert.rejects(proposal.onApply(["h0"]), /document changed/i);
    assert.equal(applications, 0);
    await proposal.onDispose?.();
    text = "a\nb\nc\n";
    version++;
    vscode.window.activeTextEditor = editor;
    await vscode.registrations.get("pi.fixSelection")();
    assert.equal(sends, 1);
    await submit();
    assert.equal(sends, 2);
    await proposal.onPreview(["h1"]);
    await proposal.onApply(["h1"]);
    assert.equal(text, "a\nb\nC\n");
    assert.equal(applications, 1);
    assert.equal(previewText, text);

    // The separate inline-edit command retains its immediate InputBox flow.
    const lastPrepared = prepared;
    vscode.window.activeTextEditor = editor;
    vscode.window.showInputBox = async () => "Capitalize the first line";
    await vscode.registrations.get("pi.inlineEdit")();
    assert.equal(sends, 3);
    assert.equal(prepared, lastPrepared);
    assert.equal(applications, 1);
    assert.equal(popups, 0);
  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
    vscode.restore();
  }
});
