import path from "node:path";
import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { PiInvocationError } from "./piClient";
import {
  buildAskPrompt,
  buildModifyPrompt,
  extractReplacement,
  type SelectionContext,
} from "./prompts";
import { registerPiSidebar } from "./sidebar";
import { abortAllPiInvocations, invokePiWithCancellation } from "./vscodePi";

interface CapturedSelection {
  readonly document: vscode.TextDocument;
  readonly documentVersion: number;
  readonly range: vscode.Range;
  readonly context: SelectionContext;
}

export function activate(extensionContext: vscode.ExtensionContext): void {
  registerPiChat(extensionContext);
  registerPiSidebar(extensionContext);
  extensionContext.subscriptions.push(
    vscode.commands.registerCommand("piCodingAgent.askSelection", askAboutSelection),
    vscode.commands.registerCommand("piCodingAgent.modifySelection", modifySelection),
  );
}

async function askAboutSelection(): Promise<void> {
  const captured = captureSelection();
  if (!captured) {
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

  try {
    const response = await runWithProgress(
      "Pi is analyzing the selected code…",
      buildAskPrompt(captured.context, question.trim()),
      captured.document.uri,
    );
    const answer = response.trim();
    const result = await vscode.workspace.openTextDocument({
      language: "markdown",
      content: `# Pi response\n\n**Question:** ${question.trim()}\n\n${answer}\n`,
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

async function modifySelection(): Promise<void> {
  const captured = captureSelection();
  if (!captured) {
    return;
  }

  const instruction = await vscode.window.showInputBox({
    title: "Modify Selection with Pi",
    prompt: "How should Pi change the selected code?",
    placeHolder: "Make this easier to read without changing behavior",
    ignoreFocusOut: true,
  });
  if (!instruction?.trim()) {
    return;
  }

  try {
    const response = await runWithProgress(
      "Pi is rewriting the selected code…",
      buildModifyPrompt(captured.context, instruction.trim()),
      captured.document.uri,
    );
    const replacement = extractReplacement(response);
    if (replacement === undefined) {
      const rawResult = await vscode.workspace.openTextDocument({
        language: "plaintext",
        content: response,
      });
      await vscode.window.showTextDocument(rawResult, {
        viewColumn: vscode.ViewColumn.Beside,
        preview: true,
      });
      throw new Error("Pi returned an unexpected modification format. The raw response was opened instead.");
    }

    if (captured.document.isClosed || captured.document.version !== captured.documentVersion) {
      throw new Error("The document changed while Pi was working, so the stale replacement was not applied.");
    }

    const edit = new vscode.WorkspaceEdit();
    const documentReplacement = convertLineEndings(replacement, captured.document.eol);
    edit.replace(captured.document.uri, captured.range, documentReplacement);
    if (!(await vscode.workspace.applyEdit(edit))) {
      throw new Error("VS Code could not apply the Pi replacement.");
    }

    await vscode.window.showInformationMessage("Pi updated the selection. Use Undo to revert the change.");
  } catch (error) {
    await reportError(error);
  }
}

function captureSelection(): CapturedSelection | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    void vscode.window.showWarningMessage("Select some code before running a Pi selection command.");
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
    documentVersion: document.version,
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

async function runWithProgress(title: string, prompt: string, documentUri: vscode.Uri): Promise<string> {
  return vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (_progress, cancellationToken) => {
      return invokePiWithCancellation(prompt, cancellationToken, documentUri);
    },
  );
}

function convertLineEndings(value: string, lineEnding: vscode.EndOfLine): string {
  return lineEnding === vscode.EndOfLine.CRLF ? value.replace(/\n/g, "\r\n") : value;
}

async function reportError(error: unknown): Promise<void> {
  if (error instanceof PiInvocationError && error.kind === "aborted") {
    return;
  }

  const message = formatError(error);
  const action = await vscode.window.showErrorMessage(message, "Open Pi Settings");
  if (action === "Open Pi Settings") {
    await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:narumitw.pi-coding-agent");
  }
}

function formatError(error: unknown): string {
  if (error instanceof PiInvocationError) {
    const details = error.details?.trim();
    return details ? `${error.message} ${details.slice(0, 1000)}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function deactivate(): void {
  abortAllPiInvocations();
}
