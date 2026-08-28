import path from "node:path";
import * as vscode from "vscode";
import { extractReplacement, parseAgentPrompt } from "./prompts";
import type { PiAgentMode } from "./runtimeProfiles";
import { limitSidebarMessages, type SidebarMessage } from "./sidebarState";

export type WebviewMessage =
  | { readonly type: "ready" | "cancel" | "reconnect" | "refreshHistory" | "retry" | "newSession" | "pickContext" | "pickModel" | "attachSelection" | "attachFile" | "attachCurrentFile" | "attachDiagnostics" | "attachImage" | "attachTerminal" | "clearAttachments" | "compact" | "nameSession" | "resumeSession" | "exportSession" | "openTerminal" | "openSourceControl" | "handoffAgent" | "pickCommand" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "showMoreActions"; readonly text: string; readonly revision: number }
  | { readonly type: "pasteImage"; readonly data: string; readonly mimeType: string; readonly fileName?: string }
  | { readonly type: "setMode"; readonly mode: PiAgentMode }
  | { readonly type: "setModel"; readonly provider: string; readonly modelId: string }
  | { readonly type: "setThinking"; readonly level: string }
  | { readonly type: "reviewChange" | "openChange" | "revertChange" | "cancelBackground" | "resumeBackground" | "openWorktree" | "cleanupWorktree" | "removeAttachment"; readonly id: string }
  | { readonly type: "proposalAction"; readonly id: string; readonly action: "preview" | "apply" | "reject" }
  | { readonly type: "runBackground"; readonly text: string; readonly isolated: boolean; readonly revision: number };

export function isWebviewMessage(value: unknown, maxImageBytes: number): value is WebviewMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "send") return typeof value.text === "string";
  if (value.type === "showMoreActions") {
    return typeof value.text === "string" && isComposerRevision(value.revision);
  }
  if (value.type === "pasteImage") {
    return (
      typeof value.data === "string" &&
      value.data.length <= Math.ceil(maxImageBytes / 3) * 4 + 4 &&
      typeof value.mimeType === "string" && value.mimeType.length <= 100 &&
      (value.fileName === undefined || (typeof value.fileName === "string" && value.fileName.length <= 500))
    );
  }
  if (value.type === "setMode") return ["ask", "edit", "plan", "agent"].includes(String(value.mode));
  if (value.type === "setModel") return typeof value.provider === "string" && typeof value.modelId === "string";
  if (value.type === "setThinking") return typeof value.level === "string";
  if (value.type === "runBackground") {
    return typeof value.text === "string" && typeof value.isolated === "boolean" && isComposerRevision(value.revision);
  }
  if (value.type === "proposalAction") {
    return typeof value.id === "string" && ["preview", "apply", "reject"].includes(String(value.action));
  }
  if (["reviewChange", "openChange", "revertChange", "cancelBackground", "resumeBackground", "openWorktree", "cleanupWorktree", "removeAttachment"].includes(value.type)) {
    return typeof value.id === "string";
  }
  return [
    "ready", "cancel", "reconnect", "refreshHistory", "retry", "newSession", "pickContext", "pickModel", "attachSelection", "attachFile",
    "attachCurrentFile", "attachDiagnostics", "attachImage", "attachTerminal", "clearAttachments", "compact",
    "nameSession", "resumeSession", "exportSession", "openTerminal", "openSourceControl", "handoffAgent", "pickCommand",
  ].includes(value.type);
}

export function restoreMessages(value: unknown, maxMessages: number, maxCharacters: number): SidebarMessage[] {
  if (!Array.isArray(value)) return [];
  const messages = value.filter((message): message is SidebarMessage => (
    isRecord(message) &&
    typeof message.id === "string" &&
    (message.role === "user" || message.role === "assistant") &&
    typeof message.content === "string" &&
    (message.contextLabel === undefined || typeof message.contextLabel === "string") &&
    (message.truncated === undefined || typeof message.truncated === "boolean")
  ));
  return limitSidebarMessages(messages, maxMessages, maxCharacters);
}

export function convertPiMessages(values: readonly unknown[]): SidebarMessage[] {
  const messages: SidebarMessage[] = [];
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) continue;
    const text = extractMessageText(value.content);
    if (!text) continue;
    if (value.role === "user") {
      const parsed = parseAgentPrompt(text);
      messages.push({
        id: `pi-user-${String(value.timestamp ?? index)}-${index}`,
        role: "user",
        content: parsed.request,
        contextLabel: parsed.contextLabels.join(", ") || undefined,
      });
    } else {
      const replacement = extractReplacement(text);
      messages.push({
        id: `pi-assistant-${String(value.timestamp ?? index)}-${index}`,
        role: "assistant",
        content: replacement === undefined ? text : `Prepared an edit proposal.\n\n\`\`\`\n${replacement}\n\`\`\``,
      });
    }
  }
  return messages;
}

export function extractToolText(value: unknown, maxCharacters: number): string {
  if (!isRecord(value)) return safeJson(value, maxCharacters).slice(-maxCharacters);
  const content = Array.isArray(value.content)
    ? value.content.filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string").map(part => String(part.text)).join("\n")
    : safeJson(value, maxCharacters);
  return content.slice(-maxCharacters);
}

export function safeJson(value: unknown, maxCharacters: number): string {
  try {
    return JSON.stringify(value, undefined, 2).slice(0, maxCharacters);
  } catch {
    return String(value).slice(0, maxCharacters);
  }
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function relativeDocumentPath(document: vscode.TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) return path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
  return document.uri.scheme === "file" ? path.basename(document.uri.fsPath) : document.uri.toString();
}

export function modeLabel(mode: PiAgentMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

export function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function modelSupportsImages(model: Record<string, unknown> | undefined): boolean {
  return Array.isArray(model?.input) && model.input.includes("image");
}

function isComposerRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map(part => String(part.text))
    .join("\n");
}
