import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { BackgroundAgentManager } from "./backgroundAgents";
import type { EditProposalInput, PiConversationController } from "./conversationController";
import { WorkspaceChangeTracker, type TrackedFileChange } from "./changeTracker";
import { getSidebarHtml } from "./sidebarHtml";
import { renderSafeMarkdown } from "./markdown";
import { buildAgentPrompt, type ChatReferenceContext } from "./prompts";
import { PiRuntimeManager } from "./piRuntime";
import type { PiRpcEvent, PiRpcImage } from "./piRpcClient";
import type { PiAgentMode } from "./runtimeProfiles";
import { SidebarAttachmentManager } from "./sidebarAttachments";
import {
  convertPiMessages,
  extractToolText,
  formatError,
  isRecord,
  isWebviewMessage,
  modeLabel,
  modelSupportsImages,
  restoreMessages,
  safeJson,
  stringValue,
  type WebviewMessage,
} from "./sidebarHelpers";
import { limitSidebarMessages, type SidebarMessage } from "./sidebarState";

const viewId = "piCodingAgent.chatView";
const storageKey = "piCodingAgent.sidebar.messages.v1";
const maxMessages = 100;
const maxStoredCharacters = 250_000;
const maxInputCharacters = 100_000;
const maxAttachedCharacters = 200_000;
const maxTotalContextCharacters = 400_000;
const maxAttachments = 8;
const maxImageAttachments = 5;
const maxImageBytes = 5 * 1024 * 1024;
const maxToolActivities = 30;
const maxToolOutputCharacters = 8_000;

interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "success" | "error";
  readonly input: string;
  readonly output?: string;
}

interface EditProposalState {
  readonly id: string;
  readonly label: string;
  readonly status: "ready" | "previewed" | "applying" | "applied" | "rejected" | "stale" | "failed";
  readonly error?: string;
}

interface EditProposalEntry {
  state: EditProposalState;
  readonly input: EditProposalInput;
}

export function registerPiSidebar(
  context: vscode.ExtensionContext,
  runtime: PiRuntimeManager,
): PiConversationController {
  const backgroundAgents = new BackgroundAgentManager(context);
  const changeTracker = new WorkspaceChangeTracker();
  const provider = new PiChatViewProvider(context, runtime, changeTracker, backgroundAgents);
  context.subscriptions.push(
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
  return provider;
}

class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, PiConversationController {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private messages: SidebarMessage[];
  private tools: ToolActivity[] = [];
  private changes: TrackedFileChange[] = [];
  private readonly proposals = new Map<string, EditProposalEntry>();
  private readonly attachments: SidebarAttachmentManager;
  private status = "Ready";
  private cancelRequested = false;
  private retryRequest: {
    readonly request: string;
    readonly contexts: readonly ChatReferenceContext[];
    readonly images: readonly PiRpcImage[];
    readonly resource?: vscode.Uri;
    readonly instructions?: string;
  } | undefined;
  private streamingAssistantId: string | undefined;
  private renderTimer: NodeJS.Timeout | undefined;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: PiRuntimeManager,
    private readonly changeTracker: WorkspaceChangeTracker,
    private readonly backgroundAgents: BackgroundAgentManager,
  ) {
    this.attachments = new SidebarAttachmentManager({
      maxAttachments,
      maxImageAttachments,
      maxImageBytes,
      maxAttachedCharacters,
      maxTotalContextCharacters,
      onChange: () => this.postState(),
      onNotice: (message, level) => this.postNotice(message, level),
    });
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey), maxMessages, maxStoredCharacters);
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
    webviewView.webview.html = getSidebarHtml(maxInputCharacters, maxImageBytes);

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
    this.proposals.clear();
  }

  public async sendRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    options: { readonly instructions?: string; readonly resource?: vscode.Uri } = {},
  ): Promise<string> {
    await vscode.commands.executeCommand(`${viewId}.focus`);
    return this.runRequest(request, contexts, [], options.resource, options.instructions);
  }

  public addEditProposal(input: EditProposalInput): string {
    const id = randomUUID();
    this.proposals.set(id, {
      state: { id, label: input.label, status: "ready" },
      input,
    });
    this.postState();
    return id;
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
    if (!isWebviewMessage(message, maxImageBytes)) {
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
          this.cancelRequested = true;
          await this.runtime.abort();
          this.status = "Cancelled · Ready to retry";
          this.postState();
          break;
        case "reconnect":
          await this.reconnect();
          break;
        case "retry":
          await this.retryLastRequest();
          break;
        case "pickContext":
          await this.attachments.pickContext();
          break;
        case "showMoreActions":
          await this.showMoreActions(message.text);
          break;
        case "pickModel":
          await this.pickModel();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "attachSelection":
          this.attachments.attachSelection();
          break;
        case "attachFile":
          await this.attachments.attachFile();
          break;
        case "attachCurrentFile":
          await this.attachments.attachCurrentFile();
          break;
        case "attachDiagnostics":
          this.attachments.attachDiagnostics();
          break;
        case "attachImage":
          await this.attachments.attachImage();
          break;
        case "pasteImage":
          this.attachments.attachPastedImage(message);
          break;
        case "attachTerminal":
          await this.attachments.attachTerminalSelection();
          break;
        case "pickCommand":
          await this.pickPiCommand();
          break;
        case "exportSession":
          await this.exportSession();
          break;
        case "clearAttachments":
          this.attachments.clear();
          break;
        case "removeAttachment":
          this.attachments.remove(message.id);
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
        case "proposalAction":
          await this.handleProposalAction(message.id, message.action);
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

  private async reconnect(): Promise<void> {
    this.status = "Connecting to Pi…";
    this.postState();
    try {
      await this.runtime.ensureStarted(vscode.window.activeTextEditor?.document.uri);
      await this.syncMessagesFromPi();
      this.status = "Ready";
    } catch (error) {
      this.status = "Disconnected · Reconnect available";
      this.postState();
      throw error;
    }
    this.postState();
  }

  private async showMoreActions(composerText: string): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [
        { label: "$(history) Resume Session", action: "resume" },
        { label: "$(edit) Rename Session", action: "rename" },
        { label: "$(symbol-method) Change Model", action: "model" },
        { label: "$(lightbulb) Change Thinking Level", action: "thinking" },
        { label: "$(list-selection) Commands and Skills", action: "commands" },
        { label: "$(fold) Compact Context", action: "compact" },
        { label: "$(export) Export Session", action: "export" },
        { label: "$(terminal) Open in Terminal", action: "terminal" },
        { label: "$(run) Run Message in Background", action: "background" },
        { label: "$(workspace-trusted) Run Message in Worktree", action: "worktree" },
      ],
      { title: "Pi Chat Actions", placeHolder: "Choose a session or advanced action" },
    );
    if (!selected) return;
    if (selected.action === "resume") await this.resumeSession();
    else if (selected.action === "rename") await this.nameSession();
    else if (selected.action === "model") await this.pickModel();
    else if (selected.action === "thinking") await this.pickThinkingLevel();
    else if (selected.action === "commands") await this.pickPiCommand();
    else if (selected.action === "compact") await this.compact();
    else if (selected.action === "export") await this.exportSession();
    else if (selected.action === "terminal") await this.runtime.openInTerminal();
    else if (selected.action === "background") await this.runBackground(composerText, false);
    else await this.runBackground(composerText, true);
  }

  private async pickModel(): Promise<void> {
    const models = this.runtime.currentState.availableModels;
    const selected = await vscode.window.showQuickPick(
      models.flatMap(model => {
        const provider = stringValue(model.provider);
        const id = stringValue(model.id);
        if (!provider || !id) return [];
        return [{
          label: stringValue(model.name) ?? `${provider}/${id}`,
          description: `${provider}/${id}`,
          provider,
          id,
        }];
      }),
      { title: "Choose Pi Model", matchOnDescription: true },
    );
    if (selected) {
      await this.runtime.setModel(selected.provider, selected.id);
    }
  }

  private async pickThinkingLevel(): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      this.runtime.currentState.availableThinkingLevels,
      { title: "Choose Pi Thinking Level" },
    );
    if (selected) {
      await this.runtime.setThinkingLevel(selected);
    }
  }

  private async retryLastRequest(): Promise<void> {
    const retry = this.retryRequest;
    if (!retry) {
      throw new Error("There is no failed or cancelled Pi request to retry.");
    }
    if (retry.images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error("The current model does not support the images in this request. Change the model before retrying.");
    }
    await this.runRequest(
      retry.request,
      retry.contexts,
      retry.images,
      retry.resource,
      retry.instructions,
      () => this.postMessage({ type: "clearInput" }),
      true,
    );
  }

  private async send(rawText: string): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      return;
    }
    const textContexts = this.attachments.textContexts;
    const images = this.attachments.images;
    if (images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error("The current model does not support images. Change the model or remove image attachments before sending.");
    }
    await this.runRequest(
      text,
      textContexts,
      images,
      this.attachments.resource,
      undefined,
      () => {
        this.attachments.clear();
        this.postMessage({ type: "clearInput" });
      },
      true,
    );
  }

  private async runRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    images: readonly PiRpcImage[],
    resource?: vscode.Uri,
    instructions?: string,
    onAccepted?: () => void,
    retryable = false,
  ): Promise<string> {
    const text = request.trim();
    if (!text) {
      throw new Error("Enter a message for Pi.");
    }
    if (this.runtime.currentState.busy) {
      throw new Error("Pi is already working. Cancel or wait for the active request before starting another one.");
    }
    if (text.length > maxInputCharacters) {
      throw new Error(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`);
    }

    this.retryRequest = retryable
      ? { request: text, contexts: [...contexts], images: [...images], resource, instructions }
      : undefined;
    this.messages = limitSidebarMessages(
      [
        ...this.messages,
        {
          id: randomUUID(),
          role: "user",
          content: text,
          contextLabel: contexts.map(context => context.label).join(", ") || undefined,
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
      await this.runtime.prompt(buildAgentPrompt(text, contexts, instructions), resource, images, onAccepted);
      if (this.cancelRequested) {
        throw new Error("Pi request was cancelled.");
      }
      const response = await this.runtime.getLastAssistantText();
      await this.syncMessagesFromPi();
      this.status = "Ready";
      this.retryRequest = undefined;
      this.postState();
      return response;
    } catch (error) {
      const message = formatError(error);
      if (/cancelled/i.test(message)) {
        this.status = retryable ? "Cancelled · Ready to retry" : "Cancelled · Run the action again to retry";
        this.postNotice(
          retryable
            ? "Pi request cancelled. The message remains in the conversation and can be retried."
            : "Pi request cancelled. Run the editor action again to retry with a fresh document snapshot.",
          "info",
        );
      } else {
        this.status = retryable ? "Request failed · Retry available" : "Request failed · Run the action again";
        this.postNotice(
          retryable ? `${message} Retry the message after resolving the problem.` : `${message} Run the editor action again to retry.`,
          "error",
        );
      }
      this.cancelRequested = false;
      this.postState();
      throw error;
    }
  }

  private async handleProposalAction(id: string, action: "preview" | "apply" | "reject"): Promise<void> {
    const proposal = this.proposals.get(id);
    if (!proposal) {
      throw new Error("This edit proposal is no longer available. Regenerate it from the conversation.");
    }
    if (action === "reject") {
      await proposal.input.onReject?.();
      proposal.state = { ...proposal.state, status: "rejected", error: undefined };
      this.postState();
      return;
    }
    if (action === "preview") {
      await proposal.input.onPreview();
      proposal.state = { ...proposal.state, status: "previewed", error: undefined };
      this.postState();
      return;
    }
    if (proposal.state.status !== "previewed") {
      throw new Error("Preview the edit before applying it.");
    }
    proposal.state = { ...proposal.state, status: "applying", error: undefined };
    this.postState();
    try {
      await proposal.input.onApply();
      proposal.state = { ...proposal.state, status: "applied" };
      this.postNotice("Pi edit applied. Use Undo to revert it.", "info");
    } catch (error) {
      const message = formatError(error);
      proposal.state = {
        ...proposal.state,
        status: /changed|stale|regenerate/i.test(message) ? "stale" : "failed",
        error: message,
      };
      this.postNotice(message, "error");
    }
    this.postState();
  }

  private async runBackground(rawText: string, isolated: boolean): Promise<void> {
    const text = rawText.trim();
    if (!text) {
      throw new Error("Enter a message before starting a background or worktree agent.");
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
    const contexts = this.attachments.textContexts;
    const images = this.attachments.images;
    await this.backgroundAgents.start(text, contexts, images, this.runtime.currentCwd, isolated);
    this.attachments.clear();
    this.postMessage({ type: "clearInput" });
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
    this.proposals.clear();
    this.retryRequest = undefined;
    this.attachments.clear();
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
    this.proposals.clear();
    this.status = "Pi session resumed";
    this.postState();
  }

  private async pickPiCommand(): Promise<void> {
    const commands = this.runtime.currentState.commands
      .map(command => ({
        name: typeof command.name === "string" ? command.name : undefined,
        description: typeof command.description === "string" ? command.description : undefined,
        source: typeof command.source === "string" ? command.source : undefined,
      }))
      .filter((command): command is { name: string; description: string | undefined; source: string | undefined } => Boolean(command.name));
    if (commands.length === 0) {
      this.postNotice("Pi did not discover any extension commands, prompt templates, or skills.", "info");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      commands.map(command => ({
        label: `/${command.name}`,
        description: command.source,
        detail: command.description,
        command: command.name,
      })),
      { title: "Pi Commands, Prompts, and Skills", matchOnDescription: true, matchOnDetail: true },
    );
    if (selected) {
      this.postMessage({ type: "setInput", text: `/${selected.command} ` });
    }
  }

  private async exportSession(): Promise<void> {
    const defaultName = `${this.runtime.currentState.sessionName ?? "pi-session"}.html`;
    const target = await vscode.window.showSaveDialog({
      title: "Export Pi Session",
      defaultUri: vscode.Uri.joinPath(vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()), defaultName),
      filters: { HTML: ["html"] },
      saveLabel: "Export",
    });
    if (!target) {
      return;
    }
    const exportedPath = await this.runtime.exportSession(target.fsPath);
    const action = await vscode.window.showInformationMessage(`Pi session exported to ${exportedPath}.`, "Open Export");
    if (action === "Open Export") {
      await vscode.env.openExternal(vscode.Uri.file(exportedPath));
    }
  }

  private handleRuntimeEvent(event: PiRpcEvent): void {
    if (event.type === "agent_start") {
      this.cancelRequested = false;
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
        input: safeJson(event.args, maxToolOutputCharacters),
      });
      this.status = `Running ${stringValue(event.toolName) ?? "tool"}…`;
    } else if (event.type === "tool_execution_update") {
      const id = stringValue(event.toolCallId);
      if (id) {
        this.updateTool(id, { output: extractToolText(event.partialResult, maxToolOutputCharacters) });
      }
    } else if (event.type === "tool_execution_end") {
      const id = stringValue(event.toolCallId);
      if (id) {
        this.updateTool(id, {
          status: event.isError ? "error" : "success",
          output: extractToolText(event.result, maxToolOutputCharacters),
        });
      }
    } else if (event.type === "compaction_start") {
      this.status = "Compacting Pi context…";
    } else if (event.type === "auto_retry_start") {
      this.status = "Retrying Pi request…";
    } else if (event.type === "agent_settled") {
      this.status = this.cancelRequested ? "Cancelled · Ready to retry" : "Ready";
      this.streamingAssistantId = undefined;
      this.changes = this.changeTracker.finishRequest();
      void this.syncMessagesFromPi();
    } else if (event.type === "process_exit") {
      this.status = "Disconnected · Reconnect available";
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
      messages: this.messages.map(message => ({ ...message, html: renderSafeMarkdown(message.content) })),
      tools: this.tools,
      changes: this.changes,
      proposals: [...this.proposals.values()].map(proposal => proposal.state),
      backgroundTasks: this.backgroundAgents.states,
      status: this.status,
      attachments: this.attachments.summaries,
      imageSupported: modelSupportsImages(this.runtime.currentState.model),
      retryAvailable: Boolean(this.retryRequest) && !this.runtime.currentState.busy,
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
