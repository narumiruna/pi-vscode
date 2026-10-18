import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { type ExtensionDialogRequest, maxDialogTextCharacters } from "./extensionDialogRequests";
import type { PiRpcEvent } from "./piRpcClient";
import type { PiRuntimeManager } from "./piRuntime";

export const extensionEditorSubmitCommand = "pi.extensionEditor.submit";
export const extensionEditorCancelCommand = "pi.extensionEditor.cancel";
export const extensionDialogAllowCommand = "pi.extensionDialog.allow";
export const extensionDialogBlockCommand = "pi.extensionDialog.block";

interface OwnedEditor {
  readonly request: ExtensionDialogRequest;
  document?: vscode.TextDocument;
  shown: boolean;
}

interface OwnedConfirmation extends OwnedEditor {
  readonly uri: vscode.Uri;
  readonly text: string;
}

export function registerExtensionUiDialogs(context: vscode.ExtensionContext, runtime: PiRuntimeManager): void {
  const dialogs = new ExtensionUiDialogs(runtime);
  context.subscriptions.push(
    dialogs,
    vscode.commands.registerCommand(extensionEditorSubmitCommand, () => dialogs.submit()),
    vscode.commands.registerCommand(extensionEditorCancelCommand, () => dialogs.cancel()),
    vscode.commands.registerCommand(extensionDialogAllowCommand, () => dialogs.confirm(true)),
    vscode.commands.registerCommand(extensionDialogBlockCommand, () => dialogs.confirm(false)),
  );
}

/** Native dialogs are request-owned, not part of transcript or webview state. */
export class ExtensionUiDialogs implements vscode.Disposable {
  private readonly subscriptions: vscode.Disposable[];
  private readonly requests = new Set<ExtensionDialogRequest>();
  private editor: OwnedEditor | undefined;
  private readonly confirmations = new Map<string, OwnedConfirmation>();
  private readonly confirmationChanges = new vscode.EventEmitter<vscode.Uri>();
  private disposed = false;
  private readonly submitStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  private readonly cancelStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);

  private readonly allowStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
  private readonly blockStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);

  public constructor(private readonly runtime: PiRuntimeManager) {
    this.submitStatus.text = "$(check) Submit to Pi";
    this.submitStatus.command = extensionEditorSubmitCommand;
    this.submitStatus.tooltip = "Submit the full Pi extension editor text (Ctrl/Cmd+Enter). Save does not submit.";
    this.cancelStatus.text = "$(close) Cancel Pi Editor";
    this.cancelStatus.command = extensionEditorCancelCommand;
    this.allowStatus.text = "$(check) Allow Pi Action";
    this.allowStatus.command = extensionDialogAllowCommand;
    this.blockStatus.text = "$(close) Block Pi Action";
    this.blockStatus.command = extensionDialogBlockCommand;
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider("pi-extension-confirmation", {
        onDidChange: this.confirmationChanges.event,
        provideTextDocumentContent: (uri) =>
          this.confirmations.get(uri.toString())?.text ?? "This Pi confirmation expired.",
      }),
      runtime.onEvent((event) => {
        if (event.type !== "extension_ui_request") return;
        const request = runtime.claimExtensionUiRequest(event);
        if (!request) return;
        this.requests.add(request);
        request.onDidEnd(() => this.requests.delete(request));
        void this.show(event, request).catch(() => {
          try {
            request.respond({ cancelled: true });
          } catch {
            /* Never retry a failed response write. */
          }
          void vscode.window.showErrorMessage("The Pi extension dialog failed. No dialog text was retried.");
        });
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.tabGroups.onDidChangeTabs(() => {
        const owned = this.editor;
        if (owned?.shown && owned.document && !this.tabs(owned.document).length)
          owned.request.respond({ cancelled: true });
        for (const review of this.confirmations.values()) {
          if (review.shown && review.document && !this.tabs(review.document).length)
            review.request.respond({ confirmed: false });
        }
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        if (this.editor?.document === document) this.editor.request.respond({ cancelled: true });
        for (const review of this.confirmations.values()) {
          if (review.document === document) review.request.respond({ confirmed: false });
        }
      }),
    ];
  }

  private async show(event: PiRpcEvent, request: ExtensionDialogRequest): Promise<void> {
    if (!vscode.workspace.isTrusted || this.disposed) {
      request.respond({ cancelled: true });
      return;
    }
    const title = typeof event.title === "string" ? event.title.slice(0, 200) : "Pi";
    if (event.method === "editor") {
      await this.openEditor(event, request, title);
      return;
    }
    const cancellation = new vscode.CancellationTokenSource();
    const ended = request.onDidEnd(() => cancellation.cancel());
    try {
      if (event.method === "select") {
        const options = event.options;
        if (
          !Array.isArray(options) ||
          options.length > 100 ||
          options.some((option) => typeof option !== "string" || option.length > maxDialogTextCharacters) ||
          options.reduce((sum, option) => sum + option.length, 0) > maxDialogTextCharacters
        ) {
          request.respond({ cancelled: true });
          return;
        }
        const value = await vscode.window.showQuickPick(
          options as string[],
          { title, ignoreFocusOut: true },
          cancellation.token,
        );
        request.respond(value === undefined ? { cancelled: true } : { value });
      } else if (event.method === "confirm") {
        if (typeof event.message === "string" && event.message.length > maxDialogTextCharacters) {
          request.respond({ cancelled: true });
          return;
        }
        const message = typeof event.message === "string" ? event.message : title;
        if (event.timeout !== undefined) {
          // Timed modals have no cancellation API. Full review uses a read-only, memory-only document.
          const choice = await vscode.window.showQuickPick(
            [
              { label: "Block" },
              { label: "Review Full Message", detail: "Open the full read-only message before Allow is available." },
            ],
            { title, placeHolder: "Block, or review the full message before approval.", ignoreFocusOut: true },
            cancellation.token,
          );
          if (!request.isActive) return;
          if (choice?.label === "Review Full Message") await this.reviewConfirmation(request, title, message);
          else request.respond({ confirmed: false });
        } else {
          // Preserve full, untimed permission modals used by the packaged built-in tool gate.
          const choice = await vscode.window.showWarningMessage(message, { modal: true }, "Allow");
          request.respond({ confirmed: choice === "Allow" });
        }
      } else if (event.method === "input") {
        if (typeof event.prefill === "string" && event.prefill.length > maxDialogTextCharacters) {
          request.respond({ cancelled: true });
          return;
        }
        const value = await vscode.window.showInputBox(
          {
            title,
            prompt: typeof event.placeholder === "string" ? event.placeholder.slice(0, 1000) : undefined,
            value: typeof event.prefill === "string" ? event.prefill : undefined,
            ignoreFocusOut: true,
          },
          cancellation.token,
        );
        request.respond(
          value === undefined || value.length > maxDialogTextCharacters ? { cancelled: true } : { value },
        );
      }
    } finally {
      ended.dispose();
      cancellation.dispose();
    }
  }

  private async reviewConfirmation(request: ExtensionDialogRequest, title: string, message: string): Promise<void> {
    const uri = vscode.Uri.from({ scheme: "pi-extension-confirmation", path: `/${randomUUID()}/Pi Confirmation.txt` });
    const review: OwnedConfirmation = {
      request,
      uri,
      shown: false,
      text: `${title}\n\n${message}\n\nUse Pi: Allow Reviewed Extension Action or Pi: Block Reviewed Extension Action. Closing this document blocks the action.`,
    };
    this.confirmations.set(uri.toString(), review);
    request.onDidEnd(() => {
      this.confirmations.delete(uri.toString());
      this.confirmationChanges.fire(uri);
      this.updateContext();
      if (review.document) void this.close(review.document);
    });
    const document = await vscode.workspace.openTextDocument(uri);
    review.document = document;
    if (!request.isActive) {
      await this.close(document);
      return;
    }
    await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
    if (!request.isActive) {
      await this.close(document);
      return;
    }
    review.shown = true;
    this.updateContext();
  }

  public confirm(confirmed: boolean): void {
    this.activeConfirmation()?.request.respond({ confirmed });
  }

  private activeConfirmation(): OwnedConfirmation | undefined {
    const document = vscode.window.activeTextEditor?.document;
    const review = document ? this.confirmations.get(document.uri.toString()) : undefined;
    return !this.disposed &&
      vscode.workspace.isTrusted &&
      review?.shown &&
      review.request.isActive &&
      !document?.isClosed &&
      review.document === document
      ? review
      : undefined;
  }

  private async openEditor(event: PiRpcEvent, request: ExtensionDialogRequest, title: string): Promise<void> {
    const prefill = event.prefill === undefined ? "" : event.prefill;
    if (this.editor || typeof prefill !== "string" || prefill.length > maxDialogTextCharacters) {
      request.respond({ cancelled: true });
      void vscode.window.showWarningMessage(
        "Pi editor unavailable: only one editor and 100,000 text characters are allowed.",
      );
      return;
    }
    const owned: OwnedEditor = { request, shown: false };
    this.editor = owned;
    const cancellation = new vscode.CancellationTokenSource();
    const ended = request.onDidEnd(() => {
      cancellation.cancel();
      cancellation.dispose();
      if (this.editor === owned) this.editor = undefined;
      this.updateContext();
      if (owned.document) void this.close(owned.document);
    });
    try {
      const choice = await vscode.window.showQuickPick(
        [
          {
            label: "Open Non-Secret Editor",
            detail:
              "VS Code can retain untitled text in hot-exit backups. Do not enter credentials. Submit sends all text to the requesting Pi extension. Save does not submit. Choose Don't Save on close to discard text.",
          },
        ],
        {
          title: `Pi extension editor: ${title}`,
          placeHolder: "VS Code may keep hot-exit backups. Do not enter credentials. Escape cancels.",
          ignoreFocusOut: true,
        },
        cancellation.token,
      );
      if (!request.isActive) return;
      if (choice?.label !== "Open Non-Secret Editor" || !vscode.workspace.isTrusted || this.disposed) {
        request.respond({ cancelled: true });
        return;
      }
      const document = await vscode.workspace.openTextDocument({ language: "plaintext", content: prefill });
      owned.document = document;
      if (!request.isActive) {
        await this.close(document);
        return;
      }
      // VS Code text models normalize mixed line endings; use the document's full text at Submit.
      await vscode.window.showTextDocument(document, { preview: false, preserveFocus: false });
      if (!request.isActive) {
        await this.close(document);
        return;
      }
      owned.shown = true;
      this.updateContext();
    } finally {
      if (!request.isActive) ended.dispose();
    }
  }

  public submit(): void {
    const owned = this.activeEditor();
    if (!owned?.document) return;
    const version = owned.document.version;
    const value = owned.document.getText();
    if (owned.document.version !== version || value.length > maxDialogTextCharacters) {
      owned.request.respond({ cancelled: true });
      void vscode.window.showWarningMessage(
        "Pi editor text exceeds the 100,000-character limit. No partial value was sent.",
      );
      return;
    }
    owned.request.respond({ value });
  }

  public cancel(): void {
    this.activeEditor()?.request.respond({ cancelled: true });
  }

  private activeEditor(): OwnedEditor | undefined {
    const owned = this.editor;
    return !this.disposed &&
      vscode.workspace.isTrusted &&
      owned?.shown &&
      owned.request.isActive &&
      owned.document &&
      !owned.document.isClosed &&
      vscode.window.activeTextEditor?.document === owned.document
      ? owned
      : undefined;
  }

  private updateContext(): void {
    const active = Boolean(this.activeEditor());
    void vscode.commands.executeCommand("setContext", "pi.extensionEditorActive", active);
    const confirmation = Boolean(this.activeConfirmation());
    void vscode.commands.executeCommand("setContext", "pi.extensionConfirmationActive", confirmation);
    if (confirmation) {
      this.allowStatus.show();
      this.blockStatus.show();
    } else {
      this.allowStatus.hide();
      this.blockStatus.hide();
    }
    if (active) {
      this.submitStatus.show();
      this.cancelStatus.show();
    } else {
      this.submitStatus.hide();
      this.cancelStatus.hide();
    }
  }

  private tabs(document: vscode.TextDocument): vscode.Tab[] {
    return vscode.window.tabGroups.all
      .flatMap((group) => group.tabs)
      .filter(
        (tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === document.uri.toString(),
      );
  }

  private async close(document: vscode.TextDocument): Promise<void> {
    // Close only owned tabs. The stable API can ask Save / Don't Save / Cancel for dirty text.
    // Never focus an arbitrary editor or run a global revert command to suppress that prompt.
    try {
      await vscode.window.tabGroups.close(this.tabs(document), true);
    } catch {
      /* Shutdown may already have disposed the tabs. No text is persisted by this controller. */
    }
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const request of this.requests) {
      try {
        request.respond({ cancelled: true });
      } catch {
        request.end();
      }
    }
    for (const subscription of this.subscriptions) subscription.dispose();
    this.submitStatus.dispose();
    this.cancelStatus.dispose();
    this.allowStatus.dispose();
    this.blockStatus.dispose();
    this.confirmationChanges.dispose();
    void vscode.commands.executeCommand("setContext", "pi.extensionConfirmationActive", false);
    void vscode.commands.executeCommand("setContext", "pi.extensionEditorActive", false);
  }
}
