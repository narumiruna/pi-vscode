import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerGitReview } from "./gitReviewController";
import { registerWorkspaceDiagnostics } from "./workspaceDiagnosticsController";
import { registerTestRepair } from "./testRepairController";
import { registerDebugContext } from "./debugContextController";
import { registerEditorActions } from "./editorActions";
import { registerInlineCompletions } from "./inlineCompletion";
import { removeLegacyGlobalBridgeExtensions } from "./legacyBridge";
import { PiRuntimeManager } from "./piRuntime";
import { registerPiCodeSidebar } from "./sidebar";
import { abortAllPiInvocations } from "./vscodePi";

export interface PiVscodeApi {
  broadcast(event: string, data: unknown): number;
}

export async function activate(context: vscode.ExtensionContext): Promise<PiVscodeApi> {
  try {
    await removeLegacyGlobalBridgeExtensions();
  } catch (error) {
    throw new Error(`Could not remove the legacy global Pi bridge extension: ${formatError(error)}`, { cause: error });
  }
  const runtime = new PiRuntimeManager(context);
  context.subscriptions.push(runtime);
  await runtime.initializeBridge();
  const conversation = registerPiCodeSidebar(context, runtime);
  registerPiChat(context);
  registerEditorActions(context, conversation);
  registerGitReview(context, runtime, conversation);
  registerWorkspaceDiagnostics(context, runtime, conversation);
  registerTestRepair(context, runtime, conversation);
  registerDebugContext(context, runtime, conversation);
  registerInlineCompletions(context);
  return Object.freeze({
    broadcast: (event: string, data: unknown) => runtime.broadcastToPi(event, data),
  });
}

export function deactivate(): void {
  abortAllPiInvocations();
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
