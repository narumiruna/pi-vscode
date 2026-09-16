import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { acquireOperation } from "./operationLocks";
import { WorkflowDocuments } from "./workflowUi";
import { homedir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { BackgroundAgentManager } from "./backgroundAgents";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  ConversationSideEffectTracker,
  ExclusiveOperationGate,
  conversationRequestBehavior,
  shouldTrackConversationChanges,
  type ConversationRequestOptions,
  type ConversationRequestOrigin,
  type EditProposalInput,
  type PiConversationController,
} from "./conversationController";
import { EditProposalStore } from "./editProposals";
import { WorkspaceChangeTracker, type TrackedFileChange } from "./changeTracker";
import { getSidebarHtml } from "./sidebarHtml";
import { renderSafeMarkdown } from "./markdown";
import { buildAgentPrompt, type AgentRequestPolicy, type ChatReferenceContext } from "./prompts";
import { deleteConversationWithTrashFallback, runtimeSessionIdentityChanged, type PiRuntimeManager } from "./piRuntime";
import type { PiRpcEvent, PiRpcImage } from "./piRpcClient";
import { resolveSidebarSubmissionText, SidebarAttachmentManager } from "./sidebarAttachments";
import { ImageAssetCache, ImageAssetDeliveryTracker } from "./imageAssets";
import { listRecentPiSessions, piSessionKey, type PiSessionSummary } from "./sessionHistory";
import {
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
  type WebviewMessage,
} from "./sidebarHelpers";
import {
  contextTranscriptAttachment,
  historySyncFailureState,
  limitSidebarMessages,
  persistableSidebarMessages,
  sidebarMessagesForWebview,
  shortTranscriptLabel,
  type SidebarMessage,
  type TranscriptAttachment,
} from "./sidebarState";

const viewId = "picode.chatView";
const storageKey = "picode.sidebar.messages.v1";
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
  readonly output?: string;
}

export function registerPiCodeSidebar(
  context: vscode.ExtensionContext,
  runtime: PiRuntimeManager,
): PiConversationController {
  const backgroundAgents = new BackgroundAgentManager(context);
  const changeTracker = new WorkspaceChangeTracker();
  const provider = new PiCodeChatViewProvider(context, runtime, changeTracker, backgroundAgents);
  context.subscriptions.push(
    backgroundAgents,
    changeTracker,
    provider,
    vscode.workspace.registerTextDocumentContentProvider("picode-checkpoint", changeTracker),
    vscode.window.registerWebviewViewProvider(viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("picode.openChat", async () => {
      await vscode.commands.executeCommand(`${viewId}.focus`);
    }),
  );
  return provider;
}

class PiCodeChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable, PiConversationController {
  private readonly disposables: vscode.Disposable[] = [];
  private view: vscode.WebviewView | undefined;
  private messages: SidebarMessage[];
  private tools: ToolActivity[] = [];
  private changes: TrackedFileChange[] = [];
  private readonly proposals: EditProposalStore;
  private readonly imageAssets = new ImageAssetCache({ maxImageBytes, maxTotalBytes: maxImageAssetCacheBytes, maxAssets: maxImageAssets });
  private readonly imageAssetDelivery = new ImageAssetDeliveryTracker();
  private readonly attachments: SidebarAttachmentManager;
  private readonly requestGate = new ConversationRequestGate();
  private readonly backgroundSubmissionGate = new ExclusiveOperationGate(
    "A background or worktree agent is already starting. Wait for it to finish starting before submitting another one.",
  );
  private readonly requestLifecycle = new ConversationRequestLifecycle();
  private status = "Ready";
  private trackCurrentRequestChanges = false;
  private readonly currentRequestSideEffects = new ConversationSideEffectTracker(this.requestLifecycle);
  private historyRecoveryAvailable = false;
  private retryRequest: {
    readonly request: string;
    readonly contexts: readonly ChatReferenceContext[];
    readonly images: readonly PiRpcImage[];
    readonly resource?: vscode.Uri;
    readonly instructions?: string;
    readonly policy?: AgentRequestPolicy;
    readonly transcriptAttachments: readonly TranscriptAttachment[];
  } | undefined;
  private streamingAssistantId: string | undefined;
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
    this.messages = restoreMessages(context.workspaceState.get<unknown>(storageKey), maxMessages, maxStoredCharacters);
    this.disposables.push(
      runtime.onEvent(event => this.handleRuntimeEvent(event)),
      runtime.onDidChangeState(() => this.scheduleState()),
      backgroundAgents.onDidChange(() => this.scheduleState()),
    );
  }

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    this.imageAssetDelivery.reset();
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
    this.attachments.dispose();
    this.imageAssets.clear();
  }

  public async sendRequest(
    request: string,
    contexts: readonly ChatReferenceContext[],
    options: ConversationRequestOptions = {},
  ): Promise<string> {
    await vscode.commands.executeCommand(`${viewId}.focus`);
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
      contexts.flatMap(context => contextTranscriptAttachment(context.label) ?? []),
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

    const noticeRevision = this.noticeRevision;
    try {
      switch (message.type) {
        case "ready":
          this.postState();
          break;
        case "send":
          await this.send(message.text, message.revision);
          break;
        case "queueInstruction":
          await this.runtime.queueInstruction(message.kind, message.text);
          this.postMessage({ type: "clearInput", expectedText: message.text, expectedRevision: message.revision });
          break;
        case "clearQueue":
          await this.runtime.clearInstructions();
          break;
        case "inspectQueue": {
          const documents = new WorkflowDocuments();
          const state = this.runtime.currentState;
          try { await documents.inspect("Pi pending queue snapshot", `Session ${state.sessionId ?? "unknown"}; captured ${new Date().toISOString()}. Pending state can change while inspecting; not delivery evidence.\n\n${JSON.stringify(state.queue ?? { steering: [], followUp: [] }, null, 2)}`); }
          finally { documents.dispose(); }
          break;
        }
        case "recoverQueue": {
          const picked = await vscode.window.showQuickPick((this.runtime.currentState.recoveredDrafts ?? []).map(draft => ({ label: draft.text.slice(0, 150), description: draft.uncertain ? "Delivery uncertain — inspect history before resending" : "Cleared before delivery", draft })), { title: "Recovered queue drafts (never replayed automatically)" });
          if (picked) this.postMessage({ type: "appendDraft", text: picked.draft.text, expectedRevision: message.revision });
          break;
        }
        case "cancel":
          this.requestLifecycle.cancel();
          await this.runtime.abort();
          this.status = "Cancelled · Ready to retry";
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
            const choices = await vscode.window.showQuickPick(this.proposals.hunkChoices(message.id), { title: "Choose edit hunks · changing selection invalidates Preview", canPickMany: true });
            if (choices) this.proposals.select(message.id, choices.map(choice => choice.id));
          } else {
            const release = acquireOperation(await realpath(this.runtime.currentCwd), "edit proposal action");
            try { await this.proposals.handleAction(message.id, message.action); } finally { release(); }
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
      if (message.type === "send" || message.type === "queueInstruction") {
        this.postMessage({ type: "sendRejected" });
      } else if (message.type === "switchRecentSession") {
        this.postMessage({ type: "sessionSwitchRejected" });
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
        { label: "$(git-pull-request) Review Staged Changes", action: "staged" },
        { label: "$(beaker) Repair Failed Test", action: "repair" },
        { label: "$(debug) Ask Debug Context", action: "debug" },
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
    if (selected.action === "checkpoints") {
      if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before restoring checkpoints.");
      const release = this.requestGate.acquire();
      this.postState();
      try { await this.changeTracker.selectCheckpoint(this.runtime.currentCwd, this.runtime.currentState.sessionId); }
      finally {
        // Even partial restore failures invalidate dependent previews.
        this.proposals.clear(); this.backgroundAgents.invalidateResults(); this.changes = this.changeTracker.changes;
        release(); this.postState();
      }
    }
    else if (selected.action === "staged") await vscode.commands.executeCommand("picode.reviewStagedChanges");
    else if (selected.action === "repair") await vscode.commands.executeCommand("picode.repairFailedTest");
    else if (selected.action === "debug") await vscode.commands.executeCommand("picode.askDebugContext");
    else if (selected.action === "resume") await this.resumeSession();
    else if (selected.action === "rename") await this.nameSession();
    else if (selected.action === "model") await this.pickModel();
    else if (selected.action === "thinking") await this.pickThinkingLevel();
    else if (selected.action === "commands") await this.pickPiCommand();
    else if (selected.action === "compact") await this.compact();
    else if (selected.action === "export") await this.exportSession();
    else if (selected.action === "terminal") await this.runtime.openInTerminal();
    else if (selected.action === "background") await this.runBackground(composerText, false, composerRevision);
    else await this.runBackground(composerText, true, composerRevision);
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

  private async send(rawText: string, revision: number): Promise<void> {
    const submission = this.attachments.captureSubmission();
    const text = resolveSidebarSubmissionText(rawText, submission);
    if (!text) return;
    if (submission.images.length > 0 && !modelSupportsImages(this.runtime.currentState.model)) {
      throw new Error("The current model does not support images. Change the model or remove image attachments before sending.");
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
  ): Promise<string> {
    const text = request.trim();
    if (!text) {
      throw new Error("Enter a message for Pi.");
    }
    if (this.isForegroundRequestActive()) {
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
    const releaseRequest = this.requestGate.acquire();
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
        ...contexts.flatMap(context => contextTranscriptAttachment(context.label) ?? []),
        ...images.flatMap((image, index) => {
          const asset = this.imageAssets.store(image.mimeType, image.data);
          if (!asset) return [];
          const fullLabel = `Image ${index + 1}`;
          return [{ type: "image" as const, assetId: asset.id, label: shortTranscriptLabel(fullLabel), fullLabel, mimeType: asset.mimeType, width: asset.width, height: asset.height, availability: "available" as const }];
        }),
      ];
      this.retryRequest = retryable
        ? { request: text, contexts: [...contexts], images: [...images], resource, instructions, policy, transcriptAttachments: submittedTranscriptAttachments }
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
      this.streamingAssistantId = undefined;
      this.status = "Sending to Pi…";
      await this.persistMessages();
      if (shouldTrackConversationChanges(policy)) this.changes = [];
      this.postState();

      const response = await this.runtime.prompt(
        buildAgentPrompt(text, contexts, instructions, policy),
        resource,
        images,
        behavior.clearComposerOnAccepted ? onAccepted : undefined,
        () => {
          this.requestLifecycle.throwIfCancelled(); validate?.();
          if (shouldTrackConversationChanges(policy)) {
            this.changeTracker.startRequest(this.runtime.currentCwd, this.runtime.currentState.sessionId);
            this.trackCurrentRequestChanges = true;
          }
        },
        origin === "composer" && !onResponse && policy === undefined && !text.startsWith("/"),
      );
      this.foregroundCancellable = false;
      if (this.requestLifecycle.wasCancelled) {
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
      synchronizingHistory = true;
      await this.syncMessagesFromPi();
      await this.refreshRecentSessions(false);
      synchronizingHistory = false;
      await onResponse?.(response);
      this.status = "Ready";
      this.postState();
      return response;
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
          this.postNotice("Pi completed the request, but the follow-up action failed. The request will not be retried.", "warning", message);
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
          retryable ? "Pi request failed. Retry the message after resolving the problem." : "Pi request failed. Run the editor action again to retry.",
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
    return this.requestGate.isPending || this.runtime.currentState.busy || this.proposals.states.some(proposal => ["previewing", "applying", "rejecting"].includes(proposal.status));
  }

  private async runBackground(rawText: string, isolated: boolean, composerRevision: number): Promise<void> {
    const text = rawText.trim();
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
      const submittedAttachmentIds = this.attachments.values.map(attachment => attachment.id);
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
    this.attachments.clear();
    this.proposals.clear();
    this.retryRequest = undefined;
    await this.syncMessagesFromPi();
    await this.refreshRecentSessions(false);
    this.status = "Background Pi session resumed";
    this.postState();
  }

  private async newSession(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before starting a new session.", "warning");
      return;
    }
    await this.runtime.newSession();
    await this.resetConversation("New Pi session");
    await this.refreshRecentSessions();
  }

  private async deleteSession(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before deleting the conversation.", "warning");
      return;
    }
    const sessionName = this.runtime.currentState.sessionName;
    const target = sessionName ? `“${sessionName}”` : "this conversation";
    const confirmation = await vscode.window.showWarningMessage(
      `Delete ${target}? Its persistent Pi session will be moved to Trash.`,
      { modal: true },
      "Delete Conversation",
    );
    if (confirmation !== "Delete Conversation") return;
    const sessionBeforeDelete = this.runtime.currentState;
    this.status = "Deleting conversation…";
    this.postState();
    const outcome = await deleteConversationWithTrashFallback({
      moveToTrash: () => this.runtime.deleteSession(),
      confirmPermanent: async () => {
        this.status = "Conversation kept · Trash unavailable";
        this.postNotice("Trash is unavailable for this file provider. The conversation was kept.", "warning");
        this.postState();
        return await vscode.window.showWarningMessage(
          `Trash is unavailable. Permanently delete ${target}? This cannot be undone.`,
          { modal: true },
          "Delete Permanently",
        ) === "Delete Permanently";
      },
      deletePermanently: async trashError => {
        this.status = "Permanently deleting conversation…";
        this.postState();
        await this.runtime.deleteSessionPermanently(trashError.sessionFile);
      },
    });
    if (outcome.status === "deleted") {
      const next = this.runtime.currentState.connected ? "New Pi session" : "Reconnect available";
      await this.resetConversation(`${outcome.permanently ? "Conversation permanently deleted" : "Conversation deleted"} · ${next}`);
      await this.refreshRecentSessions();
      return;
    }

    const status = outcome.status === "failed" ? "Conversation kept · Delete failed" : "Conversation kept · Trash unavailable";
    if (outcome.status === "failed") {
      this.postNotice(
        outcome.permanently ? "The conversation could not be permanently deleted and was kept." : "The conversation could not be moved to Trash and was kept.",
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

  private async resetConversation(status: string): Promise<void> {
    this.messages = [];
    this.tools = [];
    this.changes = [];
    this.proposals.clear();
    this.retryRequest = undefined;
    this.historyRecoveryAvailable = false;
    this.attachments.clear();
    await this.persistMessages();
    this.status = status;
    this.postState();
  }

  private async compact(): Promise<void> {
    if (this.isForegroundRequestActive()) {
      this.postNotice("Cancel or wait for the active request before compacting the session.", "warning");
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
    if (this.isForegroundRequestActive()) throw new Error("Wait for Pi before restoring a file.");
    const release = this.requestGate.acquire();
    this.postState();
    try {
      const confirmation = await vscode.window.showWarningMessage(`Revert Pi's change to ${change.label}?`, { modal: true }, "Revert File");
      if (confirmation !== "Revert File") return;
      this.changes = this.changeTracker.revert(id);
    } finally {
      this.proposals.clear(); this.backgroundAgents.invalidateResults(); this.changes = this.changeTracker.changes;
      release(); this.postState();
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
      this.postNotice("Cancel or wait for the active request before switching conversations.", "warning");
      return;
    }
    const selected = this.recentSessions.find(session => session.key === id);
    if (!selected) throw new Error("The selected conversation is no longer in the recent session list. Refresh Chats and try again.");
    if (selected.path === this.runtime.currentState.sessionFile) {
      this.postState();
      return;
    }
    await this.switchToSession(selected.path, "Pi session resumed");
  }

  private async switchToSession(sessionFile: string, status: string): Promise<void> {
    await this.runtime.switchSession(sessionFile);
    this.attachments.clear();
    this.proposals.clear();
    this.retryRequest = undefined;
    await this.syncMessagesFromPi();
    this.tools = [];
    this.changes = [];
    await this.refreshRecentSessions(false);
    this.status = status;
    this.postState();
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
      this.status = "Pi is working…";
      this.tools = [];
    } else if (event.type === "message_start") {
      const message = isRecord(event.message) ? event.message : undefined;
      if (message?.role === "assistant") {
        this.streamingAssistantId = undefined;
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
      const toolName = stringValue(event.toolName) ?? "tool";
      if (this.trackCurrentRequestChanges) {
        this.changeTracker.captureToolEvent(event);
        this.currentRequestSideEffects.record(undefined, toolName);
      }
      this.upsertTool({
        id: stringValue(event.toolCallId) ?? randomUUID(),
        name: toolName,
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
      this.status = this.requestLifecycle.wasCancelled ? "Cancelling Pi request…" : "Finishing Pi response…";
      this.streamingAssistantId = undefined;
      if (this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest(this.requestLifecycle.wasCancelled ? "cancelled" : "completed");
        this.trackCurrentRequestChanges = false;
      }
    } else if (event.type === "process_exit") {
      if (this.trackCurrentRequestChanges) {
        this.changes = this.changeTracker.finishRequest("process-exit");
        this.trackCurrentRequestChanges = false;
      }
      this.status = "Disconnected · Reconnect available";
    } else if (event.type === "runtime_warning" || event.type === "protocol_error") {
      const details = stringValue(event.message);
      this.postNotice(event.type === "protocol_error" ? "Pi reported a protocol error." : "Pi reported a runtime warning.", "warning", details);
    } else if (event.type === "extension_ui_request") {
      void this.handleExtensionUiRequest(event).catch(error => {
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

  private appendAssistantText(delta: string): void {
    let id = this.streamingAssistantId;
    if (!id) {
      id = randomUUID();
      this.streamingAssistantId = id;
      this.messages = limitSidebarMessages(
        [...this.messages, { id, role: "assistant", content: delta }],
        maxMessages,
        maxStoredCharacters,
      );
    } else {
      this.messages = this.messages.map(message =>
        message.id === id ? { ...message, content: message.content + delta } : message,
      );
    }
    this.scheduleState();
  }

  private upsertTool(activity: ToolActivity): void {
    this.tools = [...this.tools.filter(tool => tool.id !== activity.id), activity].slice(-maxToolActivities);
  }

  private updateTool(id: string, changes: Partial<ToolActivity>): void {
    this.tools = this.tools.map(tool => (tool.id === id ? { ...tool, ...changes } : tool));
  }

  private async syncMessagesFromPi(): Promise<void> {
    if (!this.runtime.currentState.connected) {
      const failure = historySyncFailureState(false);
      this.status = failure.status;
      this.historyRecoveryAvailable = failure.historyRecoveryAvailable;
      this.postState();
      throw new Error("Pi disconnected before conversation history could be synchronized.");
    }
    if (this.runtime.currentState.busy) {
      throw new Error("Wait for Pi to finish before refreshing conversation history.");
    }
    try {
      const messages = convertPiMessages(await this.runtime.getMessages(), { imageAssets: this.imageAssets, knownMessages: this.messages, maxMessages });
      if (messages.length > 0 || this.runtime.currentState.sessionId) {
        this.messages = limitSidebarMessages(messages, maxMessages, maxStoredCharacters);
        await this.persistMessages();
      }
      this.historyRecoveryAvailable = false;
      this.postState();
    } catch (error) {
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
      if (revision !== this.sessionRefreshRevision || activeSessionFile !== this.runtime.currentState.sessionFile) return;
      this.recentSessions = sessions.some(session => session.path === activeSessionFile)
        ? sessions
        : [{
          key: piSessionKey(activeSessionFile),
          path: activeSessionFile,
          sessionId: runtime.sessionId ?? "",
          title: runtime.sessionName?.trim() || "New conversation",
          updatedAt: Date.now(),
        }, ...sessions].slice(0, 100);
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
    const messages = sidebarMessagesForWebview(
      this.messages,
      assetId => this.imageAssets.has(assetId) || this.imageAssetDelivery.has(assetId),
    ).map(message => ({ ...message, html: renderSafeMarkdown(message.content) }));
    this.postMessage({
      type: "state",
      messages,
      tools: this.tools,
      changes: this.changes,
      proposals: this.proposals.states,
      backgroundTasks: this.backgroundAgents.states,
      status: this.status,
      attachments: attachmentSummaries,
      attachmentEstimate: { characters: estimate.characters, bytes: estimate.bytes, estimatedTextTokens: estimate.estimatedTextTokens, imageUsage: estimate.imageUsage },
      imageSupported: modelSupportsImages(this.runtime.currentState.model),
      retryAvailable: Boolean(this.retryRequest) && !requestBusy,
      historyRecoveryAvailable: this.historyRecoveryAvailable && !requestBusy,
      backgroundSubmissionPending: this.backgroundSubmissionGate.isPending,
      sessions: this.recentSessions.map(session => ({
        id: session.key,
        title: session.title,
        updatedAt: session.updatedAt,
        current: session.path === this.runtime.currentState.sessionFile,
      })),
      runtime: { ...this.runtime.currentState, busy: requestBusy, cancellable: this.foregroundCancellable },
    });
    this.deliverReferencedImageAssets(messages, attachmentSummaries.flatMap(attachment => attachment.assetId ? [attachment.assetId] : []));
  }

  private deliverReferencedImageAssets(messages: readonly SidebarMessage[], composerAssetIds: readonly string[] = []): void {
    const webview = this.view?.webview;
    if (!webview) return;
    const referenced = new Set([
      ...messages.flatMap(message => (message.attachments ?? []).flatMap(attachment => attachment.type === "image" ? [attachment.assetId] : [])),
      ...composerAssetIds,
    ]);
    for (const asset of this.imageAssetDelivery.pending(referenced, this.imageAssets)) {
      void webview.postMessage({
        type: "imageAsset",
        id: asset.id,
        mimeType: asset.mimeType,
        data: asset.data,
        byteLength: asset.byteLength,
        width: asset.width,
        height: asset.height,
      }).then(delivered => {
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
  if (action === "queueInstruction") return "Pi could not confirm queued message delivery. Inspect history and recovered drafts before resending.";
  if (action === "send" || action === "retry") return "Pi could not accept the message. Review details, then retry when safe.";
  if (action === "reconnect") return "Pi could not reconnect. Review details and try again.";
  if (action === "refreshHistory") return "Conversation history could not be refreshed. Review details and try again.";
  if (action === "deleteSession") return "The conversation could not be deleted and was kept.";
  if (action === "cancel") return "Pi could not confirm cancellation. Review details before continuing.";
  return "The Pi action failed. Review details and try again.";
}
