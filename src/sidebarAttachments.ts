import { randomUUID } from "node:crypto";
import { consumedUnpinnedIds, contextMetadata, contextWarnings, inspectContext, type ContextMetadata } from "./contextInspector";
import { picodeConfiguration } from "./configuration";
import { WorkflowDocuments } from "./workflowUi";
import path from "node:path";
import * as vscode from "vscode";
import {
  decodeBoundedBase64Image,
  imageMimeType,
  isImageSizeAllowed,
  isSupportedImageMimeType,
  withoutAttachmentIds,
} from "./attachmentUtils";
import type { ImageAssetCache } from "./imageAssets";
import type { PiRpcImage } from "./piRpcClient";
import { buildAgentPrompt, limitReferenceContent, type ChatReferenceContext } from "./prompts";
import { relativeDocumentPath, type WebviewMessage } from "./sidebarHelpers";
import { contextTranscriptAttachment, shortTranscriptLabel, type TranscriptAttachment, type TranscriptImageAttachment } from "./sidebarState";
import { queryCodeContext, semanticAttachmentText, type CodeContextOperation } from "./semanticContext";

export interface AttachedContext {
  readonly id: string;
  readonly label: string;
  readonly uri?: vscode.Uri;
  readonly content?: string;
  readonly image?: PiRpcImage;
  readonly imageAssetId?: string;
  readonly metadata?: ContextMetadata;
}

export interface SidebarSubmissionSnapshot {
  readonly ids: readonly string[];
  readonly textContexts: readonly ChatReferenceContext[];
  readonly images: readonly PiRpcImage[];
  readonly resource?: vscode.Uri;
  readonly transcriptAttachments: readonly TranscriptAttachment[];
  readonly recoveryBytes: number;
  readonly consumeAccepted: () => void;
  readonly restoreConsumed: () => void;
}

export function resolveSidebarSubmissionText(rawText: string, submission: Pick<SidebarSubmissionSnapshot, "textContexts" | "images">): string {
  const text = rawText.trim();
  if (text) return text;
  if (submission.images.length && submission.textContexts.length) return "Please analyze the attached images and context.";
  if (submission.images.length) return submission.images.length === 1 ? "Please analyze the attached image." : "Please analyze the attached images.";
  if (submission.textContexts.length) return "Please analyze the attached context.";
  return "";
}

export function resolveSidebarQueueSubmission(
  rawText: string,
  submission: Pick<SidebarSubmissionSnapshot, "textContexts" | "images">,
): { readonly text: string; readonly message: string } | undefined {
  const text = resolveSidebarSubmissionText(rawText, submission);
  if (!text) return undefined;
  if (text.trimStart().startsWith("/")) throw new Error("Slash commands cannot be queued while Pi is working.");
  return { text, message: buildAgentPrompt(text, submission.textContexts) };
}

export interface SidebarAttachmentOptions {
  readonly maxAttachments: number;
  readonly maxImageAttachments: number;
  readonly maxImageBytes: number;
  readonly maxAttachedCharacters: number;
  readonly maxTotalContextCharacters: number;
  readonly imageAssets: ImageAssetCache;
  readonly onChange: () => void;
  readonly onNotice: (message: string, level: "info" | "warning" | "error") => void;
}

export class SidebarAttachmentManager {
  private attachments: AttachedContext[] = [];
  private readonly documents = new WorkflowDocuments();

  public dispose(): void { this.clear(); this.documents.dispose(); }
  private estimateCache: { items: readonly AttachedContext[]; value: ReturnType<typeof inspectContext> } | undefined;
  public get estimate(): ReturnType<typeof inspectContext> {
    if (this.estimateCache?.items !== this.attachments) this.estimateCache = { items: this.attachments, value: inspectContext(this.attachments) };
    return this.estimateCache.value;
  }
  public consume(ids: readonly string[]): void { this.removeMany(consumedUnpinnedIds(this.attachments, ids)); }

  public async inspect(): Promise<void> {
    await this.documents.inspect("Pi attachment context", this.estimate.text);
    const chosen = await vscode.window.showQuickPick(this.attachments.map(item => ({ label: item.label, description: item.metadata?.pinned ? "Pinned snapshot" : "Snapshot", id: item.id })), { title: "Inspect / redact / pin attachment snapshots" });
    if (!chosen) return;
    const item = this.attachments.find(item => item.id === chosen.id);
    if (!item) throw new Error("This snapshot was replaced or consumed.");
    const action = await vscode.window.showQuickPick(["Remove", ...(item.content !== undefined ? ["Edit / Redact", ...(item.metadata?.kind === "debug" ? [] : [item.metadata?.pinned ? "Unpin" : "Pin"]), ...(item.uri && item.metadata?.sourceVersion !== undefined ? ["Refresh from Source"] : [])] : [])], { title: item.label });
    if (!action) return;
    if (action === "Remove") { this.remove(item.id); return; }
    if (action === "Edit / Redact") {
      const document = await vscode.workspace.openTextDocument({ content: item.content, language: "plaintext" });
      await vscode.window.showTextDocument(document, { preview: false });
      if (await vscode.window.showInformationMessage("Edit this temporary document locally, then use its edited text as the attachment. Nothing is sent yet.", "Use Edited Snapshot") !== "Use Edited Snapshot") return;
      if (!this.attachments.some(current => current.id === item.id)) throw new Error("The original snapshot expired while editing.");
      this.addText({ ...item, content: document.getText(), metadata: contextMetadata(document.getText(), item.metadata?.originalLength, (item.metadata?.revision ?? 0) + 1, item.metadata) });
    } else if (action === "Refresh from Source" && item.uri) {
      const document = await vscode.workspace.openTextDocument(item.uri);
      const range = item.metadata?.range;
      const content = document.getText(range ? new vscode.Range(range.startLine, range.startCharacter, range.endLine, range.endCharacter) : undefined);
      if (!this.attachments.some(current => current.id === item.id)) throw new Error("The original snapshot expired while refreshing.");
      this.addText({ ...item, content, metadata: contextMetadata(content, content.length, (item.metadata?.revision ?? 0) + 1, { ...item.metadata, sourceVersion: document.version }) });
    } else {
      this.attachments = this.attachments.map(current => current.id === item.id ? { ...current, id: randomUUID(), metadata: { ...contextMetadata(item.content ?? "", item.metadata?.originalLength, (item.metadata?.revision ?? 0) + 1, item.metadata), pinned: action === "Pin" } } : current);
      this.options.onChange();
    }
  }

  public constructor(private readonly options: SidebarAttachmentOptions) {}

  public get values(): readonly AttachedContext[] {
    return this.attachments;
  }

  public get textContexts(): ChatReferenceContext[] {
    return this.attachments
      .filter((context): context is AttachedContext & { content: string } => typeof context.content === "string")
      .map(context => ({ label: context.label, content: context.content }));
  }

  public get images(): PiRpcImage[] {
    return this.attachments.flatMap(context => context.image ? [context.image] : []);
  }

  public get resource(): vscode.Uri | undefined {
    return this.attachments.find(context => context.uri)?.uri;
  }

  public captureSubmission(): SidebarSubmissionSnapshot {
    const ids = this.attachments.map(item => item.id);
    const restorable = [...this.attachments];
    return {
      ids,
      textContexts: this.textContexts,
      images: this.images,
      resource: this.resource,
      transcriptAttachments: this.transcriptAttachments(ids),
      recoveryBytes: restorable.reduce((total, item) => total + (item.content ? Buffer.byteLength(item.content, "utf8") : item.image ? Buffer.byteLength(item.image.data, "base64") : 0), 0),
      consumeAccepted: () => this.consume(ids),
      restoreConsumed: () => this.restore(restorable),
    };
  }

  private restore(items: readonly AttachedContext[]): void {
    const existingIds = new Set(this.attachments.map(item => item.id));
    const missing = items.filter(item => !existingIds.has(item.id));
    if (!missing.length) return;
    const restored = [...this.attachments, ...missing];
    const imageCount = restored.filter(item => item.image).length;
    const textCharacters = restored.reduce((total, item) => total + (item.content?.length ?? 0), 0);
    if (restored.length > this.options.maxAttachments) {
      throw new Error(`Remove context items before restoring this queued submission; the limit is ${this.options.maxAttachments}.`);
    }
    if (imageCount > this.options.maxImageAttachments) {
      throw new Error(`Remove images before restoring this queued submission; the limit is ${this.options.maxImageAttachments}.`);
    }
    if (textCharacters > this.options.maxTotalContextCharacters) {
      throw new Error("Remove text context before restoring this queued submission; the context limit would be exceeded.");
    }
    this.attachments = restored;
    this.options.onChange();
  }

  public transcriptAttachments(ids: readonly string[] = this.attachments.map(item => item.id)): TranscriptAttachment[] {
    const included = new Set(ids);
    return this.attachments.filter(item => included.has(item.id)).flatMap<TranscriptAttachment>(item => {
      if (!item.image) {
        const descriptor = contextTranscriptAttachment(item.label);
        return descriptor ? [descriptor] : [];
      }
      const descriptor = this.imageDescriptor(item);
      return descriptor ? [descriptor] : [];
    });
  }

  public get summaries(): Array<{
    id: string;
    label: string;
    image: boolean;
    assetId?: string;
    fullLabel?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    availability?: "available" | "unavailable";
  }> {
    return this.attachments.map(item => {
      if (!item.image) return { id: item.id, label: item.label, image: false };
      const descriptor = this.imageDescriptor(item);
      return descriptor
        ? { id: item.id, image: true, ...descriptor }
        : { id: item.id, label: item.label, fullLabel: item.label, image: true, availability: "unavailable" };
    });
  }

  private imageDescriptor(item: AttachedContext): TranscriptImageAttachment | undefined {
    if (!item.image) return undefined;
    const cachedAsset = item.imageAssetId ? this.options.imageAssets.get(item.imageAssetId) : undefined;
    const asset = cachedAsset ?? (
      item.imageAssetId && this.options.imageAssets.isRejected(item.imageAssetId)
        ? undefined
        : this.options.imageAssets.store(item.image.mimeType, item.image.data)
    );
    const assetId = asset?.id ?? item.imageAssetId;
    if (!assetId) return undefined;
    const fullLabel = item.label.replace(/^(?:Image|Pasted image):\s*/i, "") || "Image";
    return {
      type: "image",
      assetId,
      label: shortTranscriptLabel(fullLabel),
      fullLabel,
      ...(asset ? { mimeType: asset.mimeType, width: asset.width, height: asset.height } : {}),
      availability: asset ? "available" : "unavailable",
    };
  }

  public clear(): void {
    this.attachments = [];
    this.options.onChange();
  }

  public remove(id: string): void {
    this.removeMany([id]);
  }

  public removeMany(ids: readonly string[]): void {
    const remaining = withoutAttachmentIds(this.attachments, ids);
    if (remaining.length === this.attachments.length) {
      return;
    }
    this.attachments = remaining;
    this.options.onChange();
  }

  public async pickContext(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [
        { label: "$(inspect) View attachments", action: "inspect" },
        { label: "$(selection) Current Selection", action: "selection" },
        { label: "$(file) Current File", action: "currentFile" },
        { label: "$(files) Files…", action: "files" },
        { label: "$(symbol-method) Definition", action: "semantic:definition" },
        { label: "$(references) References", action: "semantic:references" },
        { label: "$(call-incoming) Callers", action: "semantic:callers" },
        { label: "$(call-outgoing) Callees", action: "semantic:callees" },
        { label: "$(symbol-class) Document Symbols", action: "semantic:documentSymbols" },
        { label: "$(warning) Problems", action: "problems" },
        { label: "$(file-media) Images…", action: "images" },
        { label: "$(terminal) Terminal Selection", action: "terminal" },
      ],
      { title: "Attach to message", placeHolder: "Choose what to share with Pi" },
    );
    if (!selected) return;
    if (selected.action === "inspect") await this.inspect();
    else if (selected.action === "selection") this.attachSelection();
    else if (selected.action === "currentFile") await this.attachCurrentFile();
    else if (selected.action === "files") await this.attachFile();
    else if (selected.action.startsWith("semantic:")) await this.attachSemanticContext(selected.action.slice("semantic:".length) as CodeContextOperation);
    else if (selected.action === "problems") this.attachDiagnostics();
    else if (selected.action === "images") await this.attachImage();
    else await this.attachTerminalSelection();
  }

  public attachSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.options.onNotice("Select code in an editor before attaching it.", "warning");
      return;
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    this.addText({
      uri: editor.document.uri,
      label: `${relativeDocumentPath(editor.document)}:${range.start.line + 1}-${range.end.line + 1}`,
      content: editor.document.getText(range),
      metadata: contextMetadata(editor.document.getText(range), undefined, 1, { sourceVersion: editor.document.version, range: { startLine: range.start.line, startCharacter: range.start.character, endLine: range.end.line, endCharacter: range.end.character } }),
    });
  }

  public async attachCurrentFile(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      this.options.onNotice("Open a text editor before attaching the current file.", "warning");
      return;
    }
    this.addText({ uri: document.uri, label: relativeDocumentPath(document), content: document.getText(), metadata: contextMetadata(document.getText(), undefined, 1, { sourceVersion: document.version }) });
  }

  public async attachFile(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: "Attach Files to Pi",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
    });
    for (const uri of selected ?? []) {
      if (this.attachments.length >= this.options.maxAttachments) {
        this.options.onNotice(`A maximum of ${this.options.maxAttachments} context items can be attached.`, "warning");
        break;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        this.addText({ uri, label: relativeDocumentPath(document), content: document.getText(), metadata: contextMetadata(document.getText(), undefined, 1, { sourceVersion: document.version }) });
      } catch (error) {
        this.options.onNotice(`Could not attach ${uri.fsPath}: ${formatError(error)}`, "warning");
      }
    }
  }

  public async attachSemanticContext(operation: CodeContextOperation): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.options.onNotice("Open a workspace file before attaching semantic context.", "warning");
      return;
    }
    try {
      const position = editor.selection.active;
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Resolve Pi ${semanticOperationLabel(operation)}`, cancellable: true }, async (_progress, token) => queryCodeContext(operation, editor.document.uri, position, token));
      if (!result.items.length) {
        this.options.onNotice(`No ${semanticOperationLabel(operation).toLowerCase()} were returned by the active language provider.`, "info");
        return;
      }
      const content = await semanticAttachmentText(result);
      this.addText({
        uri: editor.document.uri,
        label: `${semanticOperationLabel(operation)}: ${relativeDocumentPath(editor.document)}:${position.line + 1}`,
        content,
        // Multi-source snapshots cannot use the single-document Refresh action.
        metadata: contextMetadata(content, content.length),
      });
    } catch (error) {
      this.options.onNotice(`Could not attach semantic context: ${formatError(error)}`, "warning");
    }
  }

  public attachDiagnostics(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      this.options.onNotice("Open a text editor before attaching diagnostics.", "warning");
      return;
    }
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    if (diagnostics.length === 0) {
      this.options.onNotice("The current file has no diagnostics.", "info");
      return;
    }
    const content = diagnostics.map(diagnostic => {
      const severity = ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Diagnostic";
      const source = diagnostic.source ? ` (${diagnostic.source})` : "";
      return `${severity}${source} at ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message}`;
    }).join("\n");
    this.addText({ uri: document.uri, label: `Diagnostics: ${relativeDocumentPath(document)}`, content });
  }

  public async attachImage(): Promise<void> {
    if (!this.canAddImage()) return;
    const selected = await vscode.window.showOpenDialog({
      title: "Attach Images to Pi",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach Images",
      filters: { Images: ["png", "jpg", "jpeg", "gif", "webp"] },
    });
    for (const uri of selected ?? []) {
      if (!this.canAddImage()) break;
      const stat = await vscode.workspace.fs.stat(uri);
      if (!isImageSizeAllowed(stat.size, this.options.maxImageBytes)) { this.options.onNotice("Image exceeds the attachment size limit.", "warning"); continue; }
      const bytes = await vscode.workspace.fs.readFile(uri);
      if (!isImageSizeAllowed(bytes.byteLength, this.options.maxImageBytes)) {
        this.options.onNotice(`${path.basename(uri.fsPath)} is larger than 5 MiB and was not attached.`, "warning");
        continue;
      }
      const mimeType = imageMimeType(uri.fsPath);
      if (!mimeType) {
        this.options.onNotice(`${path.basename(uri.fsPath)} is not a supported image type.`, "warning");
        continue;
      }
      const data = Buffer.from(bytes).toString("base64");
      const asset = this.options.imageAssets.store(mimeType, data);
      if (!asset) {
        this.options.onNotice(`${path.basename(uri.fsPath)} is not a valid ${mimeType.replace("image/", "").toUpperCase()} image.`, "warning");
        continue;
      }
      this.attachments = [...this.attachments, {
        id: randomUUID(),
        uri,
        label: `Image: ${path.basename(uri.fsPath)}`,
        metadata: contextMetadata(""),
        image: { type: "image", data: asset.data, mimeType: asset.mimeType },
        imageAssetId: asset.id,
      }];
    }
    this.options.onChange();
  }

  public attachPastedImage(message: Extract<WebviewMessage, { type: "pasteImage" }>): void {
    if (!this.canAddImage() || !isSupportedImageMimeType(message.mimeType)) {
      if (!isSupportedImageMimeType(message.mimeType)) this.options.onNotice("The pasted image type is not supported.", "warning");
      return;
    }
    const bytes = decodeBoundedBase64Image(message.data, this.options.maxImageBytes);
    if (!bytes) {
      this.options.onNotice("The pasted image data is invalid or larger than 5 MiB.", "warning");
      return;
    }
    const asset = this.options.imageAssets.store(message.mimeType, bytes.toString("base64"));
    if (!asset) {
      this.options.onNotice("The pasted image contents do not match a supported image format.", "warning");
      return;
    }
    const fileName = path.basename(message.fileName || "pasted-image").slice(0, 200);
    this.attachments = [...this.attachments, {
      id: randomUUID(),
      label: `Pasted image: ${fileName}`,
      metadata: contextMetadata(""),
      image: { type: "image", data: asset.data, mimeType: asset.mimeType },
      imageAssetId: asset.id,
    }];
    this.options.onChange();
  }

  public async attachTerminalSelection(): Promise<void> {
    if (!vscode.window.activeTerminal) {
      this.options.onNotice("Focus a terminal and select output before attaching it.", "warning");
      return;
    }
    const previousClipboard = await vscode.env.clipboard.readText();
    let selection = "";
    try {
      await vscode.env.clipboard.writeText("");
      await vscode.commands.executeCommand("workbench.action.terminal.copySelection");
      selection = await vscode.env.clipboard.readText();
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
    }
    if (!selection) {
      this.options.onNotice("The active terminal has no selected text.", "warning");
      return;
    }
    this.addText({ label: "Terminal selection", content: selection });
  }

  private addText(context: Omit<AttachedContext, "id"> & { content: string }): void {
    const existing = this.attachments.filter(item => item.label !== context.label);
    if (existing.length >= this.options.maxAttachments) {
      this.options.onNotice(`A maximum of ${this.options.maxAttachments} context items can be attached.`, "warning");
      return;
    }
    const usedCharacters = existing.reduce((total, item) => total + (item.content?.length ?? 0), 0);
    const remainingCharacters = this.options.maxTotalContextCharacters - usedCharacters;
    if (remainingCharacters <= 0) {
      this.options.onNotice("The context attachment limit has been reached.", "warning");
      return;
    }
    const content = limitReferenceContent(context.content, remainingCharacters, this.options.maxAttachedCharacters);
    this.attachments = [...existing, { ...context, id: randomUUID(), content, metadata: contextMetadata(content, context.metadata?.originalLength ?? context.content.length, context.metadata?.revision ?? 1, context.metadata) }];
    const warnings = contextWarnings(context.label, content, picodeConfiguration().get<string[]>("sensitiveContextNames", [".env", "credential", "secret", "id_rsa"]));
    if (warnings.length) this.options.onNotice(`${warnings.join("; ")}. Inspect/redact before sending. Detection is best-effort.`, "warning");
    if (content.length < context.content.length) {
      this.options.onNotice("The attached context was truncated to fit the context limit.", "warning");
    }
    this.options.onChange();
  }

  private canAddImage(): boolean {
    if (this.attachments.length >= this.options.maxAttachments) {
      this.options.onNotice(`A maximum of ${this.options.maxAttachments} context items can be attached.`, "warning");
      return false;
    }
    if (this.images.length >= this.options.maxImageAttachments) {
      this.options.onNotice(`A maximum of ${this.options.maxImageAttachments} images can be attached.`, "warning");
      return false;
    }
    return true;
  }
}

function semanticOperationLabel(operation: CodeContextOperation): string {
  return ({ definition: "Definition", references: "References", callers: "Callers", callees: "Callees", documentSymbols: "Document Symbols" })[operation];
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
