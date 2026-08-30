import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerEditorActions } from "./editorActions";
import { registerInlineCompletions } from "./inlineCompletion";
import { PiRuntimeManager } from "./piRuntime";
import { registerPiSidebar } from "./sidebar";
import { abortAllPiInvocations } from "./vscodePi";

export interface PiVscodeApi {
  broadcast(event: string, data: unknown): number;
}

export async function activate(context: vscode.ExtensionContext): Promise<PiVscodeApi> {
  const runtime = new PiRuntimeManager(context);
  context.subscriptions.push(runtime);
  await runtime.initializeBridge();
  const conversation = registerPiSidebar(context, runtime);
  registerPiChat(context);
  registerEditorActions(context, conversation);
  registerInlineCompletions(context);
  return Object.freeze({
    broadcast: (event: string, data: unknown) => runtime.broadcastToPi(event, data),
  });
}

export function deactivate(): void {
  abortAllPiInvocations();
}
