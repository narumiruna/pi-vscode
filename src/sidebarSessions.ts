import { randomBytes, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import type { WorkspaceChangeTracker } from "./changeTracker";
import type { ExtensionUiDialogs } from "./extensionUiDialogs";
import type { InteractiveSessionSlots } from "./interactiveSessionSlots";
import type { Logger } from "./logging";
import { PiRuntimeManager } from "./piRuntime";
import { SessionActivity } from "./sessionActivity";
import { listRecentPiSessions, type PiSessionSummary } from "./sessionHistory";
import type { SessionWriters } from "./sessionWriters";
import type { PiChatViewProvider } from "./sidebar";
import { isRecord } from "./sidebarHelpers";
import { patchRetainedTranscript } from "./sidebarTranscript";
import { parseSidebarSlashCommand } from "./slashCommands";
import { requireTrustedFile } from "./workflowUi";

interface ConversationView {
  readonly webview: vscode.Webview;
  readonly onDidDispose: vscode.Event<void>;
  readonly visible?: boolean;
  readonly onDidChangeVisibility?: vscode.Event<void>;
}

interface Entry {
  readonly id: string;
  readonly label: string;
  readonly runtime: PiRuntimeManager;
  readonly controller: PiChatViewProvider;
  readonly tracker: WorkspaceChangeTracker;
  readonly activity: SessionActivity;
  readonly subscriptions: vscode.Disposable[];
  release?: () => void;
  transport?: vscode.EventEmitter<unknown>;
  disposeView?: vscode.EventEmitter<void>;
  state?: Record<string, unknown>;
  composer: { text: string; revision: number };
  contextBlocked: boolean;
  composerContext: number;
  lastSessionFile: string | undefined;
  readonly pendingComposerUpdates: Record<string, unknown>[];
  readonly notices: Record<string, unknown>[];
  followingLatest: boolean;
  detailVisible: boolean;
  cleanupUnverified: boolean;
  attempted: boolean;
  updatedAt: number;
  closing?: Promise<void>;
}

export interface SidebarSessionServices {
  readonly context: vscode.ExtensionContext;
  readonly primaryRuntime: PiRuntimeManager;
  readonly primary: PiChatViewProvider;
  readonly dialogs: ExtensionUiDialogs;
  readonly writers: SessionWriters;
  readonly slots: InteractiveSessionSlots;
  readonly logger: Logger;
  readonly revealEditorSession?: (sessionFile: string) => boolean;
  readonly createConversation: (runtime: PiRuntimeManager, resource: vscode.Uri, label: string) => PiChatViewProvider;
}

/** Selection changes presentation, never the owner of an accepted operation. */
export class SidebarSessions implements vscode.Disposable {
  private readonly entries = new Map<string, Entry>();
  private readonly primary: Entry;
  private selected: Entry;
  private displayed: Entry;
  private launcher: Entry | undefined;
  private launcherPromise: Promise<Entry> | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private view: ConversationView | undefined;
  private viewSubscriptions: vscode.Disposable[] = [];
  private generation = 0;
  private ready = false;
  private disposed = false;
  private navigating = false;
  private picking = false;
  private sequence = 0;
  private summaries: PiSessionSummary[] = [];
  private refreshSequence = 0;
  private autoRefreshPending = false;
  private autoRefreshRunning = false;
  private cycle: readonly string[] = [];
  private editorCycleId: string | undefined;
  private listSignature = "";

  public constructor(private readonly services: SidebarSessionServices) {
    this.primary = this.entry(services.primaryRuntime, services.primary);
    this.selected = this.primary;
    this.displayed = this.primary;
  }

  private entry(runtime: PiRuntimeManager, controller: PiChatViewProvider, release?: () => void): Entry {
    const entry: Entry = {
      id: randomBytes(12).toString("hex"),
      label: controller === this.services.primary ? "Primary session" : `Sidebar session ${++this.sequence}`,
      runtime,
      controller,
      tracker: controller.changeTracker,
      activity: new SessionActivity(),
      subscriptions: [],
      release,
      composer: { text: "", revision: 0 },
      contextBlocked: false,
      composerContext: 0,
      lastSessionFile: runtime.currentState.sessionFile,
      pendingComposerUpdates: [],
      notices: [],
      followingLatest: true,
      detailVisible: false,
      cleanupUnverified: false,
      attempted: false,
      updatedAt: Date.now(),
    };
    controller.setSidebarSessions(this);
    this.entries.set(entry.id, entry);
    entry.subscriptions.push(
      runtime.onDidChangeState(() => {
        this.reconcileComposerContext(entry);
        entry.activity.updateRuntime({
          busy: runtime.currentState.busy,
          pendingDialogs: runtime.hasPendingExtensionDialogs,
        });
        this.publishList();
      }),
      runtime.onEvent((event) => {
        if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified")
          entry.cleanupUnverified = true;
        entry.activity.updateRuntime({
          busy: runtime.currentState.busy,
          pendingDialogs: runtime.hasPendingExtensionDialogs,
        });
        this.publishList();
      }),
    );
    return entry;
  }

  public resolveWebviewView(view: ConversationView): void {
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose();
    for (const entry of this.entries.values()) this.detach(entry);
    this.view = view;
    this.ready = false;
    this.generation++;
    let htmlSet = false;
    for (const entry of this.entries.values()) {
      this.attach(entry, (html) => {
        if (!htmlSet) {
          htmlSet = true;
          view.webview.html = html;
        }
      });
    }
    this.viewSubscriptions.push(
      view.webview.onDidReceiveMessage((message) => {
        void this.receive(message).catch(() =>
          this.notice("The session action failed. Check the current session before trying again."),
        );
      }),
    );
    this.viewSubscriptions.push(
      view.onDidDispose(() => {
        if (this.view !== view) return;
        this.view = undefined;
        this.ready = false;
        for (const entry of this.entries.values()) this.detach(entry);
      }),
    );
    if (view.onDidChangeVisibility) this.viewSubscriptions.push(view.onDidChangeVisibility(() => this.publish()));
  }

  private detach(entry: Entry): void {
    entry.disposeView?.fire();
    entry.disposeView?.dispose();
    entry.transport?.dispose();
    entry.disposeView = undefined;
    entry.transport = undefined;
  }

  private attach(entry: Entry, setHtml?: (html: string) => void): void {
    const view = this.view;
    if (!view || entry.transport) return;
    entry.transport = new vscode.EventEmitter<unknown>();
    entry.disposeView = new vscode.EventEmitter<void>();
    const webview: vscode.Webview = {
      get options() {
        return view.webview.options;
      },
      set options(value) {
        view.webview.options = value;
      },
      get html() {
        return "";
      },
      set html(value: string) {
        setHtml?.(value);
      },
      cspSource: view.webview.cspSource,
      asWebviewUri: (uri) => view.webview.asWebviewUri(uri),
      onDidReceiveMessage: entry.transport.event,
      postMessage: async (message: unknown) => this.fromController(entry, message),
    };
    entry.controller.resolveConversationView({ webview, onDidDispose: entry.disposeView.event }, false);
    entry.transport.fire({ type: "ready" });
    entry.transport.fire({ type: "draftSelect", scope: entry === this.launcher ? "sessions" : "session" });
  }

  private fromController(entry: Entry, message: unknown): boolean {
    if (!isRecord(message) || this.disposed) return false;
    // Draft identity updates can arrive before the controller publishes its runtime state.
    this.reconcileComposerContext(entry);
    if (message.type === "state") {
      entry.state = message;
      this.publishList();
      if (entry === this.displayed) this.publish();
      return entry === this.displayed && this.ready;
    }
    if (message.type === "transcriptTailPatch") {
      const state = patchRetainedTranscript(entry.state, message);
      if (!state) return false;
      entry.state = state;
      if (entry !== this.displayed || !this.ready || !this.view) return false;
      const sidebar = { entryId: entry.id, bindingGeneration: this.generation };
      void this.view.webview.postMessage({ ...message, sidebar });
      return true;
    }
    if (
      message.type === "clearInput" &&
      !entry.contextBlocked &&
      message.expectedRevision === entry.composer.revision &&
      message.expectedText === entry.composer.text
    ) {
      entry.composer = { text: "", revision: entry.composer.revision + 1 };
      entry.contextBlocked = false;
    }
    if (entry !== this.displayed || !this.ready || !this.view) {
      if (message.type === "notice") {
        entry.notices.push(message);
        if (entry.notices.length > 8) entry.notices.shift();
      } else this.updateInactiveComposer(entry, message);
      return false;
    }
    void this.view.webview.postMessage({ ...message, sidebar: this.binding(entry) });
    return true;
  }

  private updateInactiveComposer(entry: Entry, message: Record<string, unknown>): void {
    if (
      !["setInput", "appendDraft", "restoreBranchDraft"].includes(String(message.type)) ||
      typeof message.text !== "string" ||
      message.text.length > 100_000
    )
      return;
    const { text, revision } = entry.composer;
    const unchanged =
      message.expectedRevision === undefined
        ? message.type === "setInput" || !text
        : message.expectedRevision === revision &&
          (message.expectedText === undefined || message.expectedText === text);
    if (!unchanged) return;
    if (message.type === "appendDraft" && message.recoveredDraftId) {
      // Attachment recovery still needs the renderer's guarded two-step handshake.
      if (entry.pendingComposerUpdates.length < 10) entry.pendingComposerUpdates.push(message);
      else {
        entry.notices.push({
          type: "notice",
          level: "warning",
          message: "Recovered text is still available under Restore drafts. Review it before resending.",
        });
        if (entry.notices.length > 8) entry.notices.shift();
      }
      return;
    }
    const next = message.type === "setInput" ? message.text : text + (text ? "\n\n" : "") + message.text;
    if (next.length <= 100_000) entry.composer = { text: next, revision: revision + 1 };
  }

  private flushPending(entry: Entry): void {
    if (!this.view || !this.ready || entry !== this.displayed) return;
    for (const message of [...entry.notices.splice(0), ...entry.pendingComposerUpdates.splice(0)])
      void this.view.webview.postMessage({ ...message, sidebar: this.binding(entry) });
  }

  private reconcileComposerContext(entry: Entry): void {
    const file = entry.runtime.currentState.sessionFile;
    // Keep the last actual file through disconnect; first startup/promotion is not replacement.
    if (!file || file === entry.lastSessionFile) return;
    if (entry.lastSessionFile) {
      entry.composerContext += 1;
      if (entry.composer.text) entry.contextBlocked = true;
    }
    entry.lastSessionFile = file;
  }

  private binding(entry: Entry) {
    this.reconcileComposerContext(entry);
    return {
      entryId: entry.id,
      bindingGeneration: this.generation,
      composerContext: entry.composerContext,
      view: entry === this.launcher ? "sessions" : "session",
      resultRevision: entry.activity.resultRevision,
      composer: { ...entry.composer, contextBlocked: entry.contextBlocked },
      primary: entry === this.primary,
      canClose: entry !== this.primary && entry !== this.launcher,
      canStart: !entry.attempted || entry === this.launcher,
    };
  }

  private rows() {
    const live = [...this.entries.values()].filter((entry) => entry !== this.launcher && !entry.closing);
    const files = new Set(live.map((entry) => entry.runtime.currentState.sessionFile).filter(Boolean));
    return [
      ...live.map((entry) => ({
        id: entry.id,
        title: entry.runtime.currentState.sessionName?.trim()
          ? `${entry.runtime.currentState.sessionName.trim()} (${entry.label})`
          : entry.label,
        updatedAt: entry.updatedAt,
        current: entry === this.selected,
        activity: entry.activity.status,
        unread: entry.activity.unread,
        primary: entry === this.primary,
        sessionId: entry.runtime.currentState.sessionId ?? entry.id,
      })),
      ...this.summaries
        .filter((summary) => !files.has(summary.path))
        .map((summary) => ({
          id: summary.key,
          title: summary.title,
          updatedAt: summary.updatedAt,
          current: false,
          activity: "idle",
          unread: false,
          primary: false,
          sessionId: summary.sessionId,
        })),
    ];
  }

  private publishList(): void {
    if (!this.ready || !this.view || this.disposed) return;
    const sessions = this.rows();
    const sidebar = { entryId: this.displayed.id, bindingGeneration: this.generation };
    const signature = JSON.stringify([sidebar, sessions]);
    if (signature === this.listSignature) return;
    this.listSignature = signature;
    // Background token deltas neither resend the same rows nor copy the active draft.
    void this.view.webview.postMessage({ type: "sidebarSessions", sessions, sidebar });
  }

  private publish(): void {
    const entry = this.displayed;
    if (!this.ready || !this.view || !entry.state || this.disposed) return;
    void this.view.webview.postMessage({ ...entry.state, sessions: this.rows(), sidebar: this.binding(entry) });
  }

  private async receive(input: unknown): Promise<void> {
    if (!isRecord(input) || this.disposed || !this.view) return;
    if (input.type === "ready") {
      const initialize = !this.ready;
      this.ready = true;
      // Synthetic controller readiness can run before the renderer can receive image payloads.
      this.displayed.controller.refreshView(true);
      this.displayed.controller.refreshSidebarDraft();
      this.flushPending(this.displayed);
      if (initialize && !this.primary.runtime.currentState.connected && !this.primary.runtime.currentState.busy)
        void this.connect(this.primary);
      return;
    }
    const entry = this.displayed;
    if (input.entryId !== entry.id || input.bindingGeneration !== this.generation) return;
    const { entryId: _entryId, bindingGeneration: _generation, composerContext, ...message } = input;
    this.reconcileComposerContext(entry);
    if (message.type === "sidebarViewState") {
      if (
        typeof composerContext !== "number" ||
        !Number.isSafeInteger(composerContext) ||
        composerContext < 0 ||
        composerContext > entry.composerContext ||
        typeof message.text !== "string" ||
        message.text.length > 100_000 ||
        !Number.isSafeInteger(message.revision) ||
        (message.revision as number) < entry.composer.revision ||
        typeof message.followingLatest !== "boolean" ||
        typeof message.detailVisible !== "boolean"
      )
        return;
      // A late old-context report can retain text, but cannot authorize sending or clear a guard.
      if (composerContext !== entry.composerContext && !message.text) return;
      const wasBlocked = entry.contextBlocked;
      entry.composer = { text: message.text, revision: message.revision as number };
      if (composerContext !== entry.composerContext) entry.contextBlocked = true;
      else if (!message.text) entry.contextBlocked = false;
      entry.followingLatest = message.followingLatest;
      entry.detailVisible = message.detailVisible;
      if (wasBlocked !== entry.contextBlocked) this.publish();
      return;
    }
    if (message.type === "acknowledgeResult") {
      const history = entry.state?.history;
      if (
        entry !== this.launcher &&
        this.view.visible !== false &&
        entry.detailVisible &&
        entry.followingLatest &&
        isRecord(history) &&
        history.mode === "latest" &&
        !history.loading &&
        typeof message.revision === "number" &&
        entry.activity.acknowledge(message.revision)
      )
        this.publishList();
      return;
    }
    if (message.type === "draftSelect") {
      if (message.scope === "sessions") await this.showSessions();
      else if (message.scope === "session" && entry === this.launcher) this.display(this.selected);
      else entry.transport?.fire(message);
      return;
    }
    if (message.type === "switchRecentSession" && typeof message.id === "string") {
      const generation = this.generation;
      try {
        await this.select(message.id);
      } finally {
        // Cancel, rejected admission, and editor reveal can leave this binding unchanged.
        if (this.displayed === entry && this.generation === generation)
          this.fromController(entry, { type: "sessionSwitchRejected" });
      }
      return;
    }
    if (message.type === "newSession") {
      await this.create();
      return;
    }
    if (message.type === "resumeSession") {
      await this.resume();
      return;
    }
    if (message.type === "refreshSessions") {
      await this.refresh();
      return;
    }
    if (message.type === "closeSidebarSession") {
      await this.close(entry);
      return;
    }
    if (
      ["send", "sendNewSession", "queueInstruction", "runBackground"].includes(String(message.type)) &&
      (entry.contextBlocked || composerContext !== entry.composerContext)
    ) {
      this.fromController(entry, { type: "sendRejected" });
      this.fromController(entry, {
        type: "notice",
        level: "warning",
        message: "Text was kept after the session changed. Verify the session, then clear the composer before sending.",
      });
      return;
    }
    if (message.type === "sendNewSession") {
      if (entry !== this.launcher || typeof message.text !== "string" || !Number.isSafeInteger(message.revision))
        return;
      let delegated = false;
      try {
        if (/^!!?/.test(message.text)) throw new Error("Open a session before running direct shell.");
        const command = parseSidebarSlashCommand(message.text);
        if (command && ["new", "resume", "settings", "extension-settings", "session"].includes(command.name)) {
          delegated = true;
          await entry.controller.receiveSidebarMessage({ ...message, type: "send" });
          return;
        }
        if (!(await this.admitLauncher(entry))) return;
        // Capture the Sessions draft submission before selecting its new session-file owner.
        const submission = entry.controller.receiveSidebarMessage({ ...message, type: "send" });
        delegated = true;
        entry.transport?.fire({ type: "draftSelect", scope: "session" });
        this.display(entry);
        await submission;
      } finally {
        if (!delegated) this.fromController(entry, { type: "sendRejected" });
      }
      return;
    }
    if (
      entry === this.launcher &&
      ["reconnect", "pickModel", "pickComposerSettings", "setModel", "setThinking", "pickCommand", "compact"].includes(
        String(message.type),
      )
    ) {
      if (!(await this.admitLauncher(entry))) return;
      entry.transport?.fire({ type: "draftSelect", scope: "session" });
      this.display(entry);
    }
    if (
      ["pickModel", "pickComposerSettings", "setModel", "setThinking", "pickCommand", "compact"].includes(
        String(message.type),
      ) &&
      !entry.runtime.currentState.connected
    )
      await this.connect(entry);
    if (
      entry === this.launcher &&
      !String(message.type).startsWith("draft") &&
      !String(message.type).startsWith("fileCompletion") &&
      ![
        "copyText",
        "showOutput",
        "inspectContext",
        "pickContext",
        "showMoreActions",
        "attachSelection",
        "attachFile",
        "attachCurrentFile",
        "attachDiagnostics",
        "attachImage",
        "pasteImage",
        "imageAssetEvicted",
        "imageAssetRejected",
        "attachTerminal",
        "clearAttachments",
        "removeAttachment",
      ].includes(String(message.type))
    ) {
      this.notice("Open a session before using this action.");
      return;
    }
    await entry.controller.receiveSidebarMessage(message);
  }

  public navigateFromComposer(command: "new" | "resume"): Promise<boolean> {
    return command === "new" ? this.create() : this.resume();
  }

  public acceptComposerSubmission(
    controller: PiChatViewProvider,
    expectedRevision: number,
    expectedText: string,
  ): void {
    const entry = this.find(controller);
    if (!entry || entry.closing) return;
    this.fromController(entry, { type: "clearInput", expectedRevision, expectedText });
  }

  public assertComposerContext(controller: PiChatViewProvider): void {
    const entry = this.find(controller);
    if (!entry) return;
    this.reconcileComposerContext(entry);
    if (entry.contextBlocked)
      throw new Error(
        "Text was kept after the session changed. Verify the session, then clear the composer before sending.",
      );
  }

  public revealConversation(controller: PiChatViewProvider): void {
    const entry = this.find(controller);
    if (entry && entry !== this.displayed) this.display(entry);
  }

  private async connect(entry: Entry): Promise<void> {
    entry.attempted = true;
    await entry.controller.connectSidebarSession();
    if (!entry.runtime.currentState.connected) {
      const requestId = randomUUID();
      entry.activity.begin(requestId);
      entry.activity.finish(requestId, "failed", true);
      this.publishList();
      this.publish();
    }
  }

  private display(entry: Entry): void {
    if (this.disposed || entry.closing) return;
    this.displayed = entry;
    this.editorCycleId = undefined;
    if (entry !== this.launcher) this.selected = entry;
    this.generation++;
    this.publish();
    // Other entries can evict this controller's images from the shared renderer cache.
    entry.controller.refreshView(true);
    entry.controller.refreshSidebarDraft();
    this.flushPending(entry);
  }

  private async workspace() {
    const cwd = this.services.primaryRuntime.currentCwd;
    const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
    if (!folder || folder.uri.scheme !== "file") throw new Error("A file-backed workspace is required.");
    requireTrustedFile(folder.uri);
    const root = await realpath(cwd);
    if (
      this.disposed ||
      this.services.primaryRuntime.currentCwd !== cwd ||
      vscode.workspace.getWorkspaceFolder(folder.uri)?.uri.toString() !== folder.uri.toString() ||
      (await realpath(folder.uri.fsPath)) !== root
    )
      throw new Error("Pi workspace changed.");
    requireTrustedFile(folder.uri);
    if (
      this.disposed ||
      this.services.primaryRuntime.currentCwd !== cwd ||
      vscode.workspace.getWorkspaceFolder(folder.uri)?.uri.toString() !== folder.uri.toString()
    )
      throw new Error("Pi workspace changed.");
    return { uri: folder.uri, root };
  }

  private async make(summary?: PiSessionSummary, release?: () => void): Promise<Entry> {
    let runtime: PiRuntimeManager | undefined;
    let controller: PiChatViewProvider | undefined;
    let entry: Entry | undefined;
    let cleanupUnverified = false;
    let warningSubscription: vscode.Disposable | undefined;
    try {
      const workspace = await this.workspace();
      runtime = new PiRuntimeManager(this.services.context, this.services.logger, {
        sidebarSession: true,
        editorWorkspace: workspace,
        sessionWriters: this.services.writers,
        ...(summary ? { initialSession: { file: summary.path, sessionId: summary.sessionId || undefined } } : {}),
      });
      // Observe cleanup before any factory or registration can fail, through the end of shutdown.
      warningSubscription = runtime.onEvent((event) => {
        if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") {
          cleanupUnverified = true;
          if (entry) entry.cleanupUnverified = true;
        }
      });
      controller = this.services.createConversation(runtime, workspace.uri, "Sidebar session");
      entry = this.entry(runtime, controller, release);
      entry.cleanupUnverified = cleanupUnverified;
      entry.subscriptions.push(this.services.dialogs.addRuntime(runtime, entry.label));
      entry.subscriptions.push(this.services.primary.addCheckpointTracker(entry.tracker));
      if (release) {
        entry.tracker.enableConcurrentSafety(workspace.root);
        this.primary.tracker.enableConcurrentSafety(workspace.root);
      }
      this.attach(entry);
      return entry;
    } catch (error) {
      // entry() can fail after inserting its partially initialized entry.
      entry ??= [...this.entries.values()].find((candidate) => candidate.runtime === runtime);
      if (entry) {
        entry.release = release;
        entry.cleanupUnverified ||= cleanupUnverified;
        entry.closing = this.stop(entry);
        await entry.closing;
      } else {
        await runtime?.shutdown().catch(() => {
          cleanupUnverified = true;
        });
        controller?.dispose();
        controller?.changeTracker.dispose();
        if (!cleanupUnverified) release?.();
        else
          this.notice(
            "Session cleanup is unverified. Inspect residual processes, then reload before conflicting work. Its slot and session file remain reserved.",
          );
      }
      throw error;
    } finally {
      warningSubscription?.dispose();
    }
  }

  private async admission(): Promise<(() => void) | undefined> {
    const release = this.services.slots.acquire();
    const generation = this.generation;
    try {
      const workspace = await this.workspace();
      const approved = await vscode.window.showWarningMessage(
        "Open an independent Sidebar session? Sessions share workspace files and can change them at the same time. They are not isolated. Advanced global commands still target the Primary session.",
        { modal: true },
        "Open Session",
      );
      if (approved !== "Open Session") {
        release();
        return undefined;
      }
      if (generation !== this.generation) throw new Error("Session selection changed during confirmation.");
      const current = await this.workspace();
      if (current.uri.toString() !== workspace.uri.toString() || current.root !== workspace.root)
        throw new Error("Pi workspace changed.");
      return release;
    } catch (error) {
      release();
      throw error;
    }
  }

  private async admitLauncher(entry: Entry): Promise<boolean> {
    const release = await this.admission();
    if (!release) return false;
    if (this.launcher !== entry || this.disposed) {
      release();
      throw new Error("The session composer changed.");
    }
    try {
      entry.tracker.enableConcurrentSafety(entry.runtime.currentCwd);
      this.primary.tracker.enableConcurrentSafety(entry.runtime.currentCwd);
    } catch (error) {
      release();
      throw error;
    }
    entry.release = release;
    this.launcher = undefined;
    return true;
  }

  public async create(): Promise<boolean> {
    if (this.picking) throw new Error("A session picker is already open.");
    if (this.navigating) return false;
    this.navigating = true;
    let release: (() => void) | undefined;
    try {
      release = await this.admission();
      if (!release) return false;
      const reservation = release;
      release = undefined;
      const entry = await this.make(undefined, reservation);
      this.cycle = [];
      this.display(entry);
      return true;
    } finally {
      release?.();
      this.navigating = false;
    }
  }

  public async showSessions(): Promise<void> {
    if (!this.launcher) {
      this.launcherPromise ??= this.make();
      try {
        this.launcher = await this.launcherPromise;
      } finally {
        this.launcherPromise = undefined;
      }
    }
    this.display(this.launcher);
    this.launcher.transport?.fire({ type: "draftSelect", scope: "sessions" });
    await this.refresh();
  }

  public async select(id: string, options?: { readonly revealSidebar: boolean }): Promise<boolean> {
    if (this.picking) throw new Error("A session picker is already open.");
    if (this.navigating) return false;
    this.navigating = true;
    let release: (() => void) | undefined;
    let connect: Entry | undefined;
    try {
      await this.workspace();
      let entry = this.entries.get(id);
      if (!entry || entry === this.launcher) {
        const summary = this.summaries.find((item) => item.key === id);
        if (!summary) throw new Error("The saved session is no longer in this index. Refresh Sessions.");
        const file = await realpath(summary.path);
        entry = [...this.entries.values()].find((candidate) => candidate.runtime.currentState.sessionFile === file);
        if (!entry) {
          if (this.services.revealEditorSession?.(file)) {
            // Keep the Sidebar binding, but continue cycling from the revealed panel.
            this.editorCycleId = summary.key;
            return true;
          }
          release = await this.admission();
          if (!release) return false;
          const reservation = release;
          release = undefined;
          entry = connect = await this.make(summary, reservation);
          // Loading changes this conversation's ID, not its native cycle position.
          const retainedId = entry.id;
          this.cycle = this.cycle.map((member) => (member === summary.key ? retainedId : member));
        }
      }
      if (entry.closing) throw new Error("This session is closing or its cleanup is unverified.");
      if (entry !== this.displayed || entry.id !== id) this.display(entry);
      else this.editorCycleId = undefined;
    } finally {
      release?.();
      this.navigating = false;
    }
    // Reveal the selected detail without waiting for history or blocking another selection.
    await Promise.all([
      connect ? this.connect(connect) : undefined,
      options?.revealSidebar ? vscode.commands.executeCommand("pi.chatView.focus") : undefined,
    ]);
    return true;
  }

  private async prepareNativeNavigation(): Promise<void> {
    const workspace = await this.workspace();
    if (!this.selected.runtime.currentState.sessionFile && !this.primary.runtime.currentState.sessionFile) {
      // Startup retains trust, terminal ownership, launch-policy, and session-writer admission checks.
      await this.primary.runtime.ensureStarted(workspace.uri);
      // Load history before renderer readiness observes an already-connected Primary.
      await this.connect(this.primary);
    }
    if (!this.selected.runtime.currentState.sessionFile && !this.primary.runtime.currentState.sessionFile)
      throw new Error("Pi has no current session location. Reconnect before switching sessions.");
    const current = await this.workspace();
    if (current.uri.toString() !== workspace.uri.toString() || current.root !== workspace.root)
      throw new Error("Pi workspace changed.");
  }

  public async quickSwitch(): Promise<void> {
    if (this.picking || this.navigating) throw new Error("A session navigation action is already pending.");
    this.picking = true;
    let destination: string | undefined;
    try {
      await this.prepareNativeNavigation();
      await this.refresh();
      const text = (value: string) =>
        value
          .replace(/[\p{Cc}\p{Cf}]/gu, " ")
          .replace(/\$\(/g, "＄(")
          .slice(0, 256);
      const choices = this.rows().map((row) => ({
        label: text(row.title),
        description: text(
          `${row.current ? "Current · " : ""}${row.primary ? "Primary · " : ""}${row.activity}${row.unread ? " · Unread result" : ""} · ${row.sessionId}`,
        ),
        id: row.id,
      }));
      const generation = this.generation;
      const choice = await vscode.window.showQuickPick(choices, {
        title: "Switch Pi Session",
        matchOnDescription: true,
      });
      if (choice && choices.includes(choice) && generation === this.generation) destination = choice.id;
    } finally {
      this.picking = false;
    }
    if (destination) await this.select(destination, { revealSidebar: true });
  }

  public async cycleSession(direction: -1 | 1): Promise<void> {
    if (this.picking || this.navigating) throw new Error("A session navigation action is already pending.");
    await this.prepareNativeNavigation();
    await this.refresh();
    const rows = this.rows();
    const members = new Set(rows.map((row) => row.id));
    if (!this.cycle.length || this.cycle.length !== members.size || this.cycle.some((id) => !members.has(id)))
      this.cycle = rows.map((row) => row.id);
    if (!this.cycle.length) return;
    if (this.editorCycleId && !members.has(this.editorCycleId)) this.editorCycleId = undefined;
    const index = this.cycle.indexOf(this.editorCycleId ?? this.selected.id);
    const next =
      index < 0
        ? direction > 0
          ? 0
          : this.cycle.length - 1
        : (index + direction + this.cycle.length) % this.cycle.length;
    const id = this.cycle[next];
    if (id) await this.select(id, { revealSidebar: true });
  }

  public async resume(): Promise<boolean> {
    if (this.picking || this.navigating) throw new Error("A session navigation action is already pending.");
    this.picking = true;
    let selected: vscode.Uri | undefined;
    try {
      await this.workspace();
      const generation = this.generation;
      const selection = await vscode.window.showOpenDialog({
        title: "Resume Pi Session",
        canSelectFiles: true,
        canSelectFolders: false,
        canSelectMany: false,
        filters: { "Pi sessions": ["jsonl"] },
      });
      if (generation === this.generation) selected = selection?.[0];
    } finally {
      this.picking = false;
    }
    if (!selected) return false;
    const file = await realpath(selected.fsPath);
    const owned = [...this.entries.values()].find((entry) => entry.runtime.currentState.sessionFile === file);
    if (owned) return this.select(owned.id);
    // The initial-session startup path validates the canonical header and workspace before spawning.
    const summary = {
      key: randomBytes(12).toString("hex"),
      path: file,
      sessionId: "",
      title: "Resumed session",
      updatedAt: 0,
    };
    this.summaries = [...this.summaries.slice(0, 99), summary];
    return this.select(summary.key);
  }

  public async refresh(): Promise<void> {
    if (this.disposed) return;
    const sequence = ++this.refreshSequence;
    const owner = this.selected.runtime.currentState.sessionFile ? this.selected : this.primary;
    const file = owner.runtime.currentState.sessionFile;
    const cwd = owner.runtime.currentCwd;
    if (file) {
      const summaries = await listRecentPiSessions(file, cwd);
      if (
        summaries &&
        !this.disposed &&
        sequence === this.refreshSequence &&
        owner === (this.selected.runtime.currentState.sessionFile ? this.selected : this.primary) &&
        cwd === owner.runtime.currentCwd &&
        file === owner.runtime.currentState.sessionFile
      )
        this.summaries = summaries;
    }
    this.publishList();
  }

  public requestStarted(controller: PiChatViewProvider, requestId: string): void {
    const entry = this.find(controller);
    if (entry) {
      entry.attempted = true;
      entry.updatedAt = Date.now();
      entry.activity.begin(requestId);
    }
    this.publishList();
  }

  public requestFinished(
    controller: PiChatViewProvider,
    requestId: string,
    outcome: "completed" | "failed" | "stopped",
    result: boolean,
  ): void {
    const entry = this.find(controller);
    if (entry) {
      entry.updatedAt = Date.now();
      entry.activity.finish(requestId, outcome, result);
    }
    this.publishList();
    this.publish();
    this.scheduleSavedSessionRefresh();
  }

  private scheduleSavedSessionRefresh(): void {
    if (this.disposed) return;
    this.autoRefreshPending = true;
    if (this.autoRefreshRunning) return;
    this.autoRefreshRunning = true;
    setImmediate(() => {
      void this.runSavedSessionRefresh();
    });
  }

  private async runSavedSessionRefresh(): Promise<void> {
    try {
      while (this.autoRefreshPending && !this.disposed) {
        this.autoRefreshPending = false;
        try {
          await this.refresh();
        } catch {
          this.services.logger.record("warn", "history-refresh", { result: "failed" });
        }
      }
    } finally {
      this.autoRefreshRunning = false;
    }
  }

  private find(controller: PiChatViewProvider): Entry | undefined {
    return [...this.entries.values()].find((entry) => entry.controller === controller);
  }

  private async close(entry: Entry): Promise<void> {
    if (entry === this.primary || entry === this.launcher || entry.closing) return;
    if (entry.controller.hasProtectedSidebarRecovery)
      throw new Error("Retain failed-restore recovery before closing this session.");
    const accepted = await vscode.window.showWarningMessage(
      "Close this Sidebar session? Its work stops and unsent memory-only text and attachments are discarded. Saved Pi history remains. Inspect remaining processes if cleanup is uncertain.",
      { modal: true },
      "Close Session",
    );
    if (accepted !== "Close Session" || this.disposed || this.entries.get(entry.id) !== entry) return;
    if (entry.controller.hasProtectedSidebarRecovery)
      throw new Error("Retain failed-restore recovery before closing this session.");
    entry.closing = this.stop(entry);
    if (this.displayed === entry) this.display(this.primary);
    await entry.closing;
    this.publish();
  }

  private async stop(entry: Entry): Promise<void> {
    await entry.runtime.shutdown().catch(() => {
      entry.cleanupUnverified = true;
    });
    this.detach(entry);
    entry.controller.dispose();
    entry.tracker.dispose();
    for (const subscription of entry.subscriptions) subscription.dispose();
    if (!entry.cleanupUnverified) {
      entry.release?.();
      this.entries.delete(entry.id);
    } else
      this.notice(
        "Session cleanup is unverified. Inspect residual processes, then reload before conflicting work. Its slot and session file remain reserved.",
      );
  }

  private notice(message: string): void {
    if (this.view && this.ready)
      void this.view.webview.postMessage({
        type: "notice",
        message,
        level: "warning",
        sidebar: this.binding(this.displayed),
      });
  }

  public shutdown(): Promise<void> {
    if (!this.shutdownPromise) this.shutdownPromise = this.stopAll();
    return this.shutdownPromise;
  }

  private async stopAll(): Promise<void> {
    this.disposed = true;
    await this.launcherPromise?.catch(() => {});
    await Promise.allSettled(
      [...this.entries.values()]
        .filter((entry) => entry !== this.primary)
        .map((entry) => entry.closing ?? this.stop(entry)),
    );
    for (const subscription of this.viewSubscriptions.splice(0)) subscription.dispose();
    for (const subscription of this.primary.subscriptions) subscription.dispose();
  }

  public dispose(): void {
    void this.shutdown();
  }
}
