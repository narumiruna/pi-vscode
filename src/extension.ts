import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerEditorActions } from "./editorActions";
import { registerInlineCompletions } from "./inlineCompletion";
import { PiRuntimeManager } from "./piRuntime";
import { registerPiSidebar } from "./sidebar";
import { abortAllPiInvocations } from "./vscodePi";

export function activate(context: vscode.ExtensionContext): void {
  const runtime = new PiRuntimeManager(context);
  const conversation = registerPiSidebar(context, runtime);
  context.subscriptions.push(runtime);
  registerPiChat(context);
  registerEditorActions(context, conversation);
  registerInlineCompletions(context);
}

export function deactivate(): void {
  abortAllPiInvocations();
}
