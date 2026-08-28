import { randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import {
  decodeBoundedBase64Image,
  imageMimeType,
  isImageSizeAllowed,
  isSupportedImageMimeType,
  withoutAttachmentIds,
} from "./attachmentUtils";
import type { PiRpcImage } from "./piRpcClient";
import { limitReferenceContent, type ChatReferenceContext } from "./prompts";
import { relativeDocumentPath, type WebviewMessage } from "./sidebarHelpers";

export interface AttachedContext {
  readonly id: string;
  readonly label: string;
  readonly uri?: vscode.Uri;
  readonly content?: string;
  readonly image?: PiRpcImage;
}

export interface SidebarAttachmentOptions {
  readonly maxAttachments: number;
  readonly maxImageAttachments: number;
  readonly maxImageBytes: number;
  readonly maxAttachedCharacters: number;
  readonly maxTotalContextCharacters: number;
  readonly onChange: () => void;
  readonly onNotice: (message: string, level: "info" | "warning" | "error") => void;
}

export class SidebarAttachmentManager {
  private attachments: AttachedContext[] = [];

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

  public get summaries(): Array<{ id: string; label: string; image: boolean }> {
    return this.attachments.map(context => ({ id: context.id, label: context.label, image: Boolean(context.image) }));
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
        { label: "$(selection) Current Selection", action: "selection" },
        { label: "$(file) Current File", action: "currentFile" },
        { label: "$(files) Files…", action: "files" },
        { label: "$(warning) Problems", action: "problems" },
        { label: "$(file-media) Images…", action: "images" },
        { label: "$(terminal) Terminal Selection", action: "terminal" },
      ],
      { title: "Add Context to Pi", placeHolder: "Choose context for the next message" },
    );
    if (!selected) return;
    if (selected.action === "selection") this.attachSelection();
    else if (selected.action === "currentFile") await this.attachCurrentFile();
    else if (selected.action === "files") await this.attachFile();
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
    });
  }

  public async attachCurrentFile(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      this.options.onNotice("Open a text editor before attaching the current file.", "warning");
      return;
    }
    this.addText({ uri: document.uri, label: relativeDocumentPath(document), content: document.getText() });
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
        this.addText({ uri, label: relativeDocumentPath(document), content: document.getText() });
      } catch (error) {
        this.options.onNotice(`Could not attach ${uri.fsPath}: ${formatError(error)}`, "warning");
      }
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
      this.attachments = [...this.attachments, {
        id: randomUUID(),
        uri,
        label: `Image: ${path.basename(uri.fsPath)}`,
        image: { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType },
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
    const fileName = path.basename(message.fileName || "pasted-image").slice(0, 200);
    this.attachments = [...this.attachments, {
      id: randomUUID(),
      label: `Pasted image: ${fileName}`,
      image: { type: "image", data: bytes.toString("base64"), mimeType: message.mimeType.toLowerCase() },
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
    this.attachments = [...existing, { ...context, id: randomUUID(), content }];
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
