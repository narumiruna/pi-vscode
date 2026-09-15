import assert from "node:assert/strict";
import type { EditProposalInput } from "../conversationController";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("existing editor action requests stay read-only; selected preview matches one Apply and manual edits block all writes", async () => {
  const vscode = installVscodeMock();
  const providers = new Map<string, any>();
  const codeActionProviders: { provider: any; metadata: any }[] = [];
  const position = (line: number, character: number) => ({ line, character });
  vscode.Range = class {
    public start: any;
    public end: any;
    public get isEmpty() { return this.start.line === this.end.line && this.start.character === this.end.character; }
    constructor(start: any, end: any) { this.start = start; this.end = end; }
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
    constructor(public title: string, public kind: any) {}
  };
  vscode.languages = {
    registerCodeActionsProvider: (_selector: unknown, provider: any, metadata: any) => {
      codeActionProviders.push({ provider, metadata });
      return { dispose() {} };
    },
  };
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: unknown) => { providers.set(scheme, provider); return { dispose() {} }; };
  vscode.workspace.fs = { isWritableFileSystem: () => true, stat: async () => ({ permissions: 0 }) };
  let text = "a\nb\nc\n", version = 1, applications = 0;
  const document = { uri: MockUri.file("/tmp/editor-workflow.ts"), eol: 1, languageId: "typescript", isClosed: false, isUntitled: false,
    get version() { return version; }, getText: () => text, offsetAt: (p: any) => p.line * 2 + p.character, positionAt: (offset: number) => position(Math.floor(offset / 2), offset % 2) };
  vscode.window.activeTextEditor = { document, selection: { isEmpty: false, start: position(0, 0), end: position(3, 0) } };
  vscode.WorkspaceEdit = class { edits: any[] = []; replace(uri: any, range: any, value: string) { this.edits.push({ uri, range, value }); } };
  vscode.workspace.applyEdit = async (edit: any) => { assert.equal(edit.edits.length, 1); text = edit.edits[0].value; version++; applications++; return true; };
  let previewText: string | undefined, proposal: EditProposalInput | undefined;
  vscode.commands.executeCommand = async (command: string, _before: unknown, after: any) => { if (command === "vscode.diff") previewText = providers.get(after.scheme).provideTextDocumentContent(after); };
  const { registerEditorActions } = require("../editorActions") as typeof import("../editorActions");
  const context: any = { subscriptions: [] };
  registerEditorActions(context, {
    sendRequest: async (_request, _contexts, options) => { assert.equal(options?.policy, "read-only"); const response = "<<<PICODE_REPLACEMENT_START>>>\nA\nb\nC\n\n<<<PICODE_REPLACEMENT_END>>>"; await options?.onResponse?.(response); return response; },
    addEditProposal: input => { proposal = input; return "id"; },
  });
  try {
    let inputOptions: { title?: string; prompt?: string } | undefined;
    vscode.window.showInputBox = async (options: typeof inputOptions) => { inputOptions = options; return undefined; };
    await vscode.registrations.get("picode.inlineEdit")();
    assert.deepEqual(inputOptions, {
      title: "Inline Edit with Pi",
      prompt: "How should Pi change the selected code or current line?",
      placeHolder: "Make this easier to read without changing behavior",
      ignoreFocusOut: true,
    });

    const selectionProvider = codeActionProviders.find(({ metadata }) =>
      metadata.providedCodeActionKinds.some((kind: any) => kind.value === "refactor.rewrite.picode"),
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
        ["Ask Pi", "refactor.rewrite.picode", "picode.askSelection"],
        ["Modify with Pi", "refactor.rewrite.picode", "picode.modifySelection"],
      ],
    );

    await vscode.registrations.get("picode.fixSelection")();
    assert.ok(proposal); assert.equal(proposal.hunks?.length, 2);
    await proposal.onPreview(["h0"]); assert.equal(previewText, "A\nb\nc\n");
    version++; text = "manual\n";
    await assert.rejects(proposal.onApply(["h0"]), /document changed/i); assert.equal(applications, 0);
    await proposal.onDispose?.();
    text = "a\nb\nc\n"; version++;
    await vscode.registrations.get("picode.fixSelection")();
    await proposal.onPreview(["h1"]); await proposal.onApply(["h1"]);
    assert.equal(text, "a\nb\nC\n"); assert.equal(applications, 1);
    assert.equal(previewText, text);
  } finally { for (const disposable of context.subscriptions) disposable.dispose(); vscode.restore(); }
});
