import path from "node:path";
import * as vscode from "vscode";
import type { PiConversationController } from "./conversationController";
import { extractReplacement, type ChatReferenceContext, type SelectionContext } from "./prompts";

const previewScheme = "pi-edit-preview";

interface SelectionSnapshot {
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly range: vscode.Range;
  readonly context: SelectionContext;
}

export function registerEditorActions(
  context: vscode.ExtensionContext,
  conversation: PiConversationController,
): void {
  const previews = new EditPreviewProvider();
  context.subscriptions.push(
    previews,
    vscode.workspace.registerTextDocumentContentProvider(previewScheme, previews),
    vscode.commands.registerCommand("piCodingAgent.askSelection", () => askSelection(conversation)),
    vscode.commands.registerCommand("piCodingAgent.modifySelection", () => inlineEdit(previews, conversation)),
    vscode.commands.registerCommand("piCodingAgent.inlineEdit", () => inlineEdit(previews, conversation)),
    vscode.commands.registerCommand("piCodingAgent.explainSelection", () => answerPreset(conversation, "Explain this code, including its behavior and assumptions.")),
    vscode.commands.registerCommand("piCodingAgent.reviewSelection", () => answerPreset(conversation, "Review this code for correctness, security, maintainability, performance, and missing tests. Prioritize actionable findings.")),
    vscode.commands.registerCommand("piCodingAgent.fixSelection", () => previewPreset(previews, conversation, "Fix bugs and diagnostics in this code while preserving intended behavior.")),
    vscode.commands.registerCommand("piCodingAgent.documentSelection", () => previewPreset(previews, conversation, "Add or improve idiomatic documentation for this code without changing its behavior.")),
    vscode.commands.registerCommand("piCodingAgent.generateTests", () =>
      previewPreset(previews, conversation, "Keep the selected code and append comprehensive idiomatic tests that cover normal behavior and important edge cases."),
    ),
    vscode.commands.registerCommand("piCodingAgent.suggestNextEdit", () => suggestNextEdit(previews, conversation)),
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
    await conversation.sendRequest(question, [selectionReference(snapshot.context)], {
      instructions: "Answer the user's question about the selected code. Be concrete and concise. Use Markdown when useful. Do not modify files.",
      resource: snapshot.document.uri,
    });
  } catch (error) {
    await reportError(error);
  }
}

async function inlineEdit(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
): Promise<void> {
  const snapshot = captureSelection();
  if (!snapshot) {
    return;
  }
  const instruction = await vscode.window.showInputBox({
    title: "Inline Edit with Pi",
    prompt: "How should Pi change the selected code?",
    placeHolder: "Make this easier to read without changing behavior",
    ignoreFocusOut: true,
  });
  if (instruction?.trim()) {
    await previewEdit(previews, conversation, snapshot, instruction.trim());
  }
}

async function suggestNextEdit(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
): Promise<void> {
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
  const diagnostics = vscode.languages.getDiagnostics(document.uri)
    .slice(0, 20)
    .map(diagnostic => `Line ${diagnostic.range.start.line + 1}: ${diagnostic.message}`)
    .join("\n");
  const snapshot = selectionSnapshot(document, range);
  const instruction = [
    `Predict and implement the next logical edit for this file based on the cursor at line ${editor.selection.active.line + 1}, column ${editor.selection.active.character + 1}.`,
    "Make one focused, useful change and preserve unrelated code.",
    diagnostics ? `Current diagnostics:\n${diagnostics}` : "",
  ].filter(Boolean).join("\n");
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
    const response = await conversation.sendRequest(instruction, [selectionReference(snapshot.context)], {
      instructions: [
        "Rewrite only the selected code according to the user's request.",
        "The replacement must fit in the same location and preserve surrounding behavior unless requested otherwise.",
        "Do not modify files and do not explain the result.",
        "Return exactly <<<PI_REPLACEMENT_START>>>, a newline, the replacement text, another newline, and <<<PI_REPLACEMENT_END>>>.",
        "Do not use Markdown code fences.",
      ].join(" "),
      resource: snapshot.document.uri,
    });
    const replacement = extractReplacement(response);
    if (replacement === undefined) {
      throw new Error("Pi returned an unexpected edit format. No changes were applied.");
    }
    if (snapshot.document.isClosed || snapshot.document.version !== snapshot.version) {
      throw new Error("The document changed while Pi was working, so the stale edit was not previewed.");
    }

    const convertedReplacement = convertLineEndings(replacement, snapshot.document.eol);
    const originalText = snapshot.document.getText();
    const startOffset = snapshot.document.offsetAt(snapshot.range.start);
    const endOffset = snapshot.document.offsetAt(snapshot.range.end);
    const previewText = originalText.slice(0, startOffset) + convertedReplacement + originalText.slice(endOffset);
    const previewUri = previews.create(snapshot.document.uri, previewText);
    conversation.addEditProposal({
      label: `${path.basename(snapshot.document.uri.fsPath)}:${snapshot.range.start.line + 1}-${snapshot.range.end.line + 1}`,
      onPreview: async () => {
        await vscode.commands.executeCommand(
          "vscode.diff",
          snapshot.document.uri,
          previewUri,
          `Pi Edit Preview: ${path.basename(snapshot.document.uri.fsPath)}`,
          { preview: true },
        );
      },
      onApply: async () => {
        if (snapshot.document.isClosed || snapshot.document.version !== snapshot.version) {
          throw new Error("The document changed after Pi generated the proposal. Regenerate the edit before applying it.");
        }
        const edit = new vscode.WorkspaceEdit();
        edit.replace(snapshot.document.uri, snapshot.range, convertedReplacement);
        if (!(await vscode.workspace.applyEdit(edit))) {
          throw new Error("VS Code could not apply the Pi edit.");
        }
      },
    });
  } catch (error) {
    await reportError(error);
  }
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

function selectionSnapshot(document: vscode.TextDocument, range: vscode.Range): SelectionSnapshot {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  const file = workspaceFolder
    ? path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath)
    : document.uri.scheme === "file"
      ? path.basename(document.uri.fsPath)
      : document.uri.toString();
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

function selectionReference(context: SelectionContext): ChatReferenceContext {
  return {
    label: `${context.file}:${context.startLine}-${context.endLine}`,
    content: [
      `Language: ${context.languageId}`,
      `Lines: ${context.startLine}-${context.endLine}`,
      "",
      context.code,
    ].join("\n"),
  };
}

function convertLineEndings(value: string, lineEnding: vscode.EndOfLine): string {
  return lineEnding === vscode.EndOfLine.CRLF ? value.replace(/\n/g, "\r\n") : value;
}

async function reportError(error: unknown): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  if (/cancelled/i.test(message)) {
    return;
  }
  const action = await vscode.window.showErrorMessage(message, "Open Pi Settings");
  if (action === "Open Pi Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:narumitw.pi-coding-agent");
  }
}

class EditPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.emitter.event;

  public create(original: vscode.Uri, content: string): vscode.Uri {
    const uri = vscode.Uri.from({
      scheme: previewScheme,
      path: original.path,
      query: randomId(),
    });
    this.contents.set(uri.toString(), content);
    while (this.contents.size > 20) {
      const oldest = this.contents.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.contents.delete(oldest);
    }
    return uri;
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
