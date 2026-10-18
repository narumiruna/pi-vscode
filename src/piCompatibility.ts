import * as vscode from "vscode";
import type { PiRuntimeManager } from "./piRuntime";

export function registerPiCompatibility(context: vscode.ExtensionContext, runtime: PiRuntimeManager): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("pi.extensionUiCompatibility", async () => {
      const choice = await vscode.window.showInformationMessage(
        "Pi RPC supports standard dialogs and text widgets. Custom terminal components, overlays, keybindings, custom tool/entry renderers, editor/header/footer components, and Pi theme switching cannot render in this sidebar. Unsupported calls can be silent; there is no automatic detector. Use a terminal for those extensions. Handoff stops the sidebar writer and retains ownership until you explicitly return it.",
        { modal: true },
        "Hand Off to Terminal",
      );
      if (choice === "Hand Off to Terminal") await runtime.openInTerminal();
    }),
  );
}
