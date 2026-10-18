import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { BackgroundAgentManager } from "./backgroundAgents";
import { type TrackedFileChange, WorkspaceChangeTracker } from "./changeTracker";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  type ConversationRequestOptions,
  type ConversationRequestOrigin,
  ConversationSideEffectTracker,
  conversationRequestBehavior,
  type EditProposalInput,
  ExclusiveOperationGate,
  type PiConversationController,
  shouldTrackConversationChanges,
} from "./conversationController";
import { parseComposerInput, parseShellResult, shellMessageText } from "./directShell";
import { EditProposalStore } from "./editProposals";
import { ImageAssetCache, ImageAssetDeliveryTracker } from "./imageAssets";
import { escapeHtml, MarkdownRenderer } from "./markdown";
import { acquireOperation } from "./operationLocks";
import type { PiRpcEvent, PiRpcImage } from "./piRpcClient";
import { deleteConversationWithTrashFallback, type PiRuntimeManager, runtimeSessionIdentityChanged } from "./piRuntime";
import { type AgentRequestPolicy, buildAgentPrompt, type ChatReferenceContext } from "./prompts";
import { listRecentPiSessions, type PiSessionSummary, piSessionKey } from "./sessionHistory";
import { SidebarAssistantStream } from "./sidebarAssistantStream";
import { registerSessionTransfer } from "./sessionTransferController";
import {
  resolveSidebarQueueSubmission,
  resolveSidebarSubmissionText,
  SidebarAttachmentManager,
} from "./sidebarAttachments";
import { SidebarExtensionUi } from "./sidebarExtensionUi";
import { SidebarFileCompletion } from "./sidebarFileCompletion";
import {
  boundToolText,
  convertPiMessages,
  extractToolText,
  formatError,
  isRecord,
  isWebviewMessage,
  modelSupportsImages,
  restoreMessages,
  safeJson,
  shouldPostActionErrorNotice,
  stringValue,
  toolOperationSummary,
  type WebviewMessage,
} from "./sidebarHelpers";
import { getSidebarHtml } from "./sidebarHtml";
import {
  contextTranscriptAttachment,
  historySyncFailureState,
  limitSidebarMessages,
  persistableSidebarMessages,
  runtimeNoticeSummary,
  type SidebarMessage,
  shortTranscriptLabel,
  sidebarMessagesForWebview,
  type TranscriptAttachment,
} from "./sidebarState";
import { WorkflowDocuments } from "./workflowUi";

const viewId = "pi.chatView";
const storageKey = "pi.sidebar.messages.v1";
const maxMessages = 100;
const maxStoredCharacters = 250_000;
const maxInputCharacters = 100_000;
const maxAttachedCharacters = 200_000;
const maxTotalContextCharacters = 400_000;
const maxAttachments = 8;
const maxImageAttachments = 5;
const maxImageBytes = 5 * 1024 * 1024;
const maxImageAssetCacheBytes = 25 * 1024 * 1024;
const maxImageAssets = 100;
const maxToolActivities = 30;
const maxToolOutputCharacters = 8_000;

interface ToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "success" | "error";
  readonly input: string;
  readonly summary: string;
  readonly output?: string;
}

interface QueuedTranscriptPresentation {
  readonly id: string;
  readonly message: SidebarMessage;
}

export function registerPiSidebar(
  context: vscode.ExtensionContext,
  runtime: PiRuntimeManager,
): PiConversationController {
  const backgroundAgents = new BackgroundAgentManager(context);
  const changeTracker = new WorkspaceChangeTracker();
  const provider = new PiChatViewProvider(context, runtime, changeTracker, backgroundAgents);
  registerSessionTransfer(context, runtime);
  context.subscriptions.push(
    backgroundAgents,
    changeTracker,
    provider,
    vscode.workspace.registerTextDocumentContentProvider("pi-checkpoint", changeTracker),
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("pi.openChat", () => provider.showSessions()),
    vscode.commands.registerCommand("pi.reloadResources", () => provider.reloadResources()),
    vscode.commands.registerCommand("pi.restartResources", () => provider.restartResources()),
    vscode.commands.registerCommand("pi.browseSessionTree", () => provider.browseSessionTree()),
    vscode.commands.registerCommand("pi.returnFromTerminal", () => provider.returnFromTerminal()),
  );
  return provider;
}

class PiChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, PiConversationController {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly markdownRenderer = new MarkdownRenderer();
  private view: vscode.WebviewView | undefined;
  private messages: SidebarMessage[];
  private tools: ToolActivity[] = [];
  private readonly extensionUi = new SidebarExtensionUi();
  private changes: TrackedFileChange[] = [];
  private readonly proposals: EditProposalStore;
  private readonly imageAssets = new ImageAssetCache({
    maxImageBytes,
    maxTotalBytes: maxImageAssetCacheBytes,
    maxAssets: maxImageAssets,
  });
  private readonly imageAssetDelivery = new ImageAssetDeliveryTracker();
  private readonly attachments: SidebarAttachmentManager;
  private readonly fileCompletion: SidebarFileCompletion;
  private readonly requestGate = new ConversationRequestGate();
  private readonly backgroundSubmissionGate = new ExclusiveOperationGate(
    "A background or worktree agent is already starting. Wait for it to finish starting before submitting another one.",
  );
  private readonly requestLifecycle = new ConversationRequestLifecycle();
  private status = "Ready";
  private trackCurrentRequestChanges = false;
  private readonly currentRequestSideEffects = new ConversationSideEffectTracker(this.requestLifecycle);
  private historyRecoveryAvailable = false;
  private retryRequest:
    | {
        readonly request: string;
        readonly contexts: readonly ChatReferenceContext[];
        readonly images: readonly PiRpcImage[];
        readonly resource?: vscode.Uri;
        readonly instructions?: string;
        readonly policy?: AgentRequestPolicy;
        readonly transcriptAttachments: readonly TranscriptAttachment[];
      }
    | undefined;
  private assistantStream: SidebarAssistantStream | undefined;
  private streamSessionIdentity: string;
  private historySyncRevision = 0;
  private readonly queuedTranscriptPresentations = new Map<string, QueuedTranscriptPresentation>();
  private renderTimer: NodeJS.Timeout | undefined;
  private foregroundCancellable = false;
  private noticeDetails: string | undefined;
  private noticeRevision = 0;
  private recentSessions: PiSessionSummary[] = [];
  private sessionRefreshRevision = 0;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly runtime: PiRuntimeManager,
    private readonly changeTracker: WorkspaceChangeTracker,
    private readonly backgroundAgents: BackgroundAgentManager,
  ) {
    this.proposals = new EditProposalStore(
      () => this.postState(),
      (message, level) => this.postNotice(message, level),
    );
    this.attachments = new SidebarAttachmentManager({
      maxAttachments,
      maxImageAttachments,
      maxImageBytes,
      maxAttachedCharacters,
      maxTotalContextCharacters,
      imageAssets: this.imageAssets,
      onChange: () => this.postState(),
      onNotice: (message, level) => this.postNotice(message, level),
    });
    this.fileCompletion = new SidebarFileCompletion({
      cwd: () => this.runtime.currentCwd,
      session: () => `${this.runtime.currentState.sessionId ?? ""}:${this.runtime.currentState.sessionFile ?? ""}`,
      attachments: this.attachments,
      post: (message) => this.postMessage(message),
    });
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey), maxMessages, maxStoredCharacters);
    this.streamSessionIdentity = JSON.stringify([runtime.currentState.sessionFile, runtime.currentState.sessionId]);
    this.disposables.push(
      runtime.onEvent((event) => this.handleRuntimeEvent(event)),
      runtime.onDidChangeState(() => {
        const identity = JSON.stringify([runtime.currentState.sessionFile, runtime.currentState.sessionId]);
        if (identity !== this.streamSessionIdentity) {
          if (this.assistantStream)
            this.messages = this.messages.filter((message) => message.id !== this.assistantStream?.id);
          this.assistantStream = undefined;
          this.historySyncRevision += 1;
          this.streamSessionIdentity = identity;
        }
        this.scheduleState();
      }),
      backgroundAgents.onDidChange(() => this.scheduleState()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.imageAssetDelivery.reset();
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "out", "rich-content")],
    };
    const assets = vscode.Uri.joinPath(this.context.extensionUri, "out", "rich-content");
    webviewView.webview.html = getSidebarHtml(maxInputCharacters, maxImageBytes, {
      source: webviewView.webview.cspSource,
      script: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(assets, "rich-content.js")).toString(),
      style: webviewView.webview.asWebviewUri(vscode.Uri.joinPath(assets, "rich-content.css")).toString(),
    });

    const messageListener = webviewView.webview.onDidReceiveMessage((message) => {
      void this.handleMessage(message);
    });
    const viewListener = webviewView.onDidDispose(() => {
      messageListener.dispose();
      viewListener.dispose();
      if (this.view === webviewView) {
        this.fileCompletion.cancel();
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
    this.queuedTranscriptPresentations.clear();
    this.extensionUi.clear();
    this.fileCompletion.dispose();
    this.attachments.dispose();
    this.imageAssets.clear();
  }

  public async showSessions(): Promise<void> {
    await vscode.commands.executeCommand(`${viewId}.focus`);
    this.postMessage({ type: "showSessionsLayer" });
  }

  public async sendRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    options: ConversationRequestOptions = {},
  ): Promise<string> {
    await vscode.commands.executeCommand(`${viewId}.focus`);
    this.postMessage({ type: "showSessionDetail" });
    return this.runRequest(
      request,
      contexts,
      [],
      options.resource,
      options.instructions,
      options.policy,
      "editor",
      options.onResponse,
      undefined,
      options.validate,
      contexts.flatMap((context) => contextTranscriptAttachment(context.label) ?? []),
    );
  }

  public addEditProposal(input: EditProposalInput): string {
    return this.proposals.add(input);
  }

  private async initializeRuntime(): Promise<void> {
    this.status = "Connecting to Pi…";
    this.postState();
    try {
      await this.runtime.ensureStarted(vscode.window.activeTextEditor?.document.uri);
      await this.syncMessagesFromPi();
      await this.refreshRecentSessions(false);
      this.status = "Ready";
    } catch (error) {
      const failure = historySyncFailureState(this.runtime.currentState.connected);
      this.status = failure.status;
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.postNotice(
        failure.historyRecoveryAvailable
          ? "Pi connected, but conversation history could not be loaded. Use Refresh history to retry."
          : "Pi could not connect. Use Reconnect after resolving the problem.",
        "error",
        formatError(error),
      );
    }
    this.postState();
  }

  private async handleMessage(message: unknown): Promise<void> {
    if (!isWebviewMessage(message, maxImageBytes)) {
      return;
    }

    if (
      message.type === "fileCompletionQuery" ||
      message.type === "fileCompletionSelect" ||
      message.type === "fileCompletionCancel"
    ) {
      await this.fileCompletion.handle(message);
      return;
    }
    // Every other action can change the session, attachments, or composer draft.
    this.fileCompletion.cancel();
    const noticeRevision = this.noticeRevision;
    try {
      switch (message.type) {
        case "ready":
          this.postState();
          break;
        case "send":
          await this.send(message.text, message.revision);
          break;
        case "sendNewSession":
          await this.sendInNewSession(message.text, message.revision);
          break;
        case "queueInstruction":
          await this.queue(message.kind, message.text, message.revision);
          break;
        case "clearQueue":
          await this.runtime.clearInstructions();
          this.queuedTranscriptPresentations.clear();
          break;
        case "inspectQueue": {
          const documents = new WorkflowDocuments();
          const state = this.runtime.currentState;
          try {
            await documents.inspect(
              "Pi pending queue snapshot",
              `Session ${state.sessionId ?? "unknown"}; captured ${new Date().toISOString()}. Pending state can change while inspecting; not delivery evidence.\n\n${JSON.stringify(state.queue ?? { steering: [], followUp: [] }, null, 2)}`,
            );
          } finally {
            documents.dispose();
          }
          break;
        }
        case "recoverQueue": {
          const picked = await vscode.window.showQuickPick(
            (this.runtime.currentState.recoveredDrafts ?? []).map((draft) => ({
              label: draft.text.slice(0, 150),
              description: `${draft.uncertain ? "Delivery uncertain — inspect history before resending" : "Cleared before delivery"}${draft.hasAttachments ? " · attachments available" : ""}`,
              draft,
            })),
            { title: "Recovered queue drafts (never replayed automatically)" },
          );
          if (picked) {
            this.postMessage({
              type: "appendDraft",
              text: picked.draft.text,
              expectedRevision: message.revision,
              ...(picked.draft.hasAttachments ? { recoveredDraftId: picked.draft.id } : {}),
            });
          }
          break;
        }
        case "restoreQueueAttachments":
          try {
            this.runtime.restoreRecoveredDraftAttachments(message.id);
            this.postMessage({ type: "commitRecoveredDraft", id: message.id });
          } catch (error) {
            this.postMessage({ type: "rejectRecoveredDraft", id: message.id });
            throw error;
          }
          break;
        case "cancel":
          this.requestLifecycle.cancel();
          await this.runtime.abort();
          this.queuedTranscriptPresentations.clear();
          this.status = "Stopped · Check history and effects before sending again";
          this.postState();
          break;
        case "reconnect":
          await this.reconnect();
          break;
        case "refreshHistory":
          await this.refreshHistory();
          break;
        case "refreshSessions":
          await this.refreshRecentSessions();
          break;
        case "switchRecentSession":
          await this.switchRecentSession(message.id);
          break;
        case "retry":
          await this.retryLastRequest();
          break;
        case "inspectContext":
          await this.attachments.inspect();
          break;
        case "pickContext":
          await this.attachments.pickContext();
          break;
        case "showMoreActions":
          await this.showMoreActions(message.text, message.revision);
          break;
        case "pickModel":
          await this.pickModel();
          break;
        case "newSession":
          await this.newSession();
          break;
        case "deleteSession":
          await this.deleteSession();
          break;
        case "showNoticeDetails":
          if (this.noticeDetails) await vscode.window.showErrorMessage(this.noticeDetails, { modal: true });
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
        case "imageAssetEvicted":
          this.imageAssetDelivery.retry(message.id);
          this.postState();
          break;
        case "imageAssetRejected":
          this.imageAssets.reject(message.id);
          this.imageAssetDelivery.retry(message.id);
          this.postState();
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
          if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before changing or applying proposals.");
          if (message.action === "select") {
            const choices = await vscode.window.showQuickPick(this.proposals.hunkChoices(message.id), {
              title: "Choose edit hunks · changing selection invalidates Preview",
              canPickMany: true,
            });
            if (choices)
              this.proposals.select(
                message.id,
                choices.map((choice) => choice.id),
              );
          } else {
            await this.proposals.handleLockedAction(
              message.id,
              message.action,
              await realpath(this.runtime.currentCwd),
            );
          }
          break;
        case "runBackground":
          await this.runBackground(message.text, message.isolated, message.revision);
          break;
        case "reviewBackground":
          await this.backgroundAgents.reviewResults(message.id);
          break;
        case "applyBackground":
          await this.backgroundAgents.applySelected(message.id, this.runtime.currentCwd);
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
      if (message.type === "send" || message.type === "sendNewSession" || message.type === "queueInstruction") {
        this.postMessage({ type: "sendRejected" });
      } else if (message.type === "switchRecentSession") {
        this.postMessage({ type: "sessionSwitchRejected" });
      } else if (message.type === "newSession") {
        this.postMessage({ type: "newSessionRejected" });
      }
      if (shouldPostActionErrorNotice(message.type, noticeRevision, this.noticeRevision)) {
        this.postNotice(actionErrorSummary(message.type), "error", formatError(error));
      }
      this.postState();
    }
  }

  private async reconnect(): Promise<void> {
    this.status = "Connecting to Pi…";
    this.postState();
    try {
      await this.runtime.ensureStarted(vscode.window.activeTextEditor?.document.uri);
      await this.syncMessagesFromPi();
      await this.refreshRecentSessions(false);
      this.historyRecoveryAvailable = false;
      this.status = "Ready";
    } catch (error) {
      const failure = historySyncFailureState(this.runtime.currentState.connected);
      this.status = failure.status;
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.postState();
      throw error;
    }
    this.postState();
  }

  private async refreshHistory(): Promise<void> {
    await this.syncMessagesFromPi();
    await this.refreshRecentSessions(false);
    this.historyRecoveryAvailable = false;
    this.status = "Ready";
    this.postState();
  }

  private async showMoreActions(composerText: string, composerRevision: number): Promise<void> {
    const selected = await vscode.window.showQuickPick(
      [
        { label: "$(history) Request Checkpoints", action: "checkpoints" },
        { label: "$(git-pull-request) Review Changes…", action: "review" },
        { label: "$(list-unordered) Show Review Findings", action: "findings" },
        { label: "$(wrench) Fix Workspace Diagnostics (Preview)", action: "diagnostics" },
        { label: "$(git-pull-request) Review Staged Changes", action: "staged" },
        { label: "$(beaker) Repair Failed Test", action: "repair" },
        { label: "$(debug) Ask Debug Context", action: "debug" },
        { label: "$(history) Resume Session", action: "resume" },
        { label: "$(edit) Rename Session", action: "rename" },
        { label: "$(symbol-method) Change Model", action: "model" },
        { label: "$(lightbulb) Change Thinking Level", action: "thinking" },
        { label: "$(list-selection) Commands and Skills", action: "commands" },
        { label: "$(fold) Compact Context", action: "compact" },
        { label: "$(refresh) Reload Pi Resources", action: "reload" },
        { label: "$(debug-restart) Restart Pi (Current Launch Policy)", action: "restart" },
        { label: "$(git-branch) Browse Session Tree / Fork / Clone", action: "branches" },
        { label: "$(question) Extension UI Compatibility", action: "compatibility" },
        { label: "$(debug-disconnect) Return Pi from Terminal", action: "returnTerminal" },
        { label: "$(export) Export Session", action: "export" },
        { label: "$(import) Import Session Copy", action: "import" },
        { label: "$(share) Share Session", action: "share" },
        { label: "$(sign-in) Sign In to Provider", action: "login" },
        { label: "$(sign-out) Sign Out of Provider", action: "logout" },
        { label: "$(terminal) Open in Terminal", action: "terminal" },
        { label: "$(run) Run Message in Background", action: "background" },
        { label: "$(workspace-trusted) Run Message in Worktree", action: "worktree" },
      ],
      { title: "Pi Session Actions", placeHolder: "Choose a session or advanced action" },
    );
    if (!selected) return;
    if (selected.action === "checkpoints") {
      if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before restoring checkpoints.");
      const release = this.requestGate.acquire();
      this.postState();
      try {
        await this.changeTracker.selectCheckpoint(this.runtime.currentCwd, this.runtime.currentState.sessionId);
      } finally {
        // Even partial restore failures invalidate dependent previews.
        this.proposals.clear();
        this.backgroundAgents.invalidateResults();
        this.changes = this.changeTracker.changes;
        release();
        this.postState();
      }
    } else if (selected.action === "review") await vscode.commands.executeCommand("pi.reviewChanges");
    else if (selected.action === "findings") await vscode.commands.executeCommand("pi.showReviewFindings");
    else if (selected.action === "diagnostics") await vscode.commands.executeCommand("pi.fixWorkspaceDiagnostics");
    else if (selected.action === "staged") await vscode.commands.executeCommand("pi.reviewStagedChanges");
    else if (selected.action === "repair") await vscode.commands.executeCommand("pi.repairFailedTest");
    else if (selected.action === "debug") await vscode.commands.executeCommand("pi.askDebugContext");
    else if (selected.action === "resume") await this.resumeSession();
    else if (selected.action === "rename") await this.nameSession();
    else if (selected.action === "model") await this.pickModel();
    else if (selected.action === "thinking") await this.pickThinkingLevel();
    else if (selected.action === "commands") await this.pickPiCommand();
    else if (selected.action === "compact") await this.compact();
    else if (selected.action === "reload") await this.reloadResources();
    else if (selected.action === "restart") await this.restartResources();
    else if (selected.action === "branches") await this.browseSessionTree(composerRevision);
    else if (selected.action === "compatibility") await vscode.commands.executeCommand("pi.extensionUiCompatibility");
    else if (selected.action === "returnTerminal") await this.returnFromTerminal();
    else if (selected.action === "export") await this.exportSession();
    else if (selected.action === "import") await vscode.commands.executeCommand("pi.importSession");
    else if (selected.action === "share") await vscode.commands.executeCommand("pi.shareSession");
    else if (selected.action === "login") await vscode.commands.executeCommand("pi.signInProvider");
    else if (selected.action === "logout") await vscode.commands.executeCommand("pi.signOutProvider");
    else if (selected.action === "terminal") await this.runtime.openInTerminal();
    else if (selected.action === "background") await this.runBackground(composerText, false, composerRevision);
    else await this.runBackground(composerText, true, composerRevision);
  }

  private async pickModel(): Promise<void> {
    const models = this.runtime.currentState.availableModels;
    const selected = await vscode.window.showQuickPick(
      models.flatMap((model) => {
        const provider = stringValue(model.provider);
        const id = stringValue(model.id);
        if (!provider || !id) return [];
        return [
          {
            label: stringValue(model.name) ?? `${provider}/${id}`,
            description: `${provider}/${id}`,
            provider,
            id,
          },
        ];
      }),
      { title: "Choose Pi Model", matchOnDescription: true },
    );
    if (selected) {
      await this.runtime.setModel(selected.provider, selected.id);
    }
  }

  private async pickThinkingLevel(): Promise<void> {
    const selected = await vscode.window.showQuickPick(this.runtime.currentState.availableThinkingLevels, {
      title: "Choose Pi Thinking Level",
    });
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
      throw new Error(
        "The current model does not support the images in this request. Change the model before retrying.",
      );
    }
    for (const image of retry.images) this.imageAssets.store(image.mimeType, image.data);
    await this.runRequest(
      retry.request,
      retry.contexts,
      retry.images,
      retry.resource,
      retry.instructions,
      retry.policy,
      "retry",
      undefined,
      undefined,
      undefined,
      retry.transcriptAttachments,
    );
  }

  private async queue(kind: "steer" | "followUp", rawText: string, revision: number): Promise<void> {
    const input = parseComposerInput(rawText);
    if (input.kind === "shell") throw new Error("Direct shell cannot be queued. Wait for an idle session.");
    const submission = this.attachments.captureSubmission();
    const resolved = resolveSidebarQueueSubmission(input.text, submission);
    if (!resolved) {
      this.postMessage({ type: "sendRejected" });
      return;
    }
    if (submission.images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error(
        "The current model does not support images. Change the model or remove image attachments before sending.",
      );
    }
    const instructionId = randomUUID();
    this.queuedTranscriptPresentations.set(instructionId, {
      id: instructionId,
      message: {
        id: `pi-queued-${instructionId}`,
        role: "user",
        content: resolved.text,
        ...(submission.transcriptAttachments.length ? { attachments: [...submission.transcriptAttachments] } : {}),
      },
    });
    try {
      await this.runtime.queueInstruction(kind, resolved.message, {
        instructionId,
        images: submission.images,
        resource: submission.resource,
        recoveryText: resolved.text,
        restoreAttachments: submission.transcriptAttachments.length ? submission.restoreConsumed : undefined,
        hasAttachments: submission.transcriptAttachments.length > 0,
        recoveryBytes: submission.recoveryBytes,
      });
    } catch (error) {
      this.queuedTranscriptPresentations.delete(instructionId);
      throw error;
    }
    submission.consumeAccepted();
    this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
  }

  private async sendInNewSession(rawText: string, revision: number): Promise<void> {
    const input = parseComposerInput(rawText);
    if (input.kind === "shell") throw new Error("Open a session before running direct shell from its idle composer.");
    if (await this.sendCompactCommand(rawText, revision)) return;
    const submission = this.attachments.captureSubmission();
    const text = resolveSidebarSubmissionText(input.text, submission);
    if (text.startsWith("/") && (submission.textContexts.length || submission.images.length)) {
      throw new Error("Remove attachments before running a slash command.");
    }
    if (!text) {
      this.postMessage({ type: "sendRejected" });
      return;
    }
    if (text.length > maxInputCharacters)
      throw new Error(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`);
    if (submission.images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error(
        "The current model does not support images. Change the model or remove image attachments before sending.",
      );
    }
    if (this.isForegroundRequestActive())
      throw new Error("Cancel or wait for the active request before starting a new session.");
    if (this.backgroundSubmissionGate.isPending)
      throw new Error("Wait for the background or worktree agent to finish starting before starting a new session.");

    const releaseRequest = this.requestGate.acquire();
    this.postState();
    try {
      await this.runtime.newSession();
      await this.resetConversation("New Pi session", true);
      await this.refreshRecentSessions();
      this.postMessage({ type: "showSessionDetail" });
      await this.runRequest(
        text,
        submission.textContexts,
        submission.images,
        submission.resource,
        undefined,
        undefined,
        "composer",
        undefined,
        () => {
          submission.consumeAccepted();
          this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
        },
        undefined,
        submission.transcriptAttachments,
        true,
      );
    } finally {
      releaseRequest();
      this.postState();
    }
  }

  private async sendCompactCommand(rawText: string, revision: number): Promise<boolean> {
    if (/^\/reload\s*$/.test(rawText.trim())) {
      if (await this.reloadResources())
        this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
      return true;
    }
    if (/^\/vscode-pi-/.test(rawText.trim())) throw new Error("Internal Pi controls must use their host action.");
    const match = /^\/compact(?:\s+([\s\S]*))?$/.exec(rawText.trim());
    if (!match) return false;
    if (this.attachments.summaries.length) throw new Error("Remove attachments before running a slash command.");
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before running a slash command.");
    await this.compact(match[1]?.trim(), () => {
      this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
    });
    return true;
  }

  private async send(rawText: string, revision: number): Promise<void> {
    const input = parseComposerInput(rawText);
    if (input.kind === "shell") {
      await this.sendShell(input.command, input.excludeFromContext, rawText, revision);
      return;
    }
    if (await this.sendCompactCommand(rawText, revision)) return;
    const submission = this.attachments.captureSubmission();
    const text = resolveSidebarSubmissionText(input.text, submission);
    if (!text) {
      this.postMessage({ type: "sendRejected" });
      return;
    }
    if (submission.images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error(
        "The current model does not support images. Change the model or remove image attachments before sending.",
      );
    }
    await this.runRequest(
      text,
      submission.textContexts,
      submission.images,
      submission.resource,
      undefined,
      undefined,
      "composer",
      undefined,
      () => {
        submission.consumeAccepted();
        this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
      },
      undefined,
      submission.transcriptAttachments,
    );
  }

  private async sendShell(
    command: string,
    excludeFromContext: boolean,
    rawText: string,
    revision: number,
  ): Promise<void> {
    if (this.attachments.summaries.length) throw new Error("Remove all attachments before running direct shell.");
    if (this.isForegroundRequestActive() || this.backgroundSubmissionGate.isPending)
      throw new Error("Direct shell requires an idle composer with no conflicting work.");
    const release = this.requestGate.acquire();
    this.retryRequest = undefined;
    this.foregroundCancellable = true;
    this.tools = [];
    this.status = "Awaiting shell approval…";
    this.postState();
    let submitted = false;
    let checkpointCwd = this.runtime.currentCwd;
    let checkpointSessionId: string | undefined;
    let status: "completed" | "cancelled" | "process-exit" = "process-exit";
    try {
      checkpointCwd = await realpath(checkpointCwd);
      const result = await this.runtime.executeShell(
        command,
        excludeFromContext,
        () => {
          submitted = true;
          checkpointSessionId = this.runtime.currentState.sessionId;
          this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: revision });
        },
        async (history) => {
          this.messages = limitSidebarMessages(
            convertPiMessages(history, {
              imageAssets: this.imageAssets,
              knownMessages: this.messages,
              maxMessages,
            }),
            maxMessages,
            maxStoredCharacters,
          );
          await this.persistMessages();
        },
      );
      if (!result) {
        this.status = "Shell not started";
        this.postMessage({ type: "sendRejected" });
        return;
      }
      status = result.cancelled ? "cancelled" : "completed";
      this.status = result.cancelled
        ? "Shell cancelled · Inspect effects"
        : `Shell finished · Exit ${result.exitCode ?? "unknown"}`;
      await this.persistMessages();
    } catch (error) {
      this.status = "Shell execution uncertain · Inspect effects; no automatic retry";
      await this.persistMessages();
      this.postNotice(
        "Shell did not complete reliably. Check history and effects; do not repeat it automatically.",
        "error",
        formatError(error),
      );
      throw error;
    } finally {
      try {
        if (submitted) {
          this.changeTracker.recordShellRequest(checkpointCwd, checkpointSessionId, status);
          this.changes = this.changeTracker.changes;
        }
      } finally {
        this.foregroundCancellable = false;
        release();
        this.postState();
      }
    }
  }

  private async runRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    images: readonly PiRpcImage[],
    resource?: vscode.Uri,
    instructions?: string,
    policy?: AgentRequestPolicy,
    origin: ConversationRequestOrigin = "editor",
    onResponse?: (response: string) => Promise<void> | void,
    onAccepted?: () => void,
    validate?: () => void,
    transcriptAttachments?: readonly TranscriptAttachment[],
    requestGateAlreadyHeld = false,
  ): Promise<string> {
    const text = request.trim();
    const slashCommand = (origin === "composer" || origin === "retry") && text.startsWith("/");
    if (slashCommand && (contexts.length || images.length)) {
      throw new Error("Remove attachments before running a slash command.");
    }
    if (!text) {
      throw new Error("Enter a message for Pi.");
    }
    if (!requestGateAlreadyHeld && this.isForegroundRequestActive()) {
      throw new Error("Pi is already working. Cancel or wait for the active request before starting another one.");
    }
    if (this.backgroundSubmissionGate.isPending) {
      throw new Error("Wait for the background or worktree agent to finish starting before sending another request.");
    }
    if (text.length > maxInputCharacters) {
      throw new Error(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`);
    }

    const behavior = conversationRequestBehavior(origin);
    const retryable = behavior.retryable;
    const releaseRequest = requestGateAlreadyHeld ? () => {} : this.requestGate.acquire();
    this.requestLifecycle.begin();
    this.foregroundCancellable = true;
    this.postState();
    this.trackCurrentRequestChanges = false;
    this.currentRequestSideEffects.reset();
    this.historyRecoveryAvailable = false;
    let responseCaptured = false;
    let synchronizingHistory = false;
    let releaseOperation = () => {};
    try {
      await this.runtime.ensureStarted(resource);
      releaseOperation = acquireOperation(await realpath(this.runtime.currentCwd), "foreground Pi request");
      const submittedTranscriptAttachments = transcriptAttachments ?? [
        ...contexts.flatMap((context) => contextTranscriptAttachment(context.label) ?? []),
        ...images.flatMap((image, index) => {
          const asset = this.imageAssets.store(image.mimeType, image.data);
          if (!asset) return [];
          const fullLabel = `Image ${index + 1}`;
          return [
            {
              type: "image" as const,
              assetId: asset.id,
              label: shortTranscriptLabel(fullLabel),
              fullLabel,
              mimeType: asset.mimeType,
              width: asset.width,
              height: asset.height,
              availability: "available" as const,
            },
          ];
        }),
      ];
      this.retryRequest = retryable
        ? {
            request: text,
            contexts: [...contexts],
            images: [...images],
            resource,
            instructions,
            policy,
            transcriptAttachments: submittedTranscriptAttachments,
          }
        : undefined;
      this.messages = limitSidebarMessages(
        [
          ...this.messages,
          {
            id: randomUUID(),
            role: "user",
            content: text,
            ...(submittedTranscriptAttachments.length ? { attachments: submittedTranscriptAttachments } : {}),
          },
        ],
        maxMessages,
        maxStoredCharacters,
      );
      this.tools = [];
      this.assistantStream = undefined;
      this.status = "Sending to Pi…";
      await this.persistMessages();
      if (shouldTrackConversationChanges(policy)) this.changes = [];
      this.postState();

      const response = await this.runtime.prompt(
        slashCommand ? text : buildAgentPrompt(text, contexts, instructions, policy),
        resource,
        images,
        behavior.clearComposerOnAccepted ? onAccepted : undefined,
        () => {
          this.requestLifecycle.throwIfCancelled();
          validate?.();
          if (shouldTrackConversationChanges(policy)) {
            this.changeTracker.startRequest(this.runtime.currentCwd, this.runtime.currentState.sessionId);
            this.trackCurrentRequestChanges = true;
          }
        },
        origin === "composer" && !onResponse && policy === undefined && !text.startsWith("/"),
      );
      this.foregroundCancellable = false;
      if (this.requestLifecycle.wasCancelled && (response === undefined || typeof response === "string")) {
        throw new Error("Pi request was cancelled.");
      }
      if (response === undefined) {
        if (this.currentRequestSideEffects.mayHaveSideEffects) {
          this.requestLifecycle.completeExecution();
        }
        throw new Error("Pi completed without an assistant response for this request.");
      }
      responseCaptured = true;
      this.requestLifecycle.completeExecution();
      this.retryRequest = undefined;
      if (typeof response !== "string" && this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest("completed");
        this.trackCurrentRequestChanges = false;
      }
      synchronizingHistory = true;
      await this.syncMessagesFromPi();
      await this.refreshRecentSessions(false);
      synchronizingHistory = false;
      if (typeof response === "string") await onResponse?.(response);
      this.status = "Ready";
      this.postState();
      return typeof response === "string" ? response : "";
    } catch (error) {
      if (this.currentRequestSideEffects.mayHaveSideEffects) {
        this.requestLifecycle.completeExecution();
      }
      if (this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest();
        this.trackCurrentRequestChanges = false;
      }
      const message = formatError(error);
      if (!this.requestLifecycle.canRetry) {
        this.retryRequest = undefined;
        if (!responseCaptured) {
          this.historyRecoveryAvailable = false;
          this.status = "Pi stopped after tool execution · Retry unavailable";
          this.postNotice(
            "Pi stopped after tool execution. Retry is disabled because a mutating tool may already have run.",
            "warning",
            message,
          );
        } else if (synchronizingHistory) {
          const failure = historySyncFailureState(this.runtime.currentState.connected);
          this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
          this.status = failure.historyRecoveryAvailable ? "Pi completed · History refresh failed" : failure.status;
          this.postNotice(
            failure.historyRecoveryAvailable
              ? "Pi completed the request, but history refresh failed. Use Refresh history after resolving the problem."
              : "Pi completed the request, but disconnected before history refresh. Reconnect to restore the conversation.",
            "warning",
            message,
          );
        } else {
          this.historyRecoveryAvailable = false;
          this.status = "Pi completed · Follow-up action failed";
          this.postNotice(
            "Pi completed the request, but the follow-up action failed. The request will not be retried.",
            "warning",
            message,
          );
        }
      } else if (this.requestLifecycle.wasCancelled || /cancelled/i.test(message)) {
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
          retryable
            ? "Pi request failed. Retry the message after resolving the problem."
            : "Pi request failed. Run the editor action again to retry.",
          "error",
          message,
        );
      }
      this.postState();
      throw error;
    } finally {
      this.foregroundCancellable = false;
      releaseOperation();
      releaseRequest();
      this.postState();
    }
  }

  private isForegroundRequestActive(): boolean {
    return (
      this.requestGate.isPending ||
      this.runtime.currentState.busy ||
      this.proposals.states.some((proposal) => ["previewing", "applying", "rejecting"].includes(proposal.status))
    );
  }

  private async runBackground(rawText: string, isolated: boolean, composerRevision: number): Promise<void> {
    const input = parseComposerInput(rawText);
    if (input.kind === "shell") throw new Error("Direct shell is available only in the idle session composer.");
    const text = input.text.trim();
    if (!text) {
      throw new Error("Enter a message before starting a background or worktree agent.");
    }
    if (text.length > maxInputCharacters) {
      throw new Error(`Messages are limited to ${maxInputCharacters.toLocaleString()} characters.`);
    }

    const releaseSubmission = this.backgroundSubmissionGate.acquire();
    this.postState();
    try {
      const confirmation = await vscode.window.showWarningMessage(
        isolated
          ? "Start an autonomous Pi agent in a detached Git worktree created from HEAD?"
          : "Start an autonomous Pi agent that can edit the current workspace and run shell commands?",
        { modal: true },
        isolated ? "Start Worktree Agent" : "Start Background Agent",
      );
      if (!confirmation) {
        return;
      }
      const submittedAttachmentIds = this.attachments.values.map((attachment) => attachment.id);
      const contexts = this.attachments.textContexts;
      const images = this.attachments.images;
      await this.backgroundAgents.start(text, contexts, images, this.runtime.currentCwd, isolated);
      this.attachments.consume(submittedAttachmentIds);
      this.postMessage({ type: "clearInput", expectedText: rawText, expectedRevision: composerRevision });
      this.postNotice(isolated ? "Started an isolated worktree agent." : "Started a background agent.", "info");
    } finally {
      releaseSubmission();
      this.postState();
    }
  }

  private async cleanupBackgroundWorktree(id: string): Promise<void> {
    const confirmation = await vscode.window.showWarningMessage(
      "Remove this isolated worktree, including committed or uncommitted results that may not have been imported? This cannot be undone by Pi.",
      { modal: true },
      "Remove Worktree",
    );
    if (confirmation === "Remove Worktree") {
      await this.backgroundAgents.cleanupWorktree(id);
    }
  }

  private async resumeBackground(id: string): Promise<void> {
    if (this.isForegroundRequestActive()) {
      throw new Error("Cancel or wait for the foreground request before resuming a background session.");
    }
    const sessionFile = await this.backgroundAgents.openSession(id);
    await this.runtime.switchSession(sessionFile);
    await this.finishSessionTransition("Background Pi session resumed");
  }

  private async newSession(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postMessage({ type: "newSessionRejected" });
      this.postNotice("Cancel or wait for the active request before starting a new session.", "warning");
      return;
    }
    await this.runtime.newSession();
    await this.resetConversation("New Pi session");
    await this.refreshRecentSessions();
    this.postMessage({ type: "newSessionAccepted" });
  }

  private async deleteSession(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before deleting the session.", "warning");
      return;
    }
    const sessionName = this.runtime.currentState.sessionName;
    const target = sessionName ? `“${sessionName}”` : "this session";
    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${target}? Its persistent Pi session file will be moved to Trash.`,
      { modal: true },
      "Delete Session",
    );
    if (confirmation !== "Delete Session") return;
    const sessionBeforeDelete = this.runtime.currentState;
    this.status = "Deleting session…";
    this.postState();
    const outcome = await deleteConversationWithTrashFallback({
      moveToTrash: () => this.runtime.deleteSession(),
      confirmPermanent: async () => {
        this.status = "Session kept · Trash unavailable";
        this.postNotice("Trash is unavailable for this file provider. The session was kept.", "warning");
        this.postState();
        return (
          (await vscode.window.showWarningMessage(
            `Trash is unavailable. Permanently delete ${target}? This cannot be undone.`,
            { modal: true },
            "Delete Permanently",
          )) === "Delete Permanently"
        );
      },
      deletePermanently: async (trashError) => {
        this.status = "Permanently deleting session…";
        this.postState();
        await this.runtime.deleteSessionPermanently(trashError.sessionFile);
      },
    });
    if (outcome.status === "deleted") {
      const next = this.runtime.currentState.connected ? "New Pi session" : "Reconnect available";
      await this.resetConversation(
        `${outcome.permanently ? "Session permanently deleted" : "Session deleted"} · ${next}`,
      );
      await this.refreshRecentSessions();
      return;
    }

    const status = outcome.status === "failed" ? "Session kept · Delete failed" : "Session kept · Trash unavailable";
    if (outcome.status === "failed") {
      this.postNotice(
        outcome.permanently
          ? "The session could not be permanently deleted and was kept."
          : "The session could not be moved to Trash and was kept.",
        "error",
        formatError(outcome.error),
      );
    }
    if (runtimeSessionIdentityChanged(sessionBeforeDelete, this.runtime.currentState)) {
      await this.resetConversation(`${status} · Replacement Pi session`);
    } else {
      this.status = status;
      this.postState();
    }
  }

  private async resetConversation(status: string, preserveAttachments = false): Promise<void> {
    this.historySyncRevision += 1;
    this.changeTracker.resetSession();
    this.queuedTranscriptPresentations.clear();
    this.assistantStream = undefined;
    this.messages = [];
    this.tools = [];
    this.changes = [];
    this.proposals.clear();
    this.retryRequest = undefined;
    this.historyRecoveryAvailable = false;
    this.trackCurrentRequestChanges = false;
    if (!preserveAttachments) this.attachments.clear();
    await this.persistMessages();
    this.status = status;
    this.postState();
  }

  public async reloadResources(): Promise<boolean> {
    if (this.attachments.summaries.length) throw new Error("Remove attachments before reloading Pi resources.");
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before reloading resources.");
    const reloaded = await this.runtime.reloadResources();
    if (reloaded) {
      this.attachments.clearPins();
      this.proposals.clear();
      this.tools = [];
      this.retryRequest = undefined;
      this.status = "Pi resources reloaded";
      this.postState();
    }
    return reloaded;
  }

  public async restartResources(): Promise<void> {
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before restarting.");
    if (await this.runtime.restartResources()) {
      this.proposals.clear();
      this.tools = [];
      this.retryRequest = undefined;
      this.attachments.clearPins();
      await this.syncMessagesFromPi();
      this.status = "Pi restarted · No requests replayed";
      this.postState();
    }
  }

  public async returnFromTerminal(): Promise<void> {
    if (await this.runtime.returnFromTerminal()) {
      this.attachments.clearPins();
      await this.finishSessionTransition("Pi returned from terminal", true);
    }
  }

  public async browseSessionTree(revision?: number): Promise<void> {
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before branching.");
    const result = await this.runtime.chooseSessionBranch(async (tree) => {
      const selection = await vscode.window.showQuickPick(
        [
          { label: "Clone active branch into a new session", entryId: undefined, clone: true },
          ...tree.entries.map((entry) => ({
            label: `${"  ".repeat(Math.min(entry.depth, 12))}${entry.id === tree.leafId ? "● " : ""}${entry.role ?? entry.type}: ${entry.text.slice(0, 160) || "(no text)"}`,
            description: entry.label,
            detail: entry.id,
            entryId: entry.id,
            clone: false,
          })),
        ],
        { title: "Pi session tree · Does not restore workspace files or Git state", matchOnDescription: true },
      );
      if (!selection) return undefined;
      const action = selection.clone
        ? "clone"
        : await vscode.window.showQuickPick(["Navigate without summary", "Fork from user message"], {
            title: "Branch operation · No model request or branch summary",
          });
      if (!action) return undefined;
      return {
        action: action === "clone" ? "clone" : action === "Fork from user message" ? "fork" : "navigate",
        targetId: selection.entryId,
      };
    });
    if (result.cancelled) return;
    await this.finishSessionTransition("Pi branch selected · Workspace files unchanged");
    if (result.text) this.postMessage({ type: "restoreBranchDraft", text: result.text, expectedRevision: revision });
  }

  private async finishSessionTransition(status: string, preserveAttachments = false): Promise<void> {
    await this.resetConversation(status, preserveAttachments);
    try {
      await this.syncMessagesFromPi();
      await this.refreshRecentSessions(false);
    } catch (error) {
      this.historyRecoveryAvailable = this.runtime.currentState.connected;
      this.postNotice(
        "Session changed, but history could not refresh. Do not repeat the operation.",
        "warning",
        formatError(error),
      );
    }
    this.postState();
    this.postMessage({ type: "showSessionDetail" });
  }

  private async compact(customInstructions?: string, onAccepted?: () => void): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before compacting the session.", "warning");
      return;
    }
    this.status = "Compacting context…";
    this.postState();
    await this.runtime.compact(customInstructions, onAccepted);
    try {
      await this.syncMessagesFromPi();
      this.historyRecoveryAvailable = false;
      this.status = "Context compacted";
    } catch (error) {
      const failure = historySyncFailureState(this.runtime.currentState.connected);
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.status = "Context compacted · History refresh failed";
      this.postNotice(
        failure.historyRecoveryAvailable
          ? "Context was compacted, but history refresh failed. Use Refresh history. Do not repeat compaction."
          : "Context was compacted, but Pi disconnected before history refresh. Reconnect. Do not repeat compaction.",
        "warning",
        formatError(error),
      );
    }
    this.postState();
  }

  private async revertChange(id: string): Promise<void> {
    const change = this.changes.find((item) => item.id === id);
    if (!change) {
      throw new Error("The selected Pi change is no longer available.");
    }
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before restoring a file.");
    const release = this.requestGate.acquire();
    this.postState();
    try {
      const confirmation = await vscode.window.showWarningMessage(
        `Revert Pi's change to ${change.label}?`,
        { modal: true },
        "Revert File",
      );
      if (confirmation !== "Revert File") return;
      this.changes = this.changeTracker.revert(id);
    } finally {
      this.proposals.clear();
      this.backgroundAgents.invalidateResults();
      this.changes = this.changeTracker.changes;
      release();
      this.postState();
    }
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
    await this.refreshRecentSessions();
  }

  private async switchRecentSession(id: string): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postMessage({ type: "sessionSwitchRejected" });
      this.postNotice("Cancel or wait for the active request before switching sessions.", "warning");
      return;
    }
    const selected = this.recentSessions.find((session) => session.key === id);
    if (!selected)
      throw new Error("The selected session is no longer in the recent session list. Refresh Sessions and try again.");
    if (selected.path === this.runtime.currentState.sessionFile) {
      this.postState();
      return;
    }
    await this.switchToSession(selected.path, "Pi session resumed");
  }

  private async switchToSession(sessionFile: string, status: string): Promise<void> {
    await this.runtime.switchSession(sessionFile);
    await this.finishSessionTransition(status);
  }

  private async resumeSession(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before switching sessions.", "warning");
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
    await this.switchToSession(session.fsPath, "Pi session resumed");
  }

  private async pickPiCommand(): Promise<void> {
    const commands = this.runtime.currentState.commands
      .filter((command) => typeof command.name === "string" && !command.name.startsWith("vscode-pi-"))
      .map((command) => ({
        name: typeof command.name === "string" ? command.name : undefined,
        description: typeof command.description === "string" ? command.description : undefined,
        source: typeof command.source === "string" ? command.source : undefined,
      }))
      .filter((command): command is { name: string; description: string | undefined; source: string | undefined } =>
        Boolean(command.name),
      );
    if (commands.length === 0) {
      this.postNotice("Pi did not discover any extension commands, prompt templates, or skills.", "info");
      return;
    }
    const selected = await vscode.window.showQuickPick(
      commands.map((command) => ({
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
    await vscode.commands.executeCommand("pi.exportSession");
  }

  private async refreshImportedSession(): Promise<void> {
    await this.resetConversation("Pi session imported");
    await this.syncMessagesFromPi(true);
    await this.refreshRecentSessions(false);
    this.status = "Pi session imported";
    this.postState();
    this.postMessage({ type: "showSessionDetail" });
  }

  private handleRuntimeEvent(event: PiRpcEvent): void {
    if (event.type === "session_imported") {
      void this.refreshImportedSession().catch(() => {
        this.postNotice(
          "The imported session is active, but history could not be refreshed. Refresh Pi before sending.",
          "warning",
        );
      });
      return;
    }
    if (event.type === "resources_reloaded" && (event.action === "reload" || event.action === "restart")) {
      this.attachments.clearPins();
      this.proposals.clear();
      this.tools = [];
      this.retryRequest = undefined;
      this.assistantStream = undefined;
      this.historySyncRevision += 1;
    } else if (
      event.type === "shell_execution" &&
      typeof event.id === "string" &&
      typeof event.command === "string" &&
      typeof event.excludeFromContext === "boolean"
    ) {
      const content = shellMessageText(
        event.command,
        event.excludeFromContext,
        parseShellResult(event.result),
        event.state === "running" ? "running" : event.state === "uncertain" ? "uncertain" : "finished",
      );
      const message: SidebarMessage = { id: `shell-${event.id}`, role: "shell", content };
      const existing = this.messages.findIndex((candidate) => candidate.id === message.id);
      if (existing >= 0) this.messages[existing] = message;
      else this.messages.push(message);
      this.messages = limitSidebarMessages(this.messages, maxMessages, maxStoredCharacters);
      this.status =
        event.state === "running"
          ? "Running shell…"
          : event.state === "uncertain"
            ? "Shell execution uncertain · Inspect effects"
            : "Shell finished";
    } else if (event.type === "queue_instruction_delivered") {
      const instruction = isRecord(event.instruction) ? event.instruction : undefined;
      const id = instruction ? stringValue(instruction.id) : undefined;
      const text = instruction ? stringValue(instruction.text) : undefined;
      if (id && text !== undefined) {
        const presentation = this.queuedTranscriptPresentations.get(id);
        const message = presentation?.message ?? { id: `pi-queued-${id}`, role: "user" as const, content: text };
        this.queuedTranscriptPresentations.delete(id);
        if (!this.messages.some((candidate) => candidate.id === message.id)) {
          this.messages = limitSidebarMessages([...this.messages, message], maxMessages, maxStoredCharacters);
          void this.persistMessages();
        }
      }
    } else if (event.type === "agent_start") {
      this.historySyncRevision += 1;
      this.status = "Pi is working…";
      this.tools = [];
    } else if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      this.historySyncRevision += 1;
      this.assistantStream = message?.role === "assistant" ? this.createAssistantStream(message) : undefined;
    } else if (event.type === "message_update") {
      const update = isRecord(event.assistantMessageEvent) ? event.assistantMessageEvent : undefined;
      const message = this.assistantStream?.update(update);
      if (message) this.upsertAssistantMessage(message);
      if (update?.type === "thinking_delta") this.status = "Pi is thinking…";
    } else if (event.type === "message_end") {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === "assistant") {
        const stream = this.assistantStream ?? this.createAssistantStream(message);
        this.upsertAssistantMessage(stream.complete(message.content));
        this.assistantStream = undefined;
      }
    } else if (event.type === "tool_execution_start") {
      const toolName = stringValue(event.toolName) ?? "tool";
      if (this.trackCurrentRequestChanges) {
        this.changeTracker.captureToolEvent(event);
        this.currentRequestSideEffects.record(undefined, toolName);
      }
      this.upsertTool({
        id: stringValue(event.toolCallId) ?? randomUUID(),
        name: toolName,
        status: "running",
        summary: toolOperationSummary(toolName, event.args),
        input: boundToolText(safeJson(event.args, Number.MAX_SAFE_INTEGER), maxToolOutputCharacters),
      });
      this.status = `Running ${stringValue(event.toolName) ?? "tool"}…`;
    } else if (event.type === "tool_execution_update") {
      const id = stringValue(event.toolCallId);
      const tool = this.tools.find((activity) => activity.id === id);
      if (tool) {
        this.updateTool(tool.id, { output: extractToolText(event.partialResult, maxToolOutputCharacters, tool.name) });
      }
    } else if (event.type === "tool_execution_end") {
      const id = stringValue(event.toolCallId);
      const tool = this.tools.find((activity) => activity.id === id);
      if (tool) {
        this.updateTool(tool.id, {
          status: event.isError ? "error" : "success",
          output: extractToolText(event.result, maxToolOutputCharacters, tool.name),
        });
      }
    } else if (event.type === "compaction_start") {
      this.status = "Compacting Pi context…";
    } else if (event.type === "auto_retry_start") {
      this.assistantStream = undefined;
      this.status = "Retrying Pi request…";
    } else if (event.type === "agent_settled") {
      this.status = this.requestLifecycle.wasCancelled ? "Cancelling Pi request…" : "Finishing Pi response…";
      this.assistantStream = undefined;
      this.queuedTranscriptPresentations.clear();
      if (this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest(this.requestLifecycle.wasCancelled ? "cancelled" : "completed");
        this.trackCurrentRequestChanges = false;
      }
    } else if (event.type === "extension_ui_reset") {
      this.extensionUi.clear();
    } else if (event.type === "process_exit") {
      this.extensionUi.clear();
      this.assistantStream = undefined;
      this.queuedTranscriptPresentations.clear();
      if (this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest("process-exit");
        this.trackCurrentRequestChanges = false;
      }
      this.status = "Disconnected · Reconnect available";
    } else if (event.type === "runtime_warning" || event.type === "protocol_error") {
      const details = stringValue(event.message) || "No additional diagnostic information was supplied.";
      this.postNotice(runtimeNoticeSummary(event), "warning", details);
    } else if (event.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(event).catch((error) => {
        this.postNotice("The Pi extension UI request failed.", "error", formatError(error));
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

    // Dialogs use origin-bound ExtensionUiDialogs; keyed updates expect no response.
    if (method === "setStatus" || method === "setWidget") {
      if (this.extensionUi.update(event)) this.scheduleState();
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

  private createAssistantStream(message: Record<string, unknown>): SidebarAssistantStream {
    const timestamp = message.timestamp;
    const prefix =
      typeof timestamp === "number" && Number.isSafeInteger(timestamp) ? `pi-assistant-${timestamp}-` : undefined;
    const occurrence = this.messages.reduce((next, candidate) => {
      if (!prefix || !candidate.id.startsWith(prefix)) return next;
      const previous = Number(candidate.id.slice(prefix.length));
      return Number.isSafeInteger(previous) ? Math.max(next, previous + 1) : next;
    }, 0);
    return new SidebarAssistantStream(prefix ? `${prefix}${occurrence}` : randomUUID(), maxStoredCharacters);
  }

  private upsertAssistantMessage(message: SidebarMessage): void {
    const existing = this.messages.some((candidate) => candidate.id === message.id);
    const messages = existing
      ? this.messages.flatMap((candidate) =>
          candidate.id === message.id ? (message.content || message.thinking?.length ? [message] : []) : [candidate],
        )
      : message.content || message.thinking?.length
        ? [...this.messages, message]
        : this.messages;
    this.messages = limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
  }

  private upsertTool(activity: ToolActivity): void {
    this.tools = [...this.tools.filter((tool) => tool.id !== activity.id), activity].slice(-maxToolActivities);
  }

  private updateTool(id: string, changes: Partial<ToolActivity>): void {
    this.tools = this.tools.map((tool) => (tool.id === id ? { ...tool, ...changes } : tool));
  }

  private async syncMessagesFromPi(verifiedImport = false): Promise<void> {
    if (!this.runtime.currentState.connected) {
      const failure = historySyncFailureState(false);
      this.status = failure.status;
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.postState();
      throw new Error("Pi disconnected before conversation history could be synchronized.");
    }
    if (verifiedImport ? this.requestGate.isPending : this.runtime.currentState.busy) {
      throw new Error("Wait for Pi to finish before refreshing conversation history.");
    }
    const revision = ++this.historySyncRevision;
    try {
      const values = await this.runtime.getMessages();
      if (revision !== this.historySyncRevision || (verifiedImport ? this.requestGate.isPending : this.runtime.currentState.busy)) return;
      const messages = convertPiMessages(values, {
        imageAssets: this.imageAssets,
        knownMessages: this.messages,
        maxMessages,
        maxCharacters: maxStoredCharacters,
      });
      if (messages.length > 0 || this.runtime.currentState.sessionId) {
        this.messages = limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
        await this.persistMessages();
      }
      this.historyRecoveryAvailable = false;
      this.postState();
    } catch (error) {
      if (revision !== this.historySyncRevision) return;
      const failure = historySyncFailureState(this.runtime.currentState.connected);
      this.status = failure.status;
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.postState();
      throw error;
    }
  }

  private async refreshRecentSessions(post = true): Promise<void> {
    const revision = ++this.sessionRefreshRevision;
    const runtime = this.runtime.currentState;
    const activeSessionFile = runtime.sessionFile;
    if (!activeSessionFile) {
      this.recentSessions = [];
      if (post) this.postState();
      return;
    }

    try {
      const sessions = await listRecentPiSessions(activeSessionFile, this.runtime.currentCwd);
      if (
        revision !== this.sessionRefreshRevision ||
        activeSessionFile !== this.runtime.currentState.sessionFile ||
        !sessions
      )
        return;
      this.recentSessions = sessions.some((session) => session.path === activeSessionFile)
        ? sessions
        : [
            {
              key: piSessionKey(activeSessionFile),
              path: activeSessionFile,
              sessionId: runtime.sessionId ?? "",
              title: runtime.sessionName?.trim() || "New conversation",
              updatedAt: Date.now(),
            },
            ...sessions,
          ].slice(0, 100);
    } catch {
      if (revision !== this.sessionRefreshRevision) return;
      // Keep the previous index on transient filesystem failures.
    }
    if (post) this.postState();
  }

  private async persistMessages(): Promise<void> {
    try {
      await this.context.workspaceState.update(storageKey, persistableSidebarMessages(this.messages));
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
    const requestBusy = this.isForegroundRequestActive();
    const estimate = this.attachments.estimate;
    const attachmentSummaries = this.attachments.summaries;
    const visibleMessages = sidebarMessagesForWebview(
      this.messages,
      (assetId) => this.imageAssets.has(assetId) || this.imageAssetDelivery.has(assetId),
    );
    const html = this.markdownRenderer.renderBatch(
      visibleMessages.map((message) => (message.role === "shell" ? "" : message.content)),
    );
    const messages = visibleMessages.map((message, index) => ({
      ...message,
      html: message.role === "shell" ? `<pre class="shell-output">${escapeHtml(message.content)}</pre>` : html[index],
    }));
    this.postMessage({
      type: "state",
      messages,
      tools: this.tools,
      extensionUi: this.extensionUi.state,
      changes: this.changes,
      proposals: this.proposals.states,
      backgroundTasks: this.backgroundAgents.states,
      status: this.status,
      attachments: attachmentSummaries,
      attachmentEstimate: {
        characters: estimate.characters,
        bytes: estimate.bytes,
        estimatedTextTokens: estimate.estimatedTextTokens,
        imageUsage: estimate.imageUsage,
      },
      imageSupported: modelSupportsImages(this.runtime.currentState.model),
      retryAvailable: Boolean(this.retryRequest) && !requestBusy,
      historyRecoveryAvailable: this.historyRecoveryAvailable && !requestBusy,
      backgroundSubmissionPending: this.backgroundSubmissionGate.isPending,
      sessions: this.recentSessions.map((session) => ({
        id: session.key,
        title: session.title,
        updatedAt: session.updatedAt,
        current: session.path === this.runtime.currentState.sessionFile,
      })),
      runtime: { ...this.runtime.currentState, busy: requestBusy, cancellable: this.foregroundCancellable },
    });
    this.deliverReferencedImageAssets(
      messages,
      attachmentSummaries.flatMap((attachment) => (attachment.assetId ? [attachment.assetId] : [])),
    );
  }

  private deliverReferencedImageAssets(
    messages: readonly SidebarMessage[],
    composerAssetIds: readonly string[] = [],
  ): void {
    const webview = this.view?.webview;
    if (!webview) return;
    const referenced = new Set([
      ...messages.flatMap((message) =>
        (message.attachments ?? []).flatMap((attachment) => (attachment.type === "image" ? [attachment.assetId] : [])),
      ),
      ...composerAssetIds,
    ]);
    for (const asset of this.imageAssetDelivery.pending(referenced, this.imageAssets)) {
      void webview
        .postMessage({
          type: "imageAsset",
          id: asset.id,
          mimeType: asset.mimeType,
          data: asset.data,
          byteLength: asset.byteLength,
          width: asset.width,
          height: asset.height,
        })
        .then((delivered) => {
          if (!delivered && this.view?.webview === webview) this.imageAssetDelivery.retry(asset.id);
        });
    }
  }

  private postNotice(message: string, level: "info" | "warning" | "error", details?: string): void {
    this.noticeRevision += 1;
    this.noticeDetails = details?.slice(0, maxToolOutputCharacters);
    this.postMessage({ type: "notice", message, level, detailsAvailable: Boolean(this.noticeDetails) });
  }

  private postMessage(message: Record<string, unknown>): void {
    void this.view?.webview.postMessage(message);
  }
}

function actionErrorSummary(action: WebviewMessage["type"]): string {
  if (action === "queueInstruction")
    return "Pi could not confirm queued message delivery. Inspect history and recovered drafts before resending.";
  if (action === "send" || action === "sendNewSession" || action === "retry")
    return "Pi could not accept the message. Review details, then retry when safe.";
  if (action === "reconnect") return "Pi could not reconnect. Review details and try again.";
  if (action === "refreshHistory") return "Conversation history could not be refreshed. Review details and try again.";
  if (action === "deleteSession") return "The session could not be deleted and was kept.";
  if (action === "cancel") return "Pi could not confirm cancellation. Review details before continuing.";
  return "The Pi action failed. Review details and try again.";
}
