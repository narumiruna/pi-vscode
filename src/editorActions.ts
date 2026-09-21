import * as vscode from "vscode";
import type { PiConversationController } from "./conversationController";
import {
  buildDiagnosticFixInstruction,
  filterFixableDiagnostics,
  selectDiagnosticAtPosition,
} from "./diagnosticQuickFix";
import {
  addDocumentEditProposal,
  type EditPreviewProvider,
  isDocumentWritable,
  registerEditPreviewProvider,
} from "./editProposalController";
import { buildSelectionReference, extractReplacement, type SelectionContext } from "./prompts";

const maxWholeDocumentEditCharacters = 200_000;

interface SelectionSnapshot {
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly range: vscode.Range;
  readonly context: SelectionContext;
}

interface DiagnosticCommandTarget {
  readonly uri: vscode.Uri;
  readonly diagnostic: vscode.Diagnostic;
}

export function registerEditorActions(context: vscode.ExtensionContext, conversation: PiConversationController): void {
  const previews = registerEditPreviewProvider(context);
  const selectionActionKind = vscode.CodeActionKind.RefactorRewrite.append("picode");
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider("*", new PiCodeQuickFixProvider(), {
      providedCodeActionKinds: [vscode.CodeActionKind.QuickFix],
    }),
    vscode.languages.registerCodeActionsProvider("*", new PiCodeSelectionCodeActionProvider(selectionActionKind), {
      providedCodeActionKinds: [selectionActionKind],
    }),
    vscode.commands.registerCommand("picode.askSelection", () => askSelection(conversation)),
    vscode.commands.registerCommand("picode.modifySelection", () => inlineEdit(previews, conversation)),
    vscode.commands.registerCommand("picode.inlineEdit", () => inlineEdit(previews, conversation)),
    vscode.commands.registerCommand("picode.quickFix", (target?: unknown) => quickFix(previews, conversation, target)),
    vscode.commands.registerCommand("picode.explainSelection", () =>
      answerPreset(conversation, "Explain this code, including its behavior and assumptions."),
    ),
    vscode.commands.registerCommand("picode.reviewSelection", () =>
      answerPreset(
        conversation,
        "Review this code for correctness, security, maintainability, performance, and missing tests. Prioritize actionable findings.",
      ),
    ),
    vscode.commands.registerCommand("picode.fixSelection", () =>
      previewPreset(
        previews,
        conversation,
        "Fix bugs and diagnostics in this code while preserving intended behavior.",
      ),
    ),
    vscode.commands.registerCommand("picode.documentSelection", () =>
      previewPreset(
        previews,
        conversation,
        "Add or improve idiomatic documentation for this code without changing its behavior.",
      ),
    ),
    vscode.commands.registerCommand("picode.generateTests", () =>
      previewPreset(
        previews,
        conversation,
        "Keep the selected code and append comprehensive idiomatic tests that cover normal behavior and important edge cases.",
      ),
    ),
    vscode.commands.registerCommand("picode.suggestNextEdit", () => suggestNextEdit(previews, conversation)),
  );
}

async function askSelection(conversation: PiConversationController): Promise<void> {
  const snapshot = captureSelection();
  if (!snapshot) {
    return;
  }
  const question = await vscode.window.showInputBox({
    title: "Ask Pi About Selection",
    prompt: "What would you like to know about this code?",
    placeHolder: "Explain this code and point out possible issues",
    ignoreFocusOut: true,
  });
  if (!question?.trim()) {
    return;
  }
  await showAnswer(conversation, snapshot, question.trim());
}

async function answerPreset(conversation: PiConversationController, question: string): Promise<void> {
  const snapshot = captureSelection();
  if (snapshot) {
    await showAnswer(conversation, snapshot, question);
  }
}

async function showAnswer(
  conversation: PiConversationController,
  snapshot: SelectionSnapshot,
  question: string,
): Promise<void> {
  try {
    await conversation.sendRequest(question, [buildSelectionReference(snapshot.context)], {
      instructions:
        "Answer the user's question about the selected code. Be concrete and concise. Use Markdown when useful. Do not modify files.",
      resource: snapshot.document.uri,
      policy: "read-only",
    });
  } catch (error) {
    await reportError(error);
  }
}

async function inlineEdit(previews: EditPreviewProvider, conversation: PiConversationController): Promise<void> {
  const snapshot = captureEditTarget();
  if (!snapshot) {
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Inline Edit with Pi",
    prompt: snapshot.range.isEmpty
      ? "What should Pi add at the cursor?"
      : "How should Pi change the selected code or current line?",
    placeHolder: "Make this easier to read without changing behavior",
    ignoreFocusOut: true,
  });
  if (instruction?.trim()) {
    await previewEdit(previews, conversation, snapshot, instruction.trim());
  }
}

async function quickFix(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  target?: unknown,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage("Open a text editor before requesting a Pi quick fix.");
    return;
  }
  if (!(await isDocumentWritable(editor.document))) {
    await vscode.window.showWarningMessage("Pi edits are unavailable for read-only documents.");
    return;
  }

  const diagnostics = filterFixableDiagnostics(vscode.languages.getDiagnostics(editor.document.uri));
  const requestedTarget = isDiagnosticCommandTarget(target) ? target : undefined;
  const requestedDiagnostic =
    requestedTarget?.uri.toString() === editor.document.uri.toString()
      ? findCurrentDiagnostic(diagnostics, requestedTarget.diagnostic)
      : undefined;
  const diagnostic = requestedDiagnostic ?? selectDiagnosticAtPosition(diagnostics, editor.selection.active);
  if (!diagnostic) {
    await inlineEdit(previews, conversation);
    return;
  }

  const documentText = editor.document.getText();
  if (documentText.length > maxWholeDocumentEditCharacters) {
    await vscode.window.showWarningMessage(
      `Pi quick fixes are limited to files under ${maxWholeDocumentEditCharacters.toLocaleString()} characters.`,
    );
    return;
  }
  const range = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(documentText.length));
  await previewEdit(
    previews,
    conversation,
    selectionSnapshot(editor.document, range),
    buildDiagnosticFixInstruction(diagnostic),
  );
}

function isDiagnosticCommandTarget(value: unknown): value is DiagnosticCommandTarget {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<DiagnosticCommandTarget>;
  return candidate.uri instanceof vscode.Uri && candidate.diagnostic instanceof vscode.Diagnostic;
}

function findCurrentDiagnostic(
  diagnostics: readonly vscode.Diagnostic[],
  requested: vscode.Diagnostic,
): vscode.Diagnostic | undefined {
  return diagnostics.find(
    (diagnostic) =>
      diagnostic.severity === requested.severity &&
      diagnostic.message === requested.message &&
      diagnostic.range.isEqual(requested.range),
  );
}

async function suggestNextEdit(previews: EditPreviewProvider, conversation: PiConversationController): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.window.showWarningMessage("Open a text editor before requesting a next edit suggestion.");
    return;
  }
  const document = editor.document;
  if (document.getText().length > 200_000) {
    await vscode.window.showWarningMessage("Next edit suggestions are limited to files under 200,000 characters.");
    return;
  }
  const range = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
  const diagnostics = vscode.languages
    .getDiagnostics(document.uri)
    .slice(0, 20)
    .map((diagnostic) => `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`)
    .join("\n");
  const snapshot = selectionSnapshot(document, range);
  const instruction = [
    `Predict and implement the next logical edit for this file based on the cursor at line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}.`,
    "Make one focused, useful change and preserve unrelated code.",
    diagnostics ? `Current diagnostics:\n${diagnostics}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  await previewEdit(previews, conversation, snapshot, instruction);
}

async function previewPreset(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  instruction: string,
): Promise<void> {
  const snapshot = captureSelection();
  if (snapshot) {
    await previewEdit(previews, conversation, snapshot, instruction);
  }
}

async function previewEdit(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  snapshot: SelectionSnapshot,
  instruction: string,
): Promise<void> {
  try {
    if (!(await isDocumentWritable(snapshot.document))) {
      throw new Error("Pi edits are unavailable for read-only documents.");
    }
    let responseError: unknown;
    await conversation.sendRequest(instruction, [buildSelectionReference(snapshot.context)], {
      instructions: [
        "Rewrite only the selected code according to the user's request.",
        "The replacement must fit in the same location and preserve surrounding behavior unless requested otherwise.",
        "Do not modify files and do not explain the result.",
        "Return exactly <<<PICODE_REPLACEMENT_START>>>, a newline, the replacement text, another newline, and <<<PICODE_REPLACEMENT_END>>>.",
        "Do not use Markdown code fences.",
      ].join(" "),
      resource: snapshot.document.uri,
      policy: "read-only",
      onResponse: (response) => {
        try {
          createEditProposal(previews, conversation, snapshot, response);
        } catch (error) {
          responseError = error;
        }
      },
    });
    if (responseError) {
      throw responseError;
    }
  } catch (error) {
    await reportError(error);
  }
}

function createEditProposal(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  snapshot: SelectionSnapshot,
  response: string,
): void {
  const replacement = extractReplacement(response);
  if (replacement === undefined) {
    throw new Error("Pi returned an unexpected edit format. No changes were applied.");
  }
  addDocumentEditProposal(previews, conversation, snapshot, replacement);
}

function captureSelection(): SelectionSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage("Select some code before running a Pi editor action.");
    return undefined;
  }
  const document = editor.document;
  const range = new vscode.Range(editor.selection.start, editor.selection.end);
  return selectionSnapshot(document, range);
}

function captureEditTarget(): SelectionSnapshot | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    void vscode.window.showWarningMessage("Open a text editor before starting a Pi inline edit.");
    return undefined;
  }
  const range = editor.selection.isEmpty
    ? editor.document.lineAt(editor.selection.active.line).range
    : new vscode.Range(editor.selection.start, editor.selection.end);
  return selectionSnapshot(editor.document, range);
}

function selectionSnapshot(document: vscode.TextDocument, range: vscode.Range): SelectionSnapshot {
  const file = document.uri.scheme === "file" ? document.uri.fsPath : document.uri.toString();
  return {
    document,
    version: document.version,
    range,
    context: {
      file,
      languageId: document.languageId,
      startLine: range.start.line + 1,
      endLine: range.end.line + 1,
      code: document.getText(range),
    },
  };
}

async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) {
    return;
  }
  const action = await vscode.window.showErrorMessage(message, "Open Pi Settings");
  if (action === "Open Pi Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:narumi.pi-coding-agent-vscode");
  }
}

class PiCodeSelectionCodeActionProvider implements vscode.CodeActionProvider {
  public constructor(private readonly kind: vscode.CodeActionKind) {}

  public async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    _context: vscode.CodeActionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.CodeAction[]> {
    if (range.isEmpty || token.isCancellationRequested) {
      return [];
    }

    const ask = new vscode.CodeAction("Ask Pi", this.kind);
    ask.command = {
      command: "picode.askSelection",
      title: ask.title,
    };

    if (!(await isDocumentWritable(document)) || token.isCancellationRequested) {
      return [ask];
    }

    const modify = new vscode.CodeAction("Modify with Pi", this.kind);
    modify.command = {
      command: "picode.modifySelection",
      title: modify.title,
    };
    return [ask, modify];
  }
}

class PiCodeQuickFixProvider implements vscode.CodeActionProvider {
  public async provideCodeActions(
    document: vscode.TextDocument,
    _range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext,
  ): Promise<vscode.CodeAction[]> {
    if (!(await isDocumentWritable(document)) || document.getText().length > maxWholeDocumentEditCharacters) {
      return [];
    }
    return filterFixableDiagnostics(context.diagnostics).map((diagnostic) => {
      const action = new vscode.CodeAction(
        `Fix with Pi: ${truncate(diagnostic.message, 80)}`,
        vscode.CodeActionKind.QuickFix,
      );
      action.diagnostics = [diagnostic];
      action.command = {
        command: "picode.quickFix",
        title: "Quick Fix with Pi",
        arguments: [{ uri: document.uri, diagnostic } satisfies DiagnosticCommandTarget],
      };
      return action;
    });
  }
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 1)}…`;
}
