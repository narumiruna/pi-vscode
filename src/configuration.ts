import * as vscode from "vscode";

export interface PiConfiguration {
  get<T>(key: string, defaultValue: T): T;
}

export function piConfiguration(section?: string, resource?: vscode.Uri): PiConfiguration {
  const suffix = section ? `.${section}` : "";
  return vscode.workspace.getConfiguration(`pi${suffix}`, resource);
}
