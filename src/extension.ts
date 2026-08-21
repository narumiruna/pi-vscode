import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerEditorActions } from "./editorActions";
import { registerInlineCompletions } from "./inlineCompletion";
import { registerPiSidebar } from "./sidebar";
import { abortAllPiInvocations } from "./vscodePi";

export function activate(context: vscode.ExtensionContext): void {
  registerPiChat(context);
  registerEditorActions(context);
  registerInlineCompletions(context);
  registerPiSidebar(context);
}

export function deactivate(): void {
  abortAllPiInvocations();
}
