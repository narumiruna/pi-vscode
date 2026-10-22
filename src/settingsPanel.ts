import * as vscode from "vscode";
import { NativePiForm } from "./nativePiForm";
import type { PiRuntimeManager } from "./piRuntime";
import { getSettingsHtml } from "./settingsHtml";
import {
  maxSettingsMessage,
  type SettingsSnapshot,
  type SettingValue,
  serializedSize,
  settingsDescriptors,
  validSettingValue,
} from "./settingsModel";

export function registerSettingsPanel(
  context: vscode.ExtensionContext,
  runtime?: PiRuntimeManager,
): SettingsPanelController {
  const controller = new SettingsPanelController(context.extensionUri, runtime);
  context.subscriptions.push(
    controller,
    vscode.commands.registerCommand("pi.openSettings", () => controller.show()),
  );
  return controller;
}

export class SettingsPanelController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private listeners: vscode.Disposable[] = [];
  private revision = 0;
  private signature = "";
  private queue = Promise.resolve();
  private queued = 0;
  private disposed = false;
  private nativeForm?: NativePiForm;

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
    const panel = vscode.window.createWebviewPanel("pi.settings", "Pi Settings", vscode.ViewColumn.Active, {
      enableScripts: true,
      localResourceRoots: [root],
    });
    this.panel = panel;
    const nativeForm = this.runtime
      ? new NativePiForm(this.runtime, () => this.panel === panel && !this.disposed)
      : undefined;
    this.nativeForm = nativeForm;
    const invalidateNative = () => {
      nativeForm?.invalidate();
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
        if (this.queued >= 16) {
          // A rejected write must clear the browser's pending state. Echo only a bounded request ID.
          if (message && typeof message === "object" && !Array.isArray(message)) {
            const { type, id } = message as Record<string, unknown>;
            if (
              (type === "save" || type === "reset" || native) &&
              typeof id === "string" &&
              /^[a-zA-Z0-9-]{1,80}$/.test(id)
            ) {
              void panel.webview.postMessage({
                type: native ? "nativeResult" : "result",
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
          .then(() => this.handleMessage(panel, message, native, generation))
          .finally(() => {
            this.queued--;
          });
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pi")) {
          invalidateNative();
          this.postSnapshot(panel);
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        invalidateNative();
        this.postSnapshot(panel);
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        invalidateNative();
        this.postSnapshot(panel);
      }),
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
    this.nativeForm?.invalidate();
    this.nativeForm = undefined;
    for (const listener of this.listeners.splice(0)) listener.dispose();
  }

  private snapshot(): SettingsSnapshot {
    const config = vscode.workspace.getConfiguration("pi");
    const data = {
      workspace: !!vscode.workspace.workspaceFile || !!vscode.workspace.workspaceFolders?.length,
      trusted: vscode.workspace.isTrusted,
      nativeFilesAvailable: vscode.workspace.isTrusted && vscode.workspace.workspaceFolders?.[0]?.uri.scheme === "file",
      remote: !!vscode.env.remoteName,
      entries: settingsDescriptors.map((descriptor) => {
        const inspected = config.inspect<SettingValue>(descriptor.key);
        return {
          key: descriptor.key,
          defaultValue: inspected?.defaultValue ?? descriptor.default,
          user: inspected?.globalValue,
          workspace: inspected?.workspaceValue,
          effective: config.get<SettingValue>(descriptor.key, descriptor.default),
        };
      }),
    };
    const signature = JSON.stringify(data);
    if (signature !== this.signature) {
      this.signature = signature;
      this.revision++;
    }
    return { type: "snapshot", revision: this.revision, ...data };
  }

  private postSnapshot(panel: vscode.WebviewPanel): void {
    if (this.panel === panel) void panel.webview.postMessage(this.snapshot());
  }

  private async handleMessage(
    panel: vscode.WebviewPanel,
    input: unknown,
    native: boolean,
    generation?: number,
  ): Promise<void> {
    if (this.panel !== panel || this.disposed) return;
    let id: string | undefined;
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
        return;
      }
      if (message.type === "openNative") {
        await vscode.commands.executeCommand("workbench.action.openSettings", "@ext:narumi.narumi-pi");
        return;
      }
      if (message.type === "openPiFile") {
        if (message.kind !== "settings" && message.kind !== "mcp") throw new Error("Invalid Pi file kind.");
        if (message.scope !== "global" && message.scope !== "project") throw new Error("Invalid Pi file scope.");
        if (!this.snapshot().nativeFilesAvailable) throw new Error("Open a trusted file workspace first.");
        await vscode.commands.executeCommand(
          message.kind === "settings" ? "pi.openNativeSettings" : "pi.openNativeMcp",
          message.scope,
        );
        return;
      }
      if (typeof message.id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(message.id))
        throw new Error("Invalid request ID.");
      id = message.id;
      if (message.type !== "save" && message.type !== "reset") throw new Error("Unknown settings action.");
      const descriptor = settingsDescriptors.find((item) => item.key === message.key);
      if (!descriptor) throw new Error("Unknown Pi setting.");
      const state = this.snapshot();
      if (message.target !== "user" && message.target !== "workspace") throw new Error("Invalid settings scope.");
      if (message.target === "workspace" && !state.workspace)
        throw new Error("Open a workspace before saving workspace settings.");
      if (!Number.isSafeInteger(message.revision) || message.revision !== state.revision)
        throw new Error("Settings changed. Reload this row before saving.");
      if (descriptor.key === "approveProjectResources" && !state.trusted)
        throw new Error("Project resource approval requires a trusted workspace.");
      if (message.type === "save" && !validSettingValue(descriptor, message.value))
        throw new Error("Invalid setting value or edit limit exceeded.");
      await vscode.workspace
        .getConfiguration("pi")
        .update(
          descriptor.key,
          message.type === "reset" ? undefined : message.value,
          message.target === "user" ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace,
        );
      if (this.panel === panel) {
        this.postSnapshot(panel);
        void panel.webview.postMessage({ type: "result", id, ok: true });
      }
    } catch (error) {
      if (this.panel === panel) {
        if (native) {
          const candidate = input && typeof input === "object" ? (input as Record<string, unknown>).id : undefined;
          if (typeof candidate === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(candidate))
            void panel.webview.postMessage({
              type: "nativeResult",
              id: candidate,
              ok: false,
              error: "Native configuration is unavailable or the request exceeds its limit. Reload before retrying.",
            });
          return;
        }
        this.postSnapshot(panel);
        void panel.webview.postMessage({
          type: "result",
          id,
          ok: false,
          error: (error instanceof Error ? error.message : "Could not save settings.").slice(0, 500),
        });
      }
    }
  }
}
