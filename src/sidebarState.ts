import { isSupportedImageMimeType } from "./attachmentUtils";
import { transcriptImageAssetIdPattern } from "./imageAssets";

export const maxTranscriptAttachments = 8;
export const maxTranscriptImages = 5;
export const maxTranscriptLabelCharacters = 500;
export const maxTranscriptShortLabelCharacters = 80;

export interface HistorySyncFailureState {
  readonly status: string;
  readonly historyRecoveryAvailable: boolean;
}

export function historySyncFailureState(connected: boolean): HistorySyncFailureState {
  return connected
    ? { status: "History unavailable · Refresh available", historyRecoveryAvailable: true }
    : { status: "Disconnected · Reconnect available", historyRecoveryAvailable: false };
}

export interface TranscriptContextAttachment {
  readonly type: "context";
  readonly label: string;
  readonly fullLabel: string;
}

export interface TranscriptImageAttachment {
  readonly type: "image";
  readonly assetId: string;
  readonly label: string;
  readonly fullLabel: string;
  readonly mimeType?: string;
  readonly width?: number;
  readonly height?: number;
  readonly availability: "available" | "unavailable";
}

export type TranscriptAttachment = TranscriptContextAttachment | TranscriptImageAttachment;

export interface SidebarMessage {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly attachments?: readonly TranscriptAttachment[];
  /** Legacy v1 field. New records use attachments. */
  readonly contextLabel?: string;
  readonly truncated?: boolean;
}

export function shortTranscriptLabel(label: string): string {
  const normalized = normalizeTranscriptLabel(label);
  if (normalized.length <= maxTranscriptShortLabelCharacters) return normalized;
  return `…${normalized.slice(-(maxTranscriptShortLabelCharacters - 1))}`;
}

export function contextTranscriptAttachment(fullLabel: string): TranscriptContextAttachment | undefined {
  const normalized = boundedTranscriptLabel(fullLabel, maxTranscriptLabelCharacters);
  if (!normalized) return undefined;
  return { type: "context", label: shortTranscriptLabel(normalized), fullLabel: normalized };
}

export function limitSidebarMessages(
  messages: readonly SidebarMessage[],
  maxMessages: number,
  maxCharacters: number,
): SidebarMessage[] {
  if (maxMessages <= 0 || maxCharacters <= 0) return [];

  const limited: SidebarMessage[] = [];
  let remainingCharacters = maxCharacters;
  for (const message of messages.slice(-maxMessages).reverse()) {
    if (remainingCharacters <= 0) break;
    const content = message.content.slice(-remainingCharacters);
    const truncated = message.truncated || content.length < message.content.length;
    limited.unshift(truncated ? { ...message, content, truncated: true } : { ...message, content });
    remainingCharacters -= content.length;
  }
  return limited;
}

export function restoreSidebarMessages(value: unknown, maxMessages: number, maxCharacters: number): SidebarMessage[] {
  if (!Array.isArray(value)) return [];
  const messages: SidebarMessage[] = [];
  for (const candidate of value) {
    if (!isRecord(candidate) || typeof candidate.id !== "string" || candidate.id.length === 0 || candidate.id.length > 200) continue;
    if ((candidate.role !== "user" && candidate.role !== "assistant") || typeof candidate.content !== "string") continue;
    if (candidate.truncated !== undefined && typeof candidate.truncated !== "boolean") continue;
    const attachments = restoreTranscriptAttachments(candidate.attachments);
    const legacyContext = !Array.isArray(candidate.attachments) && typeof candidate.contextLabel === "string"
      ? contextTranscriptAttachment(candidate.contextLabel)
      : undefined;
    const restoredAttachments = attachments.length ? attachments : legacyContext ? [legacyContext] : [];
    messages.push({
      id: candidate.id,
      role: candidate.role,
      content: candidate.content,
      ...(restoredAttachments.length ? { attachments: restoredAttachments } : {}),
      ...(candidate.truncated ? { truncated: true } : {}),
    });
  }
  return limitSidebarMessages(messages, maxMessages, maxCharacters);
}

export function sidebarMessagesForWebview(
  messages: readonly SidebarMessage[],
  isAssetAvailable: (assetId: string) => boolean,
): SidebarMessage[] {
  return messages.map(message => ({
    ...message,
    ...(message.attachments ? {
      attachments: message.attachments.map(attachment => attachment.type === "image"
        ? { ...attachment, availability: isAssetAvailable(attachment.assetId) ? "available" as const : "unavailable" as const }
        : attachment),
    } : {}),
  }));
}

export function persistableSidebarMessages(messages: readonly SidebarMessage[]): SidebarMessage[] {
  return messages.map(message => ({
    id: message.id,
    role: message.role,
    content: message.content,
    ...(message.attachments?.length ? { attachments: message.attachments.map(attachment => (
      attachment.type === "context"
        ? { type: "context" as const, label: attachment.label, fullLabel: attachment.fullLabel }
        : {
            type: "image" as const,
            assetId: attachment.assetId,
            label: attachment.label,
            fullLabel: attachment.fullLabel,
            ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
            ...(attachment.width ? { width: attachment.width } : {}),
            ...(attachment.height ? { height: attachment.height } : {}),
            availability: attachment.availability,
          }
    )) } : {}),
    ...(message.truncated ? { truncated: true } : {}),
  }));
}

function restoreTranscriptAttachments(value: unknown): TranscriptAttachment[] {
  if (!Array.isArray(value)) return [];
  const restored: TranscriptAttachment[] = [];
  let imageCount = 0;
  for (const candidate of value.slice(0, maxTranscriptAttachments)) {
    if (!isRecord(candidate) || !validLabel(candidate.label, maxTranscriptShortLabelCharacters) || !validLabel(candidate.fullLabel, maxTranscriptLabelCharacters)) continue;
    if (candidate.type === "context") {
      restored.push({ type: "context", label: candidate.label, fullLabel: candidate.fullLabel });
      continue;
    }
    if (candidate.type !== "image" || imageCount >= maxTranscriptImages || typeof candidate.assetId !== "string") continue;
    if (candidate.availability !== "available" && candidate.availability !== "unavailable") continue;
    if (!transcriptImageAssetIdPattern.test(candidate.assetId) && !/^unavailable-[a-f0-9]{64}$/.test(candidate.assetId)) continue;
    if (candidate.mimeType !== undefined && (typeof candidate.mimeType !== "string" || !isSupportedImageMimeType(candidate.mimeType))) continue;
    if (!optionalDimension(candidate.width) || !optionalDimension(candidate.height)) continue;
    if ((candidate.width === undefined) !== (candidate.height === undefined)) continue;
    restored.push({
      type: "image",
      assetId: candidate.assetId,
      label: candidate.label,
      fullLabel: candidate.fullLabel,
      ...(typeof candidate.mimeType === "string" ? { mimeType: candidate.mimeType.toLowerCase() } : {}),
      ...(typeof candidate.width === "number" ? { width: candidate.width, height: candidate.height as number } : {}),
      // Payloads are intentionally not persisted, so restored images begin unavailable.
      availability: "unavailable",
    });
    imageCount += 1;
  }
  return restored;
}

function normalizeTranscriptLabel(label: string): string {
  return label.replace(/[\r\n\t]+/g, " ").trim();
}

function boundedTranscriptLabel(label: string, maxCharacters: number): string {
  const normalized = normalizeTranscriptLabel(label);
  if (normalized.length <= maxCharacters) return normalized;
  const prefixLength = Math.floor((maxCharacters - 1) / 2);
  return `${normalized.slice(0, prefixLength)}…${normalized.slice(-(maxCharacters - prefixLength - 1))}`;
}

function validLabel(value: unknown, maxCharacters: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxCharacters && !/[\r\n\t]/.test(value);
}

function optionalDimension(value: unknown): boolean {
  return value === undefined || (Number.isInteger(value) && Number(value) > 0 && Number(value) <= 100_000);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
