import { realpath } from "node:fs/promises";
import * as vscode from "vscode";
import { WorkspaceChangeTracker } from "./changeTracker";
import { ExclusiveOperationGate } from "./conversationController";
import type { ExtensionUiDialogs } from "./extensionUiDialogs";
import { InteractiveSessionSlots } from "./interactiveSessionSlots";
import type { Logger } from "./logging";
import { PiRuntimeManager } from "./piRuntime";
import type { SessionWriters } from "./sessionWriters";
import { PiChatViewProvider } from "./sidebar";
import { requireTrustedFile } from "./workflowUi";

interface EditorSession {
  readonly panel: vscode.WebviewPanel;
  readonly runtime: PiRuntimeManager;
  readonly provider: PiChatViewProvider;
  readonly tracker: WorkspaceChangeTracker;
  readonly subscriptions: vscode.Disposable[];
  readonly releaseSlot: () => void;
  closing?: Promise<void>;
  cleanupUnverified?: boolean;
}

/** Each native editor tab owns one interactive process; focus is not execution authority. */
export class ConcurrentSessions implements vscode.Disposable {
  private readonly sessions = new Set<EditorSession>();
  private readonly creation = new ExclusiveOperationGate("Wait for the new Pi session to open.");
  private sequence = 0;
  private disposed = false;

  public constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly primaryRuntime: PiRuntimeManager,
    private readonly primary: PiChatViewProvider,
    private readonly dialogs: ExtensionUiDialogs,
    private readonly writers: SessionWriters,
    private readonly logger: Logger,
    private readonly slots = new InteractiveSessionSlots(),
  ) {
    context.subscriptions.push(
      this,
      vscode.commands.registerCommand("pi.newConcurrentSession", () => this.open()),
    );
  }

  public async open(): Promise<void> {
    const release = this.creation.acquire();
    let releaseSlot: (() => void) | undefined;
    try {
      this.assertAvailable();
      releaseSlot = this.slots.acquire();
      const cwd = this.primaryRuntime.currentCwd;
      const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd));
      if (folder?.uri.scheme !== "file") throw new Error("A file-backed workspace is required.");
      // Keep the opened URI for scoped settings; canonical paths are only for safety checks and locks.
      const resource = folder.uri;
      const folderIdentity = resource.toString();
      const assertBinding = () => {
        this.assertAvailable();
        requireTrustedFile(resource);
        if (
          this.primaryRuntime.currentCwd !== cwd ||
          vscode.workspace.getWorkspaceFolder(vscode.Uri.file(cwd))?.uri.toString() !== folderIdentity ||
          vscode.workspace.getWorkspaceFolder(resource)?.uri.toString() !== folderIdentity
        )
          throw new Error("Pi workspace changed.");
      };
      const root = await realpath(cwd);
      assertBinding();
      if ((await realpath(resource.fsPath)) !== root) throw new Error("Pi workspace changed.");
      assertBinding();
      const choice = await vscode.window.showWarningMessage(
        "Open an independent Pi session in an editor tab? Sessions can run at the same time and change the same workspace files. They are not isolated. Closing a tab stops only that session; saved Pi history remains. Editor actions and terminal handoff stay in the sidebar.",
        { modal: true },
        "Open Session",
      );
      if (choice !== "Open Session") return;
      assertBinding();
      if ((await realpath(cwd)) !== root) throw new Error("Pi workspace changed.");
      assertBinding();
      if ((await realpath(resource.fsPath)) !== root) throw new Error("Pi workspace changed.");
      assertBinding();
      this.primary.changeTracker.enableConcurrentSafety(root);
      const runtime = new PiRuntimeManager(this.context, this.logger, {
        editorSession: true,
        editorWorkspace: { uri: resource, root },
        sessionWriters: this.writers,
      });
      const tracker = new WorkspaceChangeTracker();
      let panel: vscode.WebviewPanel | undefined;
      let provider: PiChatViewProvider | undefined;
      const subscriptions: vscode.Disposable[] = [];
      let session: EditorSession | undefined;
      let cleanupUnverified = false;
      subscriptions.push(
        runtime.onEvent((event) => {
          if (event.type === "runtime_warning" && event.warningCode === "cleanup-unverified") {
            cleanupUnverified = true;
            if (session) session.cleanupUnverified = true;
          }
        }),
      );
      try {
        tracker.enableConcurrentSafety(root);
        const label = `Pi Session ${++this.sequence}`;
        subscriptions.push(this.dialogs.addRuntime(runtime, label));
        subscriptions.push(this.primary.addCheckpointTracker(tracker));
        panel = vscode.window.createWebviewPanel("pi.concurrentSession", label, vscode.ViewColumn.Active, {
          enableScripts: true,
          retainContextWhenHidden: true,
          localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "out", "rich-content")],
        });
        const ownedPanel = panel;
        provider = new PiChatViewProvider(
          this.context,
          runtime,
          tracker,
          this.primary.backgroundAgents,
          this.logger,
          { reveal: () => ownedPanel.reveal(), resource, label },
          this.primary.draftStore,
        );
        const ownedSession: EditorSession = { panel, runtime, provider, tracker, subscriptions, releaseSlot };
        session = ownedSession;
        this.sessions.add(ownedSession);
        releaseSlot = undefined;
        subscriptions.push(
          panel.onDidDispose(() => {
            void this.close(ownedSession);
          }),
          panel.onDidChangeViewState(() => {
            if (ownedPanel.visible) ownedSession.provider.refreshView();
          }),
          runtime.onDidChangeState((state) => {
            const name = state.sessionName?.replace(/[\p{Cc}\p{Cf}]/gu, "").slice(0, 80);
            ownedPanel.title = `${label}${name ? `: ${name}` : ""}${state.busy ? " (working)" : ""}`;
          }),
        );
        provider.resolveWebviewView(panel);
      } catch (error) {
        if (session) {
          panel?.dispose();
          await this.close(session);
        } else {
          provider?.dispose();
          panel?.dispose();
          await runtime.shutdown().catch(() => {
            cleanupUnverified = true;
          });
          if (cleanupUnverified) releaseSlot = undefined;
          for (const subscription of subscriptions) subscription.dispose();
          tracker.dispose();
          if (cleanupUnverified) this.warnCleanupUnverified();
        }
        throw error;
      }
    } finally {
      releaseSlot?.();
      release();
    }
  }

  public revealSession(sessionFile: string): boolean {
    const session = [...this.sessions].find((entry) => entry.runtime.currentState.sessionFile === sessionFile);
    if (!session) return false;
    if (session.closing)
      throw new Error("This session's previous writer has not stopped safely. Inspect cleanup warnings.");
    session.panel.reveal();
    return true;
  }

  private assertAvailable(): void {
    if (this.disposed) throw new Error("Pi sessions are closing.");
    requireTrustedFile();
  }

  private warnCleanupUnverified(): void {
    void vscode.window.showWarningMessage(
      "Pi session cleanup could not be verified. Inspect remaining processes before conflicting work. Its session file remains blocked in this window.",
    );
  }

  private close(session: EditorSession): Promise<void> {
    if (!session.closing) {
      session.provider.dispose();
      session.closing = session.runtime
        .shutdown()
        .catch(() => {
          session.cleanupUnverified = true;
        })
        .finally(() => {
          for (const subscription of session.subscriptions) subscription.dispose();
          session.tracker.dispose();
          if (!session.cleanupUnverified) {
            this.sessions.delete(session);
            session.releaseSlot();
          } else this.warnCleanupUnverified();
        });
    }
    return session.closing;
  }

  public async shutdown(): Promise<void> {
    this.disposed = true;
    const sessions = [...this.sessions];
    for (const session of sessions) session.panel.dispose();
    await Promise.all(sessions.map((session) => this.close(session)));
  }

  public dispose(): void {
    void this.shutdown();
  }
}
