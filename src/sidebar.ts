import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { BackgroundAgentManager } from "./backgroundAgents";
import { WorkspaceChangeTracker, type TrackedFileChange } from "./changeTracker";
import { getSidebarHtml } from "./sidebarHtml";
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
  const backgroundAgents = new BackgroundAgentManager(context);
  const changeTracker = new WorkspaceChangeTracker();
  const provider = new PiChatViewProvider(context, runtime, changeTracker, backgroundAgents);
  context.subscriptions.push(
    runtime,
    backgroundAgents,
    changeTracker,
    provider,
    vscode.workspace.registerTextDocumentContentProvider("pi-checkpoint", changeTracker),
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
  private changes: TrackedFileChange[] = [];
  private attachments: AttachedContext[] = [];
  private status = "Ready";
  private streamingAssistantId: string | undefined;
  private renderTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: PiRuntimeManager,
    private readonly changeTracker: WorkspaceChangeTracker,
    private readonly backgroundAgents: BackgroundAgentManager,
  ) {
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey));
    this.disposables.push(
      runtime.onEvent(event => this.handleRuntimeEvent(event)),
      runtime.onDidChangeState(() => this.scheduleState()),
      backgroundAgents.onDidChange(() => this.scheduleState()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [],
    };
    webviewView.webview.html = getSidebarHtml(maxInputCharacters);

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
        case "handoffAgent":
          await this.setMode("agent");
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
        case "reviewChange":
          await this.changeTracker.review(message.id);
          break;
        case "openChange":
          await this.changeTracker.open(message.id);
          break;
        case "revertChange":
          await this.revertChange(message.id);
          break;
        case "openSourceControl":
          await vscode.commands.executeCommand("workbench.view.scm");
          break;
        case "runBackground":
          await this.runBackground(message.text, message.isolated);
          break;
        case "cancelBackground":
          await this.backgroundAgents.cancel(message.id);
          break;
        case "resumeBackground":
          await this.resumeBackground(message.id);
          break;
        case "openWorktree":
          await this.backgroundAgents.openWorktree(message.id);
          break;
        case "cleanupWorktree":
          await this.cleanupBackgroundWorktree(message.id);
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
    this.changes = [];
    this.changeTracker.startRequest(this.runtime.currentCwd);
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

  private async runBackground(rawText: string, isolated: boolean): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    if (text.length > maxInputCharacters) {
      throw new Error(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`);
    }
    const confirmation = await vscode.window.showWarningMessage(
      isolated
        ? "Start an autonomous Pi Agent in a detached Git worktree created from HEAD?"
        : "Start an autonomous Pi Agent that can edit the current workspace and run shell commands?",
      { modal: true },
      isolated ? "Start Worktree Agent" : "Start Background Agent",
    );
    if (!confirmation) {
      return;
    }
    const contexts = this.attachments;
    this.attachments = [];
    await this.backgroundAgents.start(text, contexts, this.runtime.currentCwd, isolated);
    this.postNotice(isolated ? "Started an isolated worktree agent." : "Started a background agent.", "info");
    this.postState();
  }

  private async cleanupBackgroundWorktree(id: string): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "Remove this isolated worktree and all uncommitted changes inside it?",
      { modal: true },
      "Remove Worktree",
    );
    if (confirmation === "Remove Worktree") {
      await this.backgroundAgents.cleanupWorktree(id);
    }
  }

  private async resumeBackground(id: string): Promise<void> {
    if (this.runtime.currentState.busy) {
      throw new Error("Cancel the foreground request before resuming a background session.");
    }
    const sessionFile = await this.backgroundAgents.openSession(id);
    await this.runtime.switchSession(sessionFile);
    await this.syncMessagesFromPi();
    this.status = "Background Pi session resumed";
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
    this.changes = [];
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

  private async revertChange(id: string): Promise<void> {
    const change = this.changes.find(item => item.id === id);
    if (!change) {
      throw new Error("The selected Pi change is no longer available.");
    }
    const confirmation = await vscode.window.showWarningMessage(
      `Revert Pi's change to ${change.label}?`,
      { modal: true },
      "Revert File",
    );
    if (confirmation !== "Revert File") {
      return;
    }
    this.changes = this.changeTracker.revert(id);
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
    this.changes = [];
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
      this.changeTracker.captureToolEvent(event);
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
      this.changes = this.changeTracker.finishRequest();
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
      changes: this.changes,
      backgroundTasks: this.backgroundAgents.states,
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
  | { readonly type: "ready" | "cancel" | "newSession" | "attachSelection" | "attachFile" | "attachCurrentFile" | "attachDiagnostics" | "clearAttachments" | "compact" | "nameSession" | "resumeSession" | "openTerminal" | "openSourceControl" | "handoffAgent" }
  | { readonly type: "send"; readonly text: string }
  | { readonly type: "setMode"; readonly mode: PiAgentMode }
  | { readonly type: "setModel"; readonly provider: string; readonly modelId: string }
  | { readonly type: "setThinking"; readonly level: string }
  | { readonly type: "reviewChange" | "openChange" | "revertChange" | "cancelBackground" | "resumeBackground" | "openWorktree" | "cleanupWorktree"; readonly id: string }
  | { readonly type: "runBackground"; readonly text: string; readonly isolated: boolean };

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
  if (value.type === "runBackground") {
    return typeof value.text === "string" && typeof value.isolated === "boolean";
  }
  if (["reviewChange", "openChange", "revertChange", "cancelBackground", "resumeBackground", "openWorktree", "cleanupWorktree"].includes(value.type)) {
    return typeof value.id === "string";
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
    "openSourceControl",
    "handoffAgent",
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
