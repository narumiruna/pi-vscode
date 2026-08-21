import path from "node:path";
import * as vscode from "vscode";
import { PiInvocationError } from "./piClient";
import { buildAskPrompt, buildModifyPrompt, extractReplacement, type SelectionContext } from "./prompts";
import { invokePiWithCancellation } from "./vscodePi";

const previewScheme = "pi-edit-preview";

interface SelectionSnapshot {
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly range: vscode.Range;
  readonly context: SelectionContext;
}

export function registerEditorActions(context: vscode.ExtensionContext): void {
  const previews = new EditPreviewProvider();
  context.subscriptions.push(
    previews,
    vscode.workspace.registerTextDocumentContentProvider(previewScheme, previews),
    vscode.commands.registerCommand("piCodingAgent.askSelection", () => askSelection()),
    vscode.commands.registerCommand("piCodingAgent.modifySelection", () => inlineEdit(previews)),
    vscode.commands.registerCommand("piCodingAgent.inlineEdit", () => inlineEdit(previews)),
    vscode.commands.registerCommand("piCodingAgent.explainSelection", () => answerPreset("Explain this code, including its behavior and assumptions.")),
    vscode.commands.registerCommand("piCodingAgent.reviewSelection", () => answerPreset("Review this code for correctness, security, maintainability, performance, and missing tests. Prioritize actionable findings.")),
    vscode.commands.registerCommand("piCodingAgent.fixSelection", () => previewPreset(previews, "Fix bugs and diagnostics in this code while preserving intended behavior.")),
    vscode.commands.registerCommand("piCodingAgent.documentSelection", () => previewPreset(previews, "Add or improve idiomatic documentation for this code without changing its behavior.")),
    vscode.commands.registerCommand("piCodingAgent.generateTests", () =>
      previewPreset(previews, "Keep the selected code and append comprehensive idiomatic tests that cover normal behavior and important edge cases."),
    ),
  );
}

async function askSelection(): Promise<void> {
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
  await showAnswer(snapshot, question.trim());
}

async function answerPreset(question: string): Promise<void> {
  const snapshot = captureSelection();
  if (snapshot) {
    await showAnswer(snapshot, question);
  }
}

async function showAnswer(snapshot: SelectionSnapshot, question: string): Promise<void> {
  try {
    const response = await runWithProgress(
      "Pi is analyzing the selected code…",
      buildAskPrompt(snapshot.context, question),
      snapshot.document.uri,
    );
    const result = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# Pi response\n\n**Question:** ${question}\n\n${response.trim()}\n`,
    });
    await vscode.window.showTextDocument(result, {
      viewColumn: vscode.ViewColumn.Beside,
      preview: true,
      preserveFocus: false,
    });
  } catch (error) {
    await reportError(error);
  }
}

async function inlineEdit(previews: EditPreviewProvider): Promise<void> {
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
    await previewEdit(previews, snapshot, instruction.trim());
  }
}

async function previewPreset(previews: EditPreviewProvider, instruction: string): Promise<void> {
  const snapshot = captureSelection();
  if (snapshot) {
    await previewEdit(previews, snapshot, instruction);
  }
}

async function previewEdit(
  previews: EditPreviewProvider,
  snapshot: SelectionSnapshot,
  instruction: string,
): Promise<void> {
  try {
    const response = await runWithProgress(
      "Pi is preparing an edit preview…",
      buildModifyPrompt(snapshot.context, instruction),
      snapshot.document.uri,
    );
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
    await vscode.commands.executeCommand(
      "vscode.diff",
      snapshot.document.uri,
      previewUri,
      `Pi Edit Preview: ${path.basename(snapshot.document.uri.fsPath)}`,
      { preview: true },
    );

    const action = await vscode.window.showInformationMessage(
      "Review the Pi diff, then apply or reject it.",
      "Apply Edit",
      "Reject",
    );
    if (action !== "Apply Edit") {
      return;
    }
    if (snapshot.document.isClosed || snapshot.document.version !== snapshot.version) {
      throw new Error("The document changed after the preview opened, so the stale edit was not applied.");
    }

    const edit = new vscode.WorkspaceEdit();
    edit.replace(snapshot.document.uri, snapshot.range, convertedReplacement);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("VS Code could not apply the Pi edit.");
    }
    await vscode.window.showInformationMessage("Pi edit applied. Use Undo to revert it.");
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

async function runWithProgress(title: string, prompt: string, uri: vscode.Uri): Promise<string> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (_progress, token) => invokePiWithCancellation(prompt, token, uri),
  );
}

function convertLineEndings(value: string, lineEnding: vscode.EndOfLine): string {
  return lineEnding === vscode.EndOfLine.CRLF ? value.replace(/\n/g, "\r\n") : value;
}

async function reportError(error: unknown): Promise<void> {
  if (error instanceof PiInvocationError && error.kind === "aborted") {
    return;
  }
  const details = error instanceof PiInvocationError ? error.details?.trim() : undefined;
  const message = error instanceof Error ? error.message : String(error);
  const action = await vscode.window.showErrorMessage(
    details ? `${message} ${details.slice(0, 1000)}` : message,
    "Open Pi Settings",
  );
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
