import type * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerDebugContext } from "./debugContextController";
import { registerEditorActions } from "./editorActions";
import { registerExtensionUiDialogs } from "./extensionUiDialogs";
import { registerGitReview } from "./gitReviewController";
import { registerInlineCompletions } from "./inlineCompletion";
import { removeLegacyGlobalBridgeExtensions } from "./legacyBridge";
import { registerPiCompatibility } from "./piCompatibility";
import { registerNativePiManagement } from "./nativePiController";
import { PiRuntimeManager } from "./piRuntime";
import { registerSettingsPanel } from "./settingsPanel";
import { registerPiSidebar } from "./sidebar";
import { registerTestRepair } from "./testRepairController";
import { abortAllPiInvocations } from "./vscodePi";
import { registerWorkspaceDiagnostics } from "./workspaceDiagnosticsController";

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
  await runtime.initializeControlOwnership();
  await runtime.initializeBridge();
  registerExtensionUiDialogs(context, runtime);
  const conversation = registerPiSidebar(context, runtime);
  registerPiCompatibility(context, runtime);
  registerSettingsPanel(context);
  registerNativePiManagement(context, runtime);
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
