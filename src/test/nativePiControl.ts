import assert from "node:assert/strict";
import path from "node:path";
import * as vscode from "vscode";
import { hasOperation } from "../operationLocks";
import { parseSessionTree } from "../piControl";
import type { PiRpcClient } from "../piRpcClient";
import type { PiRuntimeState } from "../piRuntime";
import { PiRuntimeControl, type RuntimeControlHost } from "../piRuntimeControl";

/** Real native host/trust/canonical URI checks, with an inert client fixture only. */
export async function verifyNativePiControl(root: vscode.Uri): Promise<void> {
  let pendingDialog = false;
  let state: PiRuntimeState = {
    connected: true,
    busy: false,
    sessionId: "native-control-fixture",
    commands: [],
    availableModels: [],
    availableThinkingLevels: [],
  };
  const client = {
    isRunning: true,
    getState: async () => ({ sessionId: state.sessionId, isStreaming: state.busy }),
    getTree: async () => parseSessionTree({ tree: [], leafId: null }),
  } as unknown as PiRpcClient;
  const host: RuntimeControlHost = {
    context: {
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../..")),
      workspaceState: { get: () => undefined, update: async () => {} },
    } as unknown as vscode.ExtensionContext,
    cwd: root.fsPath,
    resource: root,
    get state() {
      return state;
    },
    client,
    get hasPendingDialogs() {
      return pendingDialog;
    },
    queuePending: false,
    owned: (action) => action(),
    start: async () => {},
    startSession: async () => {},
    stop: async () => {},
    refresh: async () => {},
    emit: () => {},
    resetUi: () => {},
    terminalOptions: async () => {
      throw new Error("Native control smoke cannot launch a terminal");
    },
  };
  const control = new PiRuntimeControl(host);
  control.clientStarted();
  try {
    if (!vscode.workspace.isTrusted) {
      await assert.rejects(
        control.withWorkspaceOperation("untrusted fixture", async () => {}),
        /trusted/,
      );
      return;
    }
    for (const command of [
      "pi.reloadResources",
      "pi.restartResources",
      "pi.browseSessionTree",
      "pi.returnFromTerminal",
      "pi.extensionUiCompatibility",
    ])
      assert.ok((await vscode.commands.getCommands(true)).includes(command), `Missing native command ${command}`);
    assert.equal((await control.getSessionTree()).leafId, null);
    await control.withWorkspaceOperation("native canonical control", async (assertCurrent) => {
      assert.ok(hasOperation(await import("node:fs/promises").then((fs) => fs.realpath(root.fsPath))));
      await assertCurrent();
    });
    pendingDialog = true;
    await assert.rejects(control.getSessionTree(), /dialogs/);
    pendingDialog = false;
    state = { ...state, busy: true };
    await assert.rejects(control.getSessionTree(), /foreground work/);
  } finally {
    control.dispose();
  }
}
