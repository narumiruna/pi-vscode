import path from "node:path";
import * as vscode from "vscode";
import { isSupportedImageMimeType } from "./attachmentUtils";
import { extractReplacement, parseAgentPrompt } from "./prompts";
import { type ImageAssetCache, unavailableImageAssetId } from "./imageAssets";
import {
  contextTranscriptAttachment,
  maxTranscriptAttachments,
  maxTranscriptImages,
  restoreSidebarMessages,
  shortTranscriptLabel,
  type SidebarMessage,
  type TranscriptAttachment,
  type TranscriptImageAttachment,
} from "./sidebarState";

export type WebviewMessage =
  | { readonly type: "ready" | "cancel" | "reconnect" | "refreshHistory" | "retry" | "newSession" | "deleteSession" | "showNoticeDetails" | "pickContext" | "pickModel" | "attachSelection" | "attachFile" | "attachCurrentFile" | "attachDiagnostics" | "attachImage" | "attachTerminal" | "clearAttachments" | "compact" | "nameSession" | "resumeSession" | "exportSession" | "openTerminal" | "openSourceControl" | "pickCommand" | "inspectContext" | "clearQueue" | "inspectQueue" }
  | { readonly type: "send"; readonly text: string; readonly revision: number }
  | { readonly type: "queueInstruction"; readonly text: string; readonly revision: number; readonly kind: "steer" | "followUp" }
  | { readonly type: "recoverQueue"; readonly revision: number }
  | { readonly type: "showMoreActions"; readonly text: string; readonly revision: number }
  | { readonly type: "pasteImage"; readonly data: string; readonly mimeType: string; readonly fileName?: string }
  | { readonly type: "setModel"; readonly provider: string; readonly modelId: string }
  | { readonly type: "setThinking"; readonly level: string }
  | { readonly type: "imageAssetEvicted" | "imageAssetRejected"; readonly id: string }
  | { readonly type: "reviewChange" | "openChange" | "revertChange" | "cancelBackground" | "resumeBackground" | "openWorktree" | "cleanupWorktree" | "removeAttachment" | "reviewBackground" | "applyBackground"; readonly id: string }
  | { readonly type: "proposalAction"; readonly id: string; readonly action: "preview" | "apply" | "reject" | "select" }
  | { readonly type: "runBackground"; readonly text: string; readonly isolated: boolean; readonly revision: number };

export function isWebviewMessage(value: unknown, maxImageBytes: number): value is WebviewMessage {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "send") return typeof value.text === "string" && isComposerRevision(value.revision);
  if (value.type === "queueInstruction") return typeof value.text === "string" && value.text.length <= 50_000 && isComposerRevision(value.revision) && ["steer", "followUp"].includes(String(value.kind));
  if (value.type === "recoverQueue") return isComposerRevision(value.revision);
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
  if (value.type === "setModel") return typeof value.provider === "string" && typeof value.modelId === "string";
  if (value.type === "setThinking") return typeof value.level === "string";
  if (value.type === "imageAssetEvicted" || value.type === "imageAssetRejected") return typeof value.id === "string" && /^sha256-[a-f0-9]{64}$/.test(value.id);
  if (value.type === "runBackground") {
    return typeof value.text === "string" && typeof value.isolated === "boolean" && isComposerRevision(value.revision);
  }
  if (value.type === "proposalAction") {
    return typeof value.id === "string" && ["preview", "apply", "reject", "select"].includes(String(value.action));
  }
  if (["reviewChange", "openChange", "revertChange", "cancelBackground", "resumeBackground", "openWorktree", "cleanupWorktree", "removeAttachment", "reviewBackground", "applyBackground"].includes(value.type)) {
    return typeof value.id === "string";
  }
  return [
    "ready", "cancel", "reconnect", "refreshHistory", "retry", "newSession", "deleteSession", "showNoticeDetails", "pickContext", "pickModel", "attachSelection", "attachFile",
    "attachCurrentFile", "attachDiagnostics", "attachImage", "attachTerminal", "clearAttachments", "compact",
    "nameSession", "resumeSession", "exportSession", "openTerminal", "openSourceControl", "pickCommand", "inspectContext", "clearQueue", "inspectQueue",
  ].includes(value.type);
}

export function shouldPostActionErrorNotice(action: WebviewMessage["type"], initialRevision: number, currentRevision: number): boolean {
  return action === "queueInstruction" || initialRevision === currentRevision;
}

export function restoreMessages(value: unknown, maxMessages: number, maxCharacters: number): SidebarMessage[] {
  return restoreSidebarMessages(value, maxMessages, maxCharacters);
}

export interface ConvertPiMessagesOptions {
  readonly imageAssets: ImageAssetCache;
  readonly knownMessages?: readonly SidebarMessage[];
  readonly maxMessages?: number;
}

export function convertPiMessages(values: readonly unknown[], options: ConvertPiMessagesOptions): SidebarMessage[] {
  const requestedLimit = options.maxMessages ?? values.length;
  const retainedCount = Number.isSafeInteger(requestedLimit)
    ? Math.max(0, Math.min(values.length, requestedLimit))
    : values.length;
  const retainedEntries: Array<{ readonly index: number; readonly value: Record<string, unknown> }> = [];
  for (let index = values.length - 1; index >= 0 && retainedEntries.length < retainedCount; index -= 1) {
    const value = values[index];
    if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) continue;
    if (!hasMessageText(value.content) && (value.role !== "user" || !hasMessageImages(value.content))) continue;
    retainedEntries.push({ index, value });
  }
  retainedEntries.reverse();

  const imageAttachmentsByIndex = new Map<number, TranscriptImageAttachment[]>();
  const imageWorkBudget = { remainingBytes: options.imageAssets.maxTotalBytes };
  for (let entryIndex = retainedEntries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const { index, value } = retainedEntries[entryIndex]!;
    if (value.role === "user") {
      imageAttachmentsByIndex.set(index, extractMessageImages(value.content, index, options.imageAssets, imageWorkBudget));
    }
  }

  const messages: SidebarMessage[] = [];
  for (const { index, value } of retainedEntries) {
    const text = extractMessageText(value.content);
    if (value.role === "user") {
      const imageAttachments = imageAttachmentsByIndex.get(index) ?? [];
      if (!text && imageAttachments.length === 0) continue;
      const parsed = parseAgentPrompt(text, maxTranscriptAttachments - imageAttachments.length);
      const attachments: TranscriptAttachment[] = [
        ...parsed.contextLabels.flatMap(label => contextTranscriptAttachment(label) ?? []),
        ...imageAttachments,
      ];
      messages.push({
        id: `pi-user-${String(value.timestamp ?? index)}-${index}`,
        role: "user",
        content: parsed.request,
        ...(attachments.length ? { attachments } : {}),
      });
    } else {
      if (!text) continue;
      const replacement = extractReplacement(text);
      messages.push({
        id: `pi-assistant-${String(value.timestamp ?? index)}-${index}`,
        role: "assistant",
        content: replacement === undefined ? text : `Prepared an edit proposal.\n\n\`\`\`\n${replacement}\n\`\`\``,
      });
    }
  }
  const availableMessages = messages.map(message => ({
    ...message,
    ...(message.attachments ? {
      attachments: message.attachments.map(attachment => attachment.type === "image"
        ? { ...attachment, availability: options.imageAssets.has(attachment.assetId) ? "available" as const : "unavailable" as const }
        : attachment),
    } : {}),
  }));
  return mergeKnownImageLabels(availableMessages, options.knownMessages ?? []);
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

function hasMessageText(content: unknown): boolean {
  return typeof content === "string"
    ? content.length > 0
    : Array.isArray(content) && content.some(part => isRecord(part) && part.type === "text" && typeof part.text === "string" && part.text.length > 0);
}

function hasMessageImages(content: unknown): boolean {
  return Array.isArray(content) && content.some(part => isRecord(part) && part.type === "image");
}

interface ImageLabelQueue {
  skip: number;
  readonly labels: Array<Pick<TranscriptImageAttachment, "label" | "fullLabel">>;
}

function mergeKnownImageLabels(messages: readonly SidebarMessage[], knownMessages: readonly SidebarMessage[]): SidebarMessage[] {
  const knownLabels = new Map<string, Array<Pick<TranscriptImageAttachment, "label" | "fullLabel">>>();
  for (const message of knownMessages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type !== "image" || !attachment.assetId.startsWith("sha256-")) continue;
      const occurrences = knownLabels.get(attachment.assetId) ?? [];
      occurrences.push({ label: attachment.label, fullLabel: attachment.fullLabel });
      knownLabels.set(attachment.assetId, occurrences);
    }
  }
  const currentCounts = new Map<string, number>();
  for (const message of messages) {
    for (const attachment of message.attachments ?? []) {
      if (attachment.type === "image") currentCounts.set(attachment.assetId, (currentCounts.get(attachment.assetId) ?? 0) + 1);
    }
  }
  const queues = new Map<string, ImageLabelQueue>();
  for (const [assetId, count] of currentCounts) {
    const labels = knownLabels.get(assetId) ?? [];
    queues.set(assetId, { skip: Math.max(0, count - labels.length), labels: labels.slice(-count) });
  }
  return messages.map(message => ({
    ...message,
    ...(message.attachments ? { attachments: message.attachments.map(attachment => {
      if (attachment.type !== "image") return attachment;
      const queue = queues.get(attachment.assetId);
      if (!queue) return attachment;
      if (queue.skip > 0) {
        queue.skip -= 1;
        return attachment;
      }
      const known = queue.labels.shift();
      return known ? { ...attachment, ...known } : attachment;
    }) } : {}),
  }));
}

function extractMessageImages(
  content: unknown,
  messageIndex: number,
  cache: ImageAssetCache,
  workBudget: { remainingBytes: number },
): TranscriptImageAttachment[] {
  if (!Array.isArray(content)) return [];
  const images: TranscriptImageAttachment[] = [];
  for (const [partIndex, part] of content.entries()) {
    if (images.length >= maxTranscriptImages) break;
    if (!isRecord(part) || part.type !== "image") continue;
    const mimeType = typeof part.mimeType === "string" ? part.mimeType.toLowerCase() : "";
    const data = typeof part.data === "string" ? part.data : "";
    const estimatedBytes = estimatedBase64Bytes(data);
    const canProcess = estimatedBytes <= workBudget.remainingBytes;
    if (canProcess) workBudget.remainingBytes -= estimatedBytes;
    const asset = canProcess ? cache.store(mimeType, data) : undefined;
    const assetId = asset?.id ?? unavailableImageAssetId(`${messageIndex}:${partIndex}:${mimeType}:${data.slice(0, 10_000)}`);
    const fullLabel = `Image ${images.length + 1}`;
    images.push({
      type: "image",
      assetId,
      label: shortTranscriptLabel(fullLabel),
      fullLabel,
      ...(asset
        ? { mimeType: asset.mimeType, width: asset.width, height: asset.height }
        : isSupportedImageMimeType(mimeType) ? { mimeType } : {}),
      availability: asset ? "available" : "unavailable",
    });
  }
  return images;
}

function estimatedBase64Bytes(data: string): number {
  if (!data) return 0;
  if (data.length % 4 !== 0) return Math.ceil(data.length * 3 / 4);
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, data.length / 4 * 3 - padding);
}
