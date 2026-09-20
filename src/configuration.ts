import * as vscode from "vscode";

const currentNamespace = "picode";
const previousNamespace = "piCodingAgent";
const explicitValueKeys = [
  "globalValue",
  "workspaceValue",
  "workspaceFolderValue",
  "globalLanguageValue",
  "workspaceLanguageValue",
  "workspaceFolderLanguageValue",
] as const;

export interface PiCodeConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

export function picodeConfiguration(section?: string, resource?: vscode.Uri): PiCodeConfiguration {
  const suffix = section ? `.${section}` : "";
  const current = vscode.workspace.getConfiguration(`${currentNamespace}${suffix}`, resource);
  const previous = vscode.workspace.getConfiguration(`${previousNamespace}${suffix}`, resource);
  return {
    get<T>(key: string, defaultValue: T): T {
      const inspection = current.inspect<T>(key);
      const hasCurrentValue =
        inspection !== undefined && explicitValueKeys.some((valueKey) => inspection[valueKey] !== undefined);
      return hasCurrentValue ? current.get<T>(key, defaultValue) : previous.get<T>(key, defaultValue);
    },
  };
}
