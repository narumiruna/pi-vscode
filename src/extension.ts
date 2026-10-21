import * as vscode from "vscode";
import { registerPiChat } from "./chat";
import { registerDebugContext } from "./debugContextController";
import { registerEditorActions } from "./editorActions";
import { registerExtensionUiDialogs } from "./extensionUiDialogs";
import { registerGitReview } from "./gitReviewController";
import { registerInlineCompletions } from "./inlineCompletion";
import { removeLegacyGlobalBridgeExtensions } from "./legacyBridge";
import { type LogMetadata, PiLogger, safeErrorCategory, safeErrorCode } from "./logging";
import { registerNativePiManagement } from "./nativePiController";
import { registerPiCompatibility } from "./piCompatibility";
import { PiRuntimeManager } from "./piRuntime";
import { registerProviderAuthentication } from "./providerAuth";
import { registerSettingsPanel } from "./settingsPanel";
import { registerPiSidebar } from "./sidebar";
import { registerTestRepair } from "./testRepairController";
import { abortAllPiInvocations } from "./vscodePi";
import { registerWorkspaceDiagnostics } from "./workspaceDiagnosticsController";

export interface PiVscodeApi {
  broadcast(event: string, data: unknown): number;
}

export async function activate(context: vscode.ExtensionContext): Promise<PiVscodeApi> {
  let channel: vscode.LogOutputChannel | undefined;
  try {
    channel = vscode.window.createOutputChannel("Pi", { log: true });
  } catch {
    // An unavailable diagnostic channel must not prevent activation.
  }
  const logger = new PiLogger(channel);
  context.subscriptions.push(logger);
  const operationId = logger.operation();
  logger.record("info", "activation", {
    operationId,
    result: "started",
    extensionVersion: context.extension.packageJSON.version,
    vscodeVersion: vscode.version,
    platform: process.platform,
    host: vscode.env.remoteName ? "remote" : "local",
  });
  let activationStage: LogMetadata["stage"] = "migration";
  try {
    return await activateWithLogger(context, logger, operationId, (stage) => {
      activationStage = stage;
    });
  } catch (error) {
    logger.record("error", "activation", {
      operationId,
      result: "failed",
      stage: activationStage,
      category: safeErrorCategory(error),
      errorCode: safeErrorCode(error),
    });
    throw error;
  }
}

async function activateWithLogger(
  context: vscode.ExtensionContext,
  logger: PiLogger,
  operationId: LogMetadata["operationId"],
  setStage: (stage: LogMetadata["stage"]) => void,
): Promise<PiVscodeApi> {
  const stage = (value: LogMetadata["stage"]) => {
    setStage(value);
    logger.record("info", "activation", { operationId, stage: value, result: "started" });
  };
  stage("migration");
  try {
    await removeLegacyGlobalBridgeExtensions();
  } catch (error) {
    throw new Error(`Could not remove the legacy global Pi bridge extension: ${formatError(error)}`, { cause: error });
  }
  const runtime = new PiRuntimeManager(context, logger);
  context.subscriptions.push(
    runtime,
    vscode.commands.registerCommand("pi.clearAnnotations", () => runtime.clearAnnotations()),
  );
  stage("ownership");
  await runtime.initializeControlOwnership();
  stage("bridge");
  await runtime.initializeBridge();
  stage("registration");
  registerExtensionUiDialogs(context, runtime);
  const conversation = registerPiSidebar(context, runtime, logger);
  registerPiCompatibility(context, runtime);
  registerSettingsPanel(context);
  registerNativePiManagement(context, runtime);
  registerProviderAuthentication(context, runtime);
  registerPiChat(context);
  registerEditorActions(context, conversation);
  registerGitReview(context, runtime, conversation);
  registerWorkspaceDiagnostics(context, runtime, conversation);
  registerTestRepair(context, runtime, conversation);
  registerDebugContext(context, runtime, conversation);
  registerInlineCompletions(context, logger);
  logger.record("info", "activation", { operationId, stage: "registration", result: "ready" });
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
