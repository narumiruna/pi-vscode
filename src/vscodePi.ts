import * as vscode from "vscode";
import { type PiCodeConfiguration, picodeConfiguration } from "./configuration";
import { invokePi, type PiInvocationOptions } from "./piClient";

const activeControllers = new Set<AbortController>();

export function readPiInvocationOptions(resource?: vscode.Uri): PiInvocationOptions {
  const configuration = picodeConfiguration(undefined, resource);
  const resourceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
  const fallbackFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = resourceFolder?.uri.fsPath ?? fallbackFolder?.uri.fsPath ?? process.cwd();
  const thinkingLevel = configuration.get<string>("thinkingLevel", "default");

  return {
    executablePath: configuration.get<string>("executablePath", "pi").trim() || "pi",
    cwd,
    provider: optionalSetting(configuration, "provider"),
    model: optionalSetting(configuration, "model"),
    thinkingLevel: thinkingLevel === "default" ? undefined : thinkingLevel,
  };
}

export async function invokePiWithCancellation(
  prompt: string,
  cancellationToken: vscode.CancellationToken,
  resource?: vscode.Uri,
): Promise<string> {
  const controller = new AbortController();
  activeControllers.add(controller);
  if (cancellationToken.isCancellationRequested) {
    controller.abort();
  }
  const cancellation = cancellationToken.onCancellationRequested(() => controller.abort());
  try {
    return await invokePi(prompt, readPiInvocationOptions(resource), controller.signal);
  } finally {
    cancellation.dispose();
    activeControllers.delete(controller);
  }
}

export function abortAllPiInvocations(): void {
  for (const controller of activeControllers) {
    controller.abort();
  }
  activeControllers.clear();
}

function optionalSetting(configuration: PiCodeConfiguration, key: string): string | undefined {
  const value = configuration.get<string>(key, "").trim();
  return value || undefined;
}
