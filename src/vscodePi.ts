import * as vscode from "vscode";
import { type PiConfiguration, piConfiguration } from "./configuration";
import { invokePi, type PiInvocationOptions } from "./piClient";
import { resolvePiRuntime } from "./piRuntimeSelection";

const activeControllers = new Set<AbortController>();
let extensionRoot: string | undefined;

/** Activation supplies the workspace Extension Host installation, without starting or validating Pi. */
export function initializePiRuntime(root: string): void {
  extensionRoot = root;
}

export function readPiInvocationSettings(resource?: vscode.Uri): PiInvocationOptions {
  const configuration = piConfiguration(undefined, resource);
  const resourceFolder = resource ? vscode.workspace.getWorkspaceFolder(resource) : undefined;
  const fallbackFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = resourceFolder?.uri.fsPath ?? fallbackFolder?.uri.fsPath ?? process.cwd();
  const thinkingLevel = configuration.get<string>("thinkingLevel", "default");

  return {
    executablePath: configuration.get<string>("executablePath", "").trim(),
    cwd,
    provider: optionalSetting(configuration, "provider"),
    model: optionalSetting(configuration, "model"),
    thinkingLevel: thinkingLevel === "default" ? undefined : thinkingLevel,
  };
}

export function readPiInvocationOptions(resource?: vscode.Uri): PiInvocationOptions {
  const settings = readPiInvocationSettings(resource);
  return { ...settings, ...resolvePiRuntime(settings.executablePath, extensionRoot) };
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

function optionalSetting(configuration: PiConfiguration, key: string): string | undefined {
  const value = configuration.get<string>(key, "").trim();
  return value || undefined;
}
