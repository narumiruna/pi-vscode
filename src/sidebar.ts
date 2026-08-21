import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { PiInvocationError } from "./piClient";
import {
  buildChatPrompt,
  limitChatHistory,
  limitReferenceContent,
  type ChatHistoryEntry,
  type ChatReferenceContext,
} from "./prompts";
import { limitSidebarMessages, type SidebarMessage } from "./sidebarState";
import { invokePiWithCancellation } from "./vscodePi";

const viewId = "piCodingAgent.chatView";
const storageKey = "piCodingAgent.sidebar.messages.v1";
const maxMessages = 50;
const maxStoredCharacters = 100_000;
const maxPromptHistoryCharacters = 40_000;
const maxPromptHistoryMessages = 12;
const maxInputCharacters = 100_000;
const maxAttachedCharacters = 200_000;

interface AttachedSelection extends ChatReferenceContext {
  readonly uri: vscode.Uri;
}

export function registerPiSidebar(context: vscode.ExtensionContext): void {
  const provider = new PiChatViewProvider(context);
  context.subscriptions.push(
    provider,
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("piCodingAgent.openChat", async () => {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    }),
  );
}

class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private messages: SidebarMessage[];
  private attachment: AttachedSelection | undefined;
  private requestCancellation: vscode.CancellationTokenSource | undefined;

  public constructor(private readonly context: vscode.ExtensionContext) {
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey));
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = getWebviewHtml(webviewView.webview);

    const messageListener = webviewView.webview.onDidReceiveMessage(message => {
      void this.handleMessage(message);
    });
    const viewListener = webviewView.onDidDispose(() => {
      messageListener.dispose();
      viewListener.dispose();
      if (this.view === webviewView) {
        this.view = undefined;
      }
    });
    this.disposables.push(messageListener, viewListener);
    this.postState();
  }

  public dispose(): void {
    this.requestCancellation?.cancel();
    this.requestCancellation?.dispose();
    this.requestCancellation = undefined;
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      return;
    }

    switch (message.type) {
      case "ready":
        this.postState();
        break;
      case "send":
        await this.send(message.text);
        break;
      case "cancel":
        this.requestCancellation?.cancel();
        break;
      case "clear":
        await this.clear();
        break;
      case "attachSelection":
        this.attachSelection();
        break;
    }
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || this.requestCancellation) {
      if (this.requestCancellation) {
        this.postNotice("Wait for the current Pi response or cancel it first.", "warning");
      }
      return;
    }
    if (text.length > maxInputCharacters) {
      this.postNotice(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`, "error");
      return;
    }

    const priorHistory = limitChatHistory(
      this.messages.map<ChatHistoryEntry>(message => ({
        role: message.role,
        content: message.content,
      })),
      maxPromptHistoryCharacters,
      maxPromptHistoryMessages,
    );
    const attachment = this.attachment;
    this.attachment = undefined;
    this.messages = limitSidebarMessages(
      [
        ...this.messages,
        {
          id: randomUUID(),
          role: "user",
          content: text,
          contextLabel: attachment?.label,
        },
      ],
      maxMessages,
      maxStoredCharacters,
    );
    await this.persistMessages();

    const cancellation = new vscode.CancellationTokenSource();
    this.requestCancellation = cancellation;
    this.postState();

    try {
      const prompt = buildChatPrompt(text, undefined, priorHistory, attachment ? [attachment] : []);
      const response = await invokePiWithCancellation(prompt, cancellation.token, attachment?.uri);
      this.messages = limitSidebarMessages(
        [
          ...this.messages,
          {
            id: randomUUID(),
            role: "assistant",
            content: response.trim(),
          },
        ],
        maxMessages,
        maxStoredCharacters,
      );
      await this.persistMessages();
    } catch (error) {
      if (error instanceof PiInvocationError && error.kind === "aborted") {
        this.postNotice("Pi request cancelled.", "info");
      } else {
        this.postNotice(formatError(error), "error");
      }
    } finally {
      cancellation.dispose();
      if (this.requestCancellation === cancellation) {
        this.requestCancellation = undefined;
      }
      this.postState();
    }
  }

  private async clear(): Promise<void> {
    this.requestCancellation?.cancel();
    this.attachment = undefined;
    this.messages = [];
    await this.persistMessages();
    this.postState();
  }

  private attachSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.postNotice("Select code in an editor before attaching it.", "warning");
      return;
    }

    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
    const file = workspaceFolder
      ? path.relative(workspaceFolder.uri.fsPath, editor.document.uri.fsPath)
      : editor.document.uri.scheme === "file"
        ? path.basename(editor.document.uri.fsPath)
        : editor.document.uri.toString();
    const selectedText = editor.document.getText(range);
    const truncated = selectedText.length > maxAttachedCharacters;
    this.attachment = {
      uri: editor.document.uri,
      label: `${file}:${range.start.line + 1}-${range.end.line + 1}${truncated ? " (truncated)" : ""}`,
      content: limitReferenceContent(selectedText, maxAttachedCharacters, maxAttachedCharacters),
    };
    if (truncated) {
      this.postNotice(`The attached selection was limited to ${maxAttachedCharacters.toLocaleString()} characters.`, "warning");
    }
    this.postState();
  }

  private async persistMessages(): Promise<void> {
    try {
      await this.context.workspaceState.update(storageKey, this.messages);
    } catch {
      this.postNotice("The conversation could not be saved in workspace storage.", "warning");
    }
  }

  private postState(): void {
    void this.view?.webview.postMessage({
      type: "state",
      messages: this.messages,
      busy: this.requestCancellation !== undefined,
      attachment: this.attachment ? { label: this.attachment.label } : undefined,
    });
  }

  private postNotice(message: string, level: "info" | "warning" | "error"): void {
    void this.view?.webview.postMessage({ type: "notice", message, level });
  }
}

type WebviewMessage =
  | { readonly type: "ready" | "cancel" | "clear" | "attachSelection" }
  | { readonly type: "send"; readonly text: string };

function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!value || typeof value !== "object" || !("type" in value)) {
    return false;
  }
  const type = value.type;
  if (type === "send") {
    return "text" in value && typeof value.text === "string";
  }
  return type === "ready" || type === "cancel" || type === "clear" || type === "attachSelection";
}

function restoreMessages(value: unknown): SidebarMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages = value.filter((message): message is SidebarMessage => {
    if (!message || typeof message !== "object") {
      return false;
    }
    return (
      "id" in message &&
      typeof message.id === "string" &&
      "role" in message &&
      (message.role === "user" || message.role === "assistant") &&
      "content" in message &&
      typeof message.content === "string" &&
      (!("contextLabel" in message) || message.contextLabel === undefined || typeof message.contextLabel === "string")
    );
  });
  return limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
}

function formatError(error: unknown): string {
  if (error instanceof PiInvocationError) {
    const details = error.details?.trim();
    return details ? `${error.message} ${details.slice(0, 1000)}` : error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = randomBytes(16).toString("base64url");
  const csp = [
    "default-src 'none'",
    `style-src 'nonce-${nonce}'`,
    `script-src 'nonce-${nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body { margin: 0; color: var(--vscode-foreground); background: var(--vscode-sideBar-background); font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); font-weight: var(--vscode-font-weight, normal); line-height: 1.45; }
    #app { height: 100vh; display: grid; grid-template-rows: auto 1fr auto auto auto; }
    .toolbar { display: flex; justify-content: flex-end; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBar-border, transparent); }
    button { border: 1px solid transparent; border-radius: 2px; padding: 4px 8px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-button-secondaryBackground); }
    button:disabled { cursor: default; opacity: .55; }
    #messages { overflow-y: auto; padding: 10px; }
    .empty { margin: 20vh 18px 0; text-align: center; color: var(--vscode-descriptionForeground); }
    .message { margin: 0 0 12px; }
    .role { margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: .85em; font-weight: 600; text-transform: uppercase; }
    .content { padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .user .content { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .assistant .content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-sideBar-border, transparent); }
    .context { display: inline-block; max-width: 100%; margin-top: 5px; padding: 2px 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #attachment { display: none; margin: 0 8px 6px; padding: 5px 8px; border-radius: 3px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #composer { padding: 8px; border-top: 1px solid var(--vscode-sideBar-border, transparent); }
    textarea { display: block; width: 100%; min-height: 72px; max-height: 220px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
    textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .actions { display: flex; justify-content: space-between; gap: 6px; margin-top: 7px; }
    .right-actions { display: flex; gap: 6px; }
    #notice { min-height: 20px; padding: 0 8px 5px; color: var(--vscode-descriptionForeground); font-size: .85em; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
  </style>
</head>
<body>
  <main id="app">
    <div class="toolbar">
      <button id="clear" class="secondary" type="button" title="Start a new conversation">New chat</button>
    </div>
    <section id="messages" aria-live="polite"><div class="empty">Ask Pi about your code or attach the current editor selection.</div></section>
    <div id="attachment" title="Attached to the next message"></div>
    <section id="composer">
      <label for="input" class="role">Message Pi</label>
      <textarea id="input" maxlength="${maxInputCharacters}" placeholder="Ask Pi…" aria-label="Message Pi"></textarea>
      <div class="actions">
        <button id="attach" class="secondary" type="button" title="Attach the current editor selection">Attach selection</button>
        <div class="right-actions">
          <button id="cancel" class="secondary" type="button" hidden>Cancel</button>
          <button id="send" type="button">Send</button>
        </div>
      </div>
    </section>
    <div id="notice" role="status" aria-live="polite"></div>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const messagesElement = document.getElementById('messages');
    const input = document.getElementById('input');
    const send = document.getElementById('send');
    const cancel = document.getElementById('cancel');
    const attach = document.getElementById('attach');
    const clear = document.getElementById('clear');
    const attachment = document.getElementById('attachment');
    const notice = document.getElementById('notice');
    let busy = false;

    function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      vscode.postMessage({ type: 'send', text });
      input.value = '';
      notice.textContent = '';
    }

    function render(state) {
      const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
      messagesElement.replaceChildren();
      if (state.messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Ask Pi about your code or attach the current editor selection.';
        messagesElement.appendChild(empty);
      } else {
        for (const message of state.messages) {
          const wrapper = document.createElement('article');
          wrapper.className = 'message ' + message.role;
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = message.role === 'user' ? 'You' : 'Pi';
          const content = document.createElement('div');
          content.className = 'content';
          content.textContent = message.content;
          wrapper.append(role, content);
          if (message.contextLabel) {
            const context = document.createElement('div');
            context.className = 'context';
            context.textContent = message.contextLabel;
            context.title = message.contextLabel;
            wrapper.appendChild(context);
          }
          messagesElement.appendChild(wrapper);
        }
      }
      busy = state.busy;
      send.disabled = busy;
      attach.disabled = busy;
      clear.disabled = busy;
      cancel.hidden = !busy;
      send.textContent = busy ? 'Waiting…' : 'Send';
      if (state.attachment) {
        attachment.style.display = 'block';
        attachment.textContent = 'Attached: ' + state.attachment.label;
      } else {
        attachment.style.display = 'none';
        attachment.textContent = '';
      }
      if (nearBottom || busy) messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') render(message);
      if (message.type === 'notice') {
        notice.textContent = message.message;
        notice.className = message.level;
      }
    });
    send.addEventListener('click', submit);
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    attach.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));
    clear.addEventListener('click', () => vscode.postMessage({ type: 'clear' }));
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`;
}
