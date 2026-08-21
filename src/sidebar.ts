import { randomBytes, randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { buildAgentPrompt, limitReferenceContent, parseAgentPrompt, type ChatReferenceContext } from "./prompts";
import { PiRuntimeManager } from "./piRuntime";
import type { PiRpcEvent } from "./piRpcClient";
import type { PiAgentMode } from "./runtimeProfiles";
import { limitSidebarMessages, type SidebarMessage } from "./sidebarState";

const viewId = "piCodingAgent.chatView";
const storageKey = "piCodingAgent.sidebar.messages.v1";
const maxMessages = 100;
const maxStoredCharacters = 250_000;
const maxInputCharacters = 100_000;
const maxAttachedCharacters = 200_000;
const maxTotalContextCharacters = 400_000;
const maxAttachments = 8;
const maxToolActivities = 30;
const maxToolOutputCharacters = 8_000;

interface AttachedContext extends ChatReferenceContext {
  readonly uri?: vscode.Uri;
}

interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "success" | "error";
  readonly input: string;
  readonly output?: string;
}

export function registerPiSidebar(context: vscode.ExtensionContext): void {
  const runtime = new PiRuntimeManager(context);
  const provider = new PiChatViewProvider(context, runtime);
  context.subscriptions.push(
    runtime,
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
  private tools: ToolActivity[] = [];
  private attachments: AttachedContext[] = [];
  private status = "Ready";
  private streamingAssistantId: string | undefined;
  private renderTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: PiRuntimeManager,
  ) {
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey));
    this.disposables.push(
      runtime.onEvent(event => this.handleRuntimeEvent(event)),
      runtime.onDidChangeState(() => this.scheduleState()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = getWebviewHtml();

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
    void this.initializeRuntime();
  }

  public dispose(): void {
    if (this.renderTimer) {
      clearTimeout(this.renderTimer);
      this.renderTimer = undefined;
    }
    for (const disposable of this.disposables.splice(0)) {
      disposable.dispose();
    }
  }

  private async initializeRuntime(): Promise<void> {
    this.status = "Connecting to Pi…";
    this.postState();
    try {
      await this.runtime.ensureStarted(vscode.window.activeTextEditor?.document.uri);
      await this.syncMessagesFromPi();
      this.status = "Ready";
    } catch (error) {
      this.status = "Disconnected";
      this.postNotice(formatError(error), "error");
    }
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message)) {
      return;
    }

    try {
      switch (message.type) {
        case "ready":
          this.postState();
          break;
        case "send":
          await this.send(message.text);
          break;
        case "cancel":
          await this.runtime.abort();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "attachSelection":
          this.attachSelection();
          break;
        case "attachFile":
          await this.attachFile();
          break;
        case "attachCurrentFile":
          await this.attachCurrentFile();
          break;
        case "attachDiagnostics":
          this.attachDiagnostics();
          break;
        case "clearAttachments":
          this.attachments = [];
          this.postState();
          break;
        case "setMode":
          await this.setMode(message.mode);
          break;
        case "setModel":
          await this.runtime.setModel(message.provider, message.modelId);
          break;
        case "setThinking":
          await this.runtime.setThinkingLevel(message.level);
          break;
        case "compact":
          await this.compact();
          break;
        case "nameSession":
          await this.nameSession();
          break;
        case "resumeSession":
          await this.resumeSession();
          break;
        case "openTerminal":
          await this.runtime.openInTerminal();
          break;
      }
    } catch (error) {
      this.postNotice(formatError(error), "error");
      this.postState();
    }
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text || this.runtime.currentState.busy) {
      if (this.runtime.currentState.busy) {
        this.postNotice("Pi is already working. Cancel the active request before sending another message.", "warning");
      }
      return;
    }
    if (text.length > maxInputCharacters) {
      this.postNotice(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`, "error");
      return;
    }

    const attachments = this.attachments;
    this.attachments = [];
    this.messages = limitSidebarMessages(
      [
        ...this.messages,
        {
          id: randomUUID(),
          role: "user",
          content: text,
          contextLabel: attachments.map(context => context.label).join(", ") || undefined,
        },
      ],
      maxMessages,
      maxStoredCharacters,
    );
    this.tools = [];
    this.streamingAssistantId = undefined;
    this.status = "Sending to Pi…";
    await this.persistMessages();
    this.postState();

    try {
      await this.runtime.prompt(buildAgentPrompt(text, attachments), attachments.find(context => context.uri)?.uri);
      await this.syncMessagesFromPi();
      this.status = "Ready";
    } catch (error) {
      this.status = "Request failed";
      this.postNotice(formatError(error), "error");
    }
    this.postState();
  }

  private async newSession(): Promise<void> {
    if (this.runtime.currentState.busy) {
      this.postNotice("Cancel the active request before starting a new session.", "warning");
      return;
    }
    await this.runtime.newSession();
    this.messages = [];
    this.tools = [];
    this.attachments = [];
    await this.persistMessages();
    this.status = "New Pi session";
    this.postState();
  }

  private async setMode(mode: PiAgentMode): Promise<void> {
    if (mode === "agent") {
      const choice = await vscode.window.showWarningMessage(
        "Agent mode allows Pi to edit files and run shell commands with your user permissions.",
        { modal: true },
        "Enable Agent Mode",
      );
      if (choice !== "Enable Agent Mode") {
        this.postState();
        return;
      }
    }
    await this.runtime.setMode(mode);
    await this.syncMessagesFromPi();
    this.status = `${modeLabel(mode)} mode`;
    this.postState();
  }

  private async compact(): Promise<void> {
    if (this.runtime.currentState.busy) {
      this.postNotice("Cancel the active request before compacting the session.", "warning");
      return;
    }
    this.status = "Compacting context…";
    this.postState();
    await this.runtime.compact();
    await this.syncMessagesFromPi();
    this.status = "Context compacted";
    this.postState();
  }

  private async nameSession(): Promise<void> {
    const name = await vscode.window.showInputBox({
      title: "Name Pi Session",
      value: this.runtime.currentState.sessionName ?? "",
      prompt: "Set a name for the current persistent Pi session.",
      ignoreFocusOut: true,
    });
    if (name === undefined) {
      return;
    }
    await this.runtime.setSessionName(name.trim());
  }

  private async resumeSession(): Promise<void> {
    if (this.runtime.currentState.busy) {
      this.postNotice("Cancel the active request before switching sessions.", "warning");
      return;
    }
    const selection = await vscode.window.showOpenDialog({
      title: "Resume Pi Session",
      defaultUri: vscode.Uri.file(path.join(homedir(), ".pi", "agent", "sessions")),
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Pi sessions": ["jsonl"] },
      openLabel: "Resume Session",
    });
    const session = selection?.[0];
    if (!session) {
      return;
    }
    await this.runtime.switchSession(session.fsPath);
    await this.syncMessagesFromPi();
    this.tools = [];
    this.status = "Pi session resumed";
    this.postState();
  }

  private attachSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      this.postNotice("Select code in an editor before attaching it.", "warning");
      return;
    }
    const range = new vscode.Range(editor.selection.start, editor.selection.end);
    this.addAttachment({
      uri: editor.document.uri,
      label: `${relativeDocumentPath(editor.document)}:${range.start.line + 1}-${range.end.line + 1}`,
      content: editor.document.getText(range),
    });
  }

  private async attachCurrentFile(): Promise<void> {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      this.postNotice("Open a text editor before attaching the current file.", "warning");
      return;
    }
    this.addAttachment({
      uri: document.uri,
      label: relativeDocumentPath(document),
      content: document.getText(),
    });
  }

  private async attachFile(): Promise<void> {
    const selected = await vscode.window.showOpenDialog({
      title: "Attach Files to Pi",
      defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: true,
      openLabel: "Attach",
    });
    for (const uri of selected ?? []) {
      if (this.attachments.length >= maxAttachments) {
        this.postNotice(`A maximum of ${maxAttachments} context items can be attached.`, "warning");
        break;
      }
      try {
        const document = await vscode.workspace.openTextDocument(uri);
        this.addAttachment({
          uri,
          label: relativeDocumentPath(document),
          content: document.getText(),
        });
      } catch (error) {
        this.postNotice(`Could not attach ${uri.fsPath}: ${formatError(error)}`, "warning");
      }
    }
  }

  private attachDiagnostics(): void {
    const document = vscode.window.activeTextEditor?.document;
    if (!document) {
      this.postNotice("Open a text editor before attaching diagnostics.", "warning");
      return;
    }
    const diagnostics = vscode.languages.getDiagnostics(document.uri);
    if (diagnostics.length === 0) {
      this.postNotice("The current file has no diagnostics.", "info");
      return;
    }
    const content = diagnostics
      .map(diagnostic => {
        const severity = ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Diagnostic";
        const source = diagnostic.source ? ` (${diagnostic.source})` : "";
        return `${severity}${source} at ${diagnostic.range.start.line + 1}:${diagnostic.range.start.character + 1}: ${diagnostic.message}`;
      })
      .join("\n");
    this.addAttachment({
      uri: document.uri,
      label: `Diagnostics: ${relativeDocumentPath(document)}`,
      content,
    });
  }

  private addAttachment(context: AttachedContext): void {
    const existing = this.attachments.filter(item => item.label !== context.label);
    if (existing.length >= maxAttachments) {
      this.postNotice(`A maximum of ${maxAttachments} context items can be attached.`, "warning");
      return;
    }
    const usedCharacters = existing.reduce((total, item) => total + item.content.length, 0);
    const remainingCharacters = maxTotalContextCharacters - usedCharacters;
    if (remainingCharacters <= 0) {
      this.postNotice("The context attachment limit has been reached.", "warning");
      return;
    }
    const content = limitReferenceContent(context.content, remainingCharacters, maxAttachedCharacters);
    const truncated = content.length < context.content.length;
    this.attachments = [...existing, {
      ...context,
      content,
    }];
    if (truncated) {
      this.postNotice("The attached context was truncated to fit the context limit.", "warning");
    }
    this.postState();
  }

  private handleRuntimeEvent(event: PiRpcEvent): void {
    if (event.type === "agent_start") {
      this.status = "Pi is working…";
      this.tools = [];
    } else if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === "assistant") {
        this.startStreamingAssistant();
      }
    } else if (event.type === "message_update") {
      const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
      if (update?.type === "text_delta" && typeof update.delta === "string") {
        this.appendAssistantText(update.delta);
      } else if (update?.type === "thinking_delta") {
        this.status = "Pi is thinking…";
      }
    } else if (event.type === "message_end") {
      this.streamingAssistantId = undefined;
    } else if (event.type === "tool_execution_start") {
      this.upsertTool({
        id: stringValue(event.toolCallId) ?? randomUUID(),
        name: stringValue(event.toolName) ?? "tool",
        status: "running",
        input: safeJson(event.args),
      });
      this.status = `Running ${stringValue(event.toolName) ?? "tool"}…`;
    } else if (event.type === "tool_execution_update") {
      const id = stringValue(event.toolCallId);
      if (id) {
        this.updateTool(id, { output: extractToolText(event.partialResult) });
      }
    } else if (event.type === "tool_execution_end") {
      const id = stringValue(event.toolCallId);
      if (id) {
        this.updateTool(id, {
          status: event.isError ? "error" : "success",
          output: extractToolText(event.result),
        });
      }
    } else if (event.type === "compaction_start") {
      this.status = "Compacting Pi context…";
    } else if (event.type === "auto_retry_start") {
      this.status = "Retrying Pi request…";
    } else if (event.type === "agent_settled") {
      this.status = "Ready";
      this.streamingAssistantId = undefined;
      void this.syncMessagesFromPi();
    } else if (event.type === "runtime_warning" || event.type === "protocol_error") {
      this.postNotice(stringValue(event.message) ?? "Pi runtime warning.", "warning");
    } else if (event.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(event).catch(error => {
        this.postNotice(formatError(error), "error");
      });
    }
    this.scheduleState();
  }

  private async handleExtensionUiRequest(event: PiRpcEvent): Promise<void> {
    const id = stringValue(event.id);
    const method = stringValue(event.method);
    if (!id || !method) {
      return;
    }

    if (method === "select") {
      const options = Array.isArray(event.options) ? event.options.filter(value => typeof value === "string") : [];
      const value = await vscode.window.showQuickPick(options, {
        title: stringValue(event.title) ?? "Pi",
        ignoreFocusOut: true,
      });
      this.runtime.sendExtensionUiResponse(id, value === undefined ? { cancelled: true } : { value });
    } else if (method === "confirm") {
      const choice = await vscode.window.showWarningMessage(
        stringValue(event.message) ?? stringValue(event.title) ?? "Confirm Pi action?",
        { modal: true },
        "Allow",
      );
      this.runtime.sendExtensionUiResponse(id, { confirmed: choice === "Allow" });
    } else if (method === "input" || method === "editor") {
      const value = await vscode.window.showInputBox({
        title: stringValue(event.title) ?? "Pi Input",
        prompt: stringValue(event.placeholder),
        value: stringValue(event.prefill),
        ignoreFocusOut: true,
      });
      this.runtime.sendExtensionUiResponse(id, value === undefined ? { cancelled: true } : { value });
    } else if (method === "notify") {
      const message = stringValue(event.message) ?? "Pi notification";
      const notifyType = stringValue(event.notifyType);
      if (notifyType === "error") {
        await vscode.window.showErrorMessage(message);
      } else if (notifyType === "warning") {
        await vscode.window.showWarningMessage(message);
      } else {
        await vscode.window.showInformationMessage(message);
      }
    } else if (method === "setTitle") {
      if (this.view) {
        this.view.title = stringValue(event.title) ?? "Chat";
      }
    } else if (method === "set_editor_text") {
      this.postMessage({ type: "setInput", text: stringValue(event.text) ?? "" });
    }
  }

  private startStreamingAssistant(): void {
    const id = randomUUID();
    this.streamingAssistantId = id;
    this.messages = limitSidebarMessages(
      [...this.messages, { id, role: "assistant", content: "" }],
      maxMessages,
      maxStoredCharacters,
    );
  }

  private appendAssistantText(delta: string): void {
    if (!this.streamingAssistantId) {
      this.startStreamingAssistant();
    }
    const id = this.streamingAssistantId;
    this.messages = this.messages.map(message =>
      message.id === id ? { ...message, content: message.content + delta } : message,
    );
    this.scheduleState();
  }

  private upsertTool(activity: ToolActivity): void {
    this.tools = [...this.tools.filter(tool => tool.id !== activity.id), activity].slice(-maxToolActivities);
  }

  private updateTool(id: string, changes: Partial<ToolActivity>): void {
    this.tools = this.tools.map(tool => (tool.id === id ? { ...tool, ...changes } : tool));
  }

  private async syncMessagesFromPi(): Promise<void> {
    if (!this.runtime.currentState.connected || this.runtime.currentState.busy) {
      return;
    }
    const messages = convertPiMessages(await this.runtime.getMessages());
    if (messages.length > 0 || this.runtime.currentState.sessionId) {
      this.messages = limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
      await this.persistMessages();
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

  private scheduleState(): void {
    if (this.renderTimer) {
      return;
    }
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.postState();
    }, 33);
  }

  private postState(): void {
    this.postMessage({
      type: "state",
      messages: this.messages,
      tools: this.tools,
      status: this.status,
      attachments: this.attachments.map(context => ({ label: context.label })),
      runtime: this.runtime.currentState,
    });
  }

  private postNotice(message: string, level: "info" | "warning" | "error"): void {
    this.postMessage({ type: "notice", message, level });
  }

  private postMessage(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }
}

type WebviewMessage =
  | { readonly type: "ready" | "cancel" | "newSession" | "attachSelection" | "attachFile" | "attachCurrentFile" | "attachDiagnostics" | "clearAttachments" | "compact" | "nameSession" | "resumeSession" | "openTerminal" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "setMode"; readonly mode: PiAgentMode }
  | { readonly type: "setModel"; readonly provider: string; readonly modelId: string }
  | { readonly type: "setThinking"; readonly level: string };

function isWebviewMessage(value: unknown): value is WebviewMessage {
  if (!isRecord(value) || typeof value.type !== "string") {
    return false;
  }
  if (value.type === "send") {
    return typeof value.text === "string";
  }
  if (value.type === "setMode") {
    return value.mode === "ask" || value.mode === "edit" || value.mode === "plan" || value.mode === "agent";
  }
  if (value.type === "setModel") {
    return typeof value.provider === "string" && typeof value.modelId === "string";
  }
  if (value.type === "setThinking") {
    return typeof value.level === "string";
  }
  return [
    "ready",
    "cancel",
    "newSession",
    "attachSelection",
    "attachFile",
    "attachCurrentFile",
    "attachDiagnostics",
    "clearAttachments",
    "compact",
    "nameSession",
    "resumeSession",
    "openTerminal",
  ].includes(value.type);
}

function restoreMessages(value: unknown): SidebarMessage[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const messages = value.filter((message): message is SidebarMessage => {
    if (!isRecord(message)) {
      return false;
    }
    return (
      typeof message.id === "string" &&
      (message.role === "user" || message.role === "assistant") &&
      typeof message.content === "string" &&
      (message.contextLabel === undefined || typeof message.contextLabel === "string")
    );
  });
  return limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
}

function convertPiMessages(values: readonly unknown[]): SidebarMessage[] {
  const messages: SidebarMessage[] = [];
  for (const [index, value] of values.entries()) {
    if (!isRecord(value) || (value.role !== "user" && value.role !== "assistant")) {
      continue;
    }
    const text = extractMessageText(value.content);
    if (!text) {
      continue;
    }
    if (value.role === "user") {
      const parsed = parseAgentPrompt(text);
      messages.push({
        id: `pi-user-${String(value.timestamp ?? index)}-${index}`,
        role: "user",
        content: parsed.request,
        contextLabel: parsed.contextLabels.join(", ") || undefined,
      });
    } else {
      messages.push({
        id: `pi-assistant-${String(value.timestamp ?? index)}-${index}`,
        role: "assistant",
        content: text,
      });
    }
  }
  return messages;
}

function extractMessageText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
    .map(part => String(part.text))
    .join("\n");
}

function extractToolText(value: unknown): string {
  if (!isRecord(value)) {
    return safeJson(value).slice(-maxToolOutputCharacters);
  }
  const content = Array.isArray(value.content)
    ? value.content
        .filter(part => isRecord(part) && part.type === "text" && typeof part.text === "string")
        .map(part => String(part.text))
        .join("\n")
    : safeJson(value);
  return content.slice(-maxToolOutputCharacters);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, undefined, 2).slice(0, maxToolOutputCharacters);
  } catch {
    return String(value).slice(0, maxToolOutputCharacters);
  }
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function relativeDocumentPath(document: vscode.TextDocument): string {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (workspaceFolder) {
    return path.relative(workspaceFolder.uri.fsPath, document.uri.fsPath);
  }
  return document.uri.scheme === "file" ? path.basename(document.uri.fsPath) : document.uri.toString();
}

function modeLabel(mode: PiAgentMode): string {
  return mode.charAt(0).toUpperCase() + mode.slice(1);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getWebviewHtml(): string {
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
    #app { height: 100vh; display: grid; grid-template-rows: auto auto 1fr auto auto auto; }
    .toolbar { display: flex; flex-wrap: wrap; gap: 4px; padding: 6px 8px; border-bottom: 1px solid var(--vscode-sideBar-border, transparent); }
    button, select { min-height: 26px; border: 1px solid transparent; border-radius: 2px; padding: 3px 7px; color: var(--vscode-button-foreground); background: var(--vscode-button-background); cursor: pointer; font: inherit; }
    select { max-width: 150px; color: var(--vscode-dropdown-foreground); background: var(--vscode-dropdown-background); border-color: var(--vscode-dropdown-border, transparent); }
    button:hover { background: var(--vscode-button-hoverBackground); }
    button.secondary { color: var(--vscode-foreground); background: transparent; border-color: var(--vscode-button-secondaryBackground); }
    button:disabled, select:disabled { cursor: default; opacity: .55; }
    #runtime { display: flex; gap: 8px; padding: 4px 9px; color: var(--vscode-descriptionForeground); border-bottom: 1px solid var(--vscode-sideBar-border, transparent); font-size: .82em; overflow: hidden; }
    #runtime span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #messages { overflow-y: auto; padding: 10px; }
    .empty { margin: 16vh 18px 0; text-align: center; color: var(--vscode-descriptionForeground); }
    .message { margin: 0 0 12px; }
    .role { margin-bottom: 3px; color: var(--vscode-descriptionForeground); font-size: .8em; font-weight: 600; text-transform: uppercase; }
    .content { padding: 8px 10px; border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; }
    .user .content { background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); }
    .assistant .content { background: var(--vscode-editor-background); border: 1px solid var(--vscode-sideBar-border, transparent); }
    .context { display: inline-block; max-width: 100%; margin-top: 5px; padding: 2px 6px; border-radius: 10px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); font-size: .8em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #tools { max-height: 180px; overflow-y: auto; padding: 0 8px; }
    .tool { margin: 0 0 5px; border: 1px solid var(--vscode-sideBar-border, var(--vscode-input-border)); border-radius: 4px; }
    .tool summary { padding: 4px 7px; cursor: pointer; color: var(--vscode-descriptionForeground); }
    .tool.running summary { color: var(--vscode-progressBar-background); }
    .tool.error summary { color: var(--vscode-errorForeground); }
    .tool pre { max-height: 120px; overflow: auto; margin: 0; padding: 7px; border-top: 1px solid var(--vscode-sideBar-border, transparent); white-space: pre-wrap; font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    #attachments { display: none; margin: 0 8px 6px; padding: 5px 8px; border-radius: 3px; color: var(--vscode-badge-foreground); background: var(--vscode-badge-background); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #composer { padding: 8px; border-top: 1px solid var(--vscode-sideBar-border, transparent); }
    textarea { display: block; width: 100%; min-height: 72px; max-height: 220px; resize: vertical; padding: 8px; color: var(--vscode-input-foreground); background: var(--vscode-input-background); border: 1px solid var(--vscode-input-border, transparent); border-radius: 3px; font: inherit; }
    textarea:focus { border-color: var(--vscode-focusBorder); outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
    .actions { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 6px; margin-top: 7px; }
    .context-actions, .right-actions { display: flex; flex-wrap: wrap; gap: 4px; }
    #notice { min-height: 20px; padding: 0 8px 5px; color: var(--vscode-descriptionForeground); font-size: .85em; }
    #notice.error { color: var(--vscode-errorForeground); }
    #notice.warning { color: var(--vscode-editorWarning-foreground); }
  </style>
</head>
<body>
  <main id="app">
    <div class="toolbar">
      <select id="mode" aria-label="Pi mode" title="Pi mode">
        <option value="ask">Ask</option><option value="edit">Edit</option><option value="plan">Plan</option><option value="agent">Agent</option>
      </select>
      <select id="model" aria-label="Pi model" title="Pi model"></select>
      <select id="thinking" aria-label="Thinking level" title="Thinking level"></select>
      <button id="new-session" class="secondary" type="button" title="Start a new Pi session">New</button>
      <button id="resume-session" class="secondary" type="button" title="Resume a Pi session">Resume</button>
      <button id="name-session" class="secondary" type="button" title="Name this Pi session">Name</button>
      <button id="compact" class="secondary" type="button" title="Compact Pi context">Compact</button>
      <button id="terminal" class="secondary" type="button" title="Open this Pi session in a terminal">Terminal</button>
    </div>
    <div id="runtime"><span id="status">Connecting…</span><span id="session"></span><span id="usage"></span></div>
    <section id="messages" aria-live="polite"><div class="empty">Ask Pi about your workspace, or switch to Agent mode for autonomous coding.</div></section>
    <section id="tools" aria-label="Pi tool activity"></section>
    <div id="attachments" title="Attached to the next message"></div>
    <section id="composer">
      <label for="input" class="role">Message Pi</label>
      <textarea id="input" maxlength="${maxInputCharacters}" placeholder="Ask Pi…" aria-label="Message Pi"></textarea>
      <div class="actions">
        <div class="context-actions">
          <button id="attach" class="secondary" type="button" title="Attach the current editor selection">Selection</button>
          <button id="attach-current" class="secondary" type="button" title="Attach the current file">Current file</button>
          <button id="attach-file" class="secondary" type="button" title="Choose files to attach">Files…</button>
          <button id="attach-diagnostics" class="secondary" type="button" title="Attach current-file diagnostics">Problems</button>
          <button id="clear-context" class="secondary" type="button" title="Clear attached context">Clear context</button>
        </div>
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
    const $ = id => document.getElementById(id);
    const messagesElement = $('messages');
    const toolsElement = $('tools');
    const input = $('input');
    const send = $('send');
    const cancel = $('cancel');
    const attach = $('attach');
    const attachments = $('attachments');
    const notice = $('notice');
    const mode = $('mode');
    const model = $('model');
    const thinking = $('thinking');
    let busy = false;
    let updatingControls = false;

    function submit() {
      const text = input.value.trim();
      if (!text || busy) return;
      vscode.postMessage({ type: 'send', text });
      input.value = '';
      notice.textContent = '';
    }

    function option(select, value, label) {
      const item = document.createElement('option');
      item.value = value;
      item.textContent = label;
      select.appendChild(item);
    }

    function renderControls(runtime) {
      updatingControls = true;
      mode.value = runtime.mode;
      model.replaceChildren();
      const currentProvider = runtime.model && runtime.model.provider;
      const currentId = runtime.model && runtime.model.id;
      for (const candidate of runtime.availableModels || []) {
        if (!candidate.provider || !candidate.id) continue;
        option(model, JSON.stringify([candidate.provider, candidate.id]), candidate.name || (candidate.provider + '/' + candidate.id));
      }
      const currentModelValue = JSON.stringify([currentProvider, currentId]);
      if (![...model.options].some(item => item.value === currentModelValue) && currentId) {
        option(model, currentModelValue, currentProvider + '/' + currentId);
      }
      model.value = currentModelValue;
      thinking.replaceChildren();
      for (const level of runtime.availableThinkingLevels || ['off']) option(thinking, level, level);
      if (runtime.thinkingLevel && ![...thinking.options].some(item => item.value === runtime.thinkingLevel)) {
        option(thinking, runtime.thinkingLevel, runtime.thinkingLevel);
      }
      thinking.value = runtime.thinkingLevel || 'off';
      mode.disabled = busy;
      model.disabled = busy || !runtime.connected;
      thinking.disabled = busy || !runtime.connected;
      updatingControls = false;
    }

    function renderMessages(messages) {
      const nearBottom = messagesElement.scrollHeight - messagesElement.scrollTop - messagesElement.clientHeight < 80;
      messagesElement.replaceChildren();
      if (messages.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'Ask Pi about your workspace, or switch to Agent mode for autonomous coding.';
        messagesElement.appendChild(empty);
      } else {
        for (const message of messages) {
          const wrapper = document.createElement('article');
          wrapper.className = 'message ' + message.role;
          const role = document.createElement('div');
          role.className = 'role';
          role.textContent = message.role === 'user' ? 'You' : 'Pi';
          const content = document.createElement('div');
          content.className = 'content';
          content.textContent = message.content || (message.role === 'assistant' ? '…' : '');
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
      if (nearBottom || busy) messagesElement.scrollTop = messagesElement.scrollHeight;
    }

    function renderTools(tools) {
      toolsElement.replaceChildren();
      for (const tool of tools) {
        const details = document.createElement('details');
        details.className = 'tool ' + tool.status;
        const summary = document.createElement('summary');
        summary.textContent = (tool.status === 'running' ? '● ' : tool.status === 'error' ? '× ' : '✓ ') + tool.name;
        const pre = document.createElement('pre');
        pre.textContent = tool.output || tool.input;
        details.append(summary, pre);
        toolsElement.appendChild(details);
      }
      if (tools.length) toolsElement.lastElementChild.open = true;
    }

    function render(state) {
      busy = Boolean(state.runtime.busy);
      renderMessages(state.messages || []);
      renderTools(state.tools || []);
      renderControls(state.runtime);
      $('status').textContent = state.status + (state.runtime.connected ? '' : ' · disconnected');
      $('session').textContent = state.runtime.sessionName || (state.runtime.sessionId ? 'Session ' + state.runtime.sessionId.slice(0, 8) : '');
      const stats = state.runtime.stats || {};
      const context = stats.contextUsage || {};
      $('usage').textContent = typeof context.percent === 'number' ? Math.round(context.percent) + '% context' : '';
      send.disabled = busy || !state.runtime.connected;
      for (const id of ['attach', 'attach-current', 'attach-file', 'attach-diagnostics', 'clear-context']) $(id).disabled = busy;
      cancel.hidden = !busy;
      send.textContent = busy ? 'Working…' : 'Send';
      for (const id of ['new-session', 'resume-session', 'compact']) $(id).disabled = busy;
      if (state.attachments && state.attachments.length) {
        attachments.style.display = 'block';
        attachments.textContent = 'Attached: ' + state.attachments.map(item => item.label).join(' · ');
      } else {
        attachments.style.display = 'none';
        attachments.textContent = '';
      }
    }

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') render(message);
      if (message.type === 'notice') {
        notice.textContent = message.message;
        notice.className = message.level;
      }
      if (message.type === 'setInput') {
        input.value = message.text;
        input.focus();
      }
    });
    send.addEventListener('click', submit);
    cancel.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
    attach.addEventListener('click', () => vscode.postMessage({ type: 'attachSelection' }));
    $('attach-current').addEventListener('click', () => vscode.postMessage({ type: 'attachCurrentFile' }));
    $('attach-file').addEventListener('click', () => vscode.postMessage({ type: 'attachFile' }));
    $('attach-diagnostics').addEventListener('click', () => vscode.postMessage({ type: 'attachDiagnostics' }));
    $('clear-context').addEventListener('click', () => vscode.postMessage({ type: 'clearAttachments' }));
    $('new-session').addEventListener('click', () => vscode.postMessage({ type: 'newSession' }));
    $('resume-session').addEventListener('click', () => vscode.postMessage({ type: 'resumeSession' }));
    $('name-session').addEventListener('click', () => vscode.postMessage({ type: 'nameSession' }));
    $('compact').addEventListener('click', () => vscode.postMessage({ type: 'compact' }));
    $('terminal').addEventListener('click', () => vscode.postMessage({ type: 'openTerminal' }));
    mode.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setMode', mode: mode.value }); });
    model.addEventListener('change', () => {
      if (updatingControls || !model.value) return;
      const [provider, modelId] = JSON.parse(model.value);
      vscode.postMessage({ type: 'setModel', provider, modelId });
    });
    thinking.addEventListener('change', () => { if (!updatingControls) vscode.postMessage({ type: 'setThinking', level: thinking.value }); });
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
