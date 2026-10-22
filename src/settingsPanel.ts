import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { NativePiForm } from "./nativePiForm";
import type { PiRuntimeManager } from "./piRuntime";
import { getSettingsHtml } from "./settingsHtml";
import {
  maxSettingsMessage,
  type SettingsRestartResult,
  type SettingsRestartStatus,
  type SettingsSnapshot,
  serializedSize,
} from "./settingsModel";

function openSettings(): Thenable<unknown> {
  return vscode.commands.executeCommand("workbench.action.openSettings", "@ext:narumi.narumi-pi");
}

export function registerSettingsPanel(
  context: vscode.ExtensionContext,
  runtime?: PiRuntimeManager,
): SettingsPanelController {
  const controller = new SettingsPanelController(context.extensionUri, runtime);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("pi.openSettings", openSettings),
    vscode.commands.registerCommand("pi.openPiConfiguration", () => controller.show()),
  );
  return controller;
}

export class SettingsPanelController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private listeners: vscode.Disposable[] = [];
  private queue = Promise.resolve();
  private queued = 0;
  private disposed = false;
  private nativeForm?: NativePiForm;
  private actionGeneration = 0;
  private restartAction?: { token: string; origin: string };
  private restartResult?: SettingsRestartResult;

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runtime?: PiRuntimeManager,
  ) {}

  public show(): void {
    if (this.disposed) return;
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    const root = vscode.Uri.joinPath(this.extensionUri, "out", "settings");
    const panel = vscode.window.createWebviewPanel("pi.settings", "Pi Configuration", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [root],
    });
    this.panel = panel;
    this.invalidateActions();
    const nativeForm = this.runtime
      ? new NativePiForm(this.runtime, () => this.panel === panel && !this.disposed)
      : undefined;
    this.nativeForm = nativeForm;
    const invalidateNative = () => {
      this.invalidateActions();
      nativeForm?.invalidate();
      // Availability must reach the browser before an invalidation can trigger a new load.
      this.postSnapshot(panel);
      if (this.panel === panel) void panel.webview.postMessage({ type: "nativeInvalidated" });
    };
    this.listeners = [
      panel.onDidDispose(() => this.release(panel)),
      panel.webview.onDidReceiveMessage((message: unknown) => {
        const native =
          !!message &&
          typeof message === "object" &&
          !Array.isArray(message) &&
          ["nativeLoad", "nativeSave", "nativeReset"].includes(String((message as Record<string, unknown>).type));
        const actionGeneration = this.actionGeneration;
        if (this.queued >= 16) {
          this.postRestartResult(panel, message, "rejected");
          if (native) {
            const { id } = message as Record<string, unknown>;
            if (typeof id === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(id)) {
              void panel.webview.postMessage({
                type: "nativeResult",
                id,
                ok: false,
                error: "Settings are busy. Try saving this row again.",
              });
            }
          }
          return;
        }
        const generation =
          native && (message as Record<string, unknown>).type === "nativeLoad"
            ? nativeForm?.supersede()
            : nativeForm?.currentGeneration;
        this.queued++;
        this.queue = this.queue
          .then(() => this.handleMessage(panel, message, native, generation, actionGeneration))
          .finally(() => {
            this.queued--;
          });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pi")) invalidateNative();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(invalidateNative),
      vscode.workspace.onDidGrantWorkspaceTrust(invalidateNative),
    ];
    panel.webview.html = getSettingsHtml({
      source: panel.webview.cspSource,
      script: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "settings.js")).toString(),
      style: panel.webview.asWebviewUri(vscode.Uri.joinPath(root, "settings.css")).toString(),
    });
  }

  public dispose(): void {
    this.disposed = true;
    this.panel?.dispose();
  }

  private release(panel: vscode.WebviewPanel): void {
    if (this.panel !== panel) return;
    this.panel = undefined;
    this.restartResult = undefined;
    this.invalidateActions();
    this.nativeForm?.invalidate();
    this.nativeForm = undefined;
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }

  private invalidateActions(): void {
    this.actionGeneration++;
    this.restartAction = undefined;
  }

  private restartOrigin(): string {
    const state = this.runtime?.currentState;
    return JSON.stringify([
      this.actionGeneration,
      vscode.workspace.workspaceFolders?.[0]?.uri.toString(),
      process.env.PI_CODING_AGENT_DIR,
      this.runtime?.currentCwd,
      this.runtime?.clientGeneration,
      state?.sessionId,
      state?.sessionFile,
      state?.connected,
    ]);
  }

  private snapshot(): SettingsSnapshot {
    const nativeFilesAvailable =
      vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.[0]?.uri.scheme === "file";
    if (nativeFilesAvailable && this.runtime) {
      try {
        const origin = this.restartOrigin();
        if (this.restartAction?.origin !== origin) this.restartAction = { token: randomUUID(), origin };
      } catch {
        // Invalid launch settings must not prevent navigation to Settings or poison the panel queue.
        this.restartAction = undefined;
      }
    } else this.restartAction = undefined;
    return {
      type: "snapshot",
      nativeFilesAvailable,
      ...(this.restartAction ? { restartActionToken: this.restartAction.token } : {}),
    };
  }

  private postRestartResult(panel: vscode.WebviewPanel, input: unknown, status: SettingsRestartStatus): void {
    if (this.panel !== panel || this.disposed || !input || typeof input !== "object") return;
    const message = input as Record<string, unknown>;
    if (message.type !== "restartPi" || typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id))
      return;
    this.restartResult = { type: "restartResult", id: message.id, status };
    void panel.webview.postMessage(this.restartResult);
  }

  private postSnapshot(panel: vscode.WebviewPanel): void {
    if (this.panel === panel) void panel.webview.postMessage(this.snapshot());
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    input: unknown,
    native: boolean,
    generation?: number,
    actionGeneration?: number,
  ): Promise<void> {
    if (this.panel !== panel || this.disposed) return;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input) || serializedSize(input) > maxSettingsMessage)
        throw new Error("Invalid settings message.");
      const message = input as Record<string, unknown>;
      if (native) {
        if (!this.nativeForm || generation === undefined) throw new Error("Native configuration is unavailable.");
        await this.nativeForm.handle(message, generation, (reply) => {
          if (this.panel === panel) void panel.webview.postMessage(reply);
        });
        return;
      }
      if (message.type === "ready") {
        this.postSnapshot(panel);
        // A hidden webview can miss an outcome. Reconcile it on reveal without replaying the action.
        if (this.restartResult) void panel.webview.postMessage(this.restartResult);
        return;
      }
      if (message.type === "openNative") {
        await openSettings();
        return;
      }
      if (message.type === "openProjectApproval") {
        if (
          Object.keys(message).some((key) => key !== "type") ||
          actionGeneration !== this.actionGeneration ||
          !this.snapshot().nativeFilesAvailable
        )
          throw new Error("Project approval settings are unavailable or the request expired.");
        await vscode.commands.executeCommand("workbench.action.openSettings", "pi.approveProjectResources");
        return;
      }
      if (message.type === "restartPi") {
        if (
          Object.keys(message).some((key) => !["type", "id", "actionToken"].includes(key)) ||
          typeof message.id !== "string" ||
          !/^[a-zA-Z0-9-]{1,80}$/.test(message.id) ||
          typeof message.actionToken !== "string" ||
          message.actionToken !== this.restartAction?.token ||
          this.restartAction?.origin !== this.restartOrigin() ||
          actionGeneration !== this.actionGeneration ||
          !this.runtime ||
          !this.snapshot().nativeFilesAvailable
        ) {
          this.postSnapshot(panel);
          this.postRestartResult(panel, message, "rejected");
          return;
        }
        this.restartAction = undefined;
        this.restartResult = undefined;
        try {
          const completed = await vscode.commands.executeCommand("pi.restartResources");
          this.postRestartResult(
            panel,
            message,
            completed === true ? "completed" : completed === false ? "cancelled" : "failed",
          );
        } catch {
          this.postRestartResult(panel, message, "failed");
        }
        this.postSnapshot(panel);
        return;
      }
      if (message.type === "openPiFile") {
        if (message.kind !== "settings" && message.kind !== "mcp") throw new Error("Invalid Pi file kind.");
        if (message.scope !== "global" && message.scope !== "project") throw new Error("Invalid Pi scope.");
        if (!this.snapshot().nativeFilesAvailable) throw new Error("Open a trusted file workspace first.");
        await vscode.commands.executeCommand(
          message.kind === "settings" ? "pi.openNativeSettings" : "pi.openNativeMcp",
          message.scope,
        );
        return;
      }
      throw new Error("Unknown configuration action.");
    } catch {
      if (this.panel !== panel) return;
      if (input && typeof input === "object" && (input as Record<string, unknown>).type === "restartPi") {
        this.postSnapshot(panel);
        this.postRestartResult(panel, input, "rejected");
      } else if (native) {
        const candidate = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
        if (typeof candidate === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(candidate))
          void panel.webview.postMessage({
            type: "nativeResult",
            id: candidate,
            ok: false,
            error: "Native configuration is unavailable or the request exceeds its limit. Reload before retrying.",
          });
      } else {
        this.postSnapshot(panel);
        void panel.webview.postMessage({
          type: "result",
          ok: false,
          error: "Could not open configuration. Use the Command Palette to open settings or native management.",
        });
      }
    }
  }
}
