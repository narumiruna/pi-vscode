import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { NativePiForm } from "../nativePiForm";
import type { NativeFormSnapshot } from "../nativePiFormModel";
import { nativeSettingControls } from "../nativePiModel";
import { PiRuntimeManager } from "../piRuntime";

export async function verifyNativeSettings(): Promise<void> {
  await vscode.extensions.getExtension("narumi.narumi-pi")?.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    "pi.openSettings",
    "pi.openNativeSettings",
    "pi.openNativeMcp",
    "pi.nativeRuntimeControls",
    "pi.applyNativeConfiguration",
  ])
    assert.ok(commands.includes(command), `${command} must be registered independently`);
  const tabs = () =>
    vscode.window.tabGroups.all.flatMap((group) => group.tabs).filter((tab) => tab.label === "Pi Settings");
  const waitForTab = async () => {
    for (let attempt = 0; attempt < 100 && tabs().length !== 1; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(tabs().length, 1, "Settings command must reveal a singleton panel");
  };
  await vscode.commands.executeCommand("pi.openSettings");
  await vscode.commands.executeCommand("pi.openSettings");
  await waitForTab();
  assert.ok(await vscode.window.tabGroups.close(tabs()));
  await vscode.commands.executeCommand("pi.openSettings");
  await waitForTab();
  await verifyNativeForm();
  const config = vscode.workspace.getConfiguration("pi");
  const previous = config.inspect<string>("provider");
  try {
    await config.update("provider", "native-user", vscode.ConfigurationTarget.Global);
    await config.update("provider", "native-workspace", vscode.ConfigurationTarget.Workspace);
    assert.equal(vscode.workspace.getConfiguration("pi").inspect<string>("provider")?.globalValue, "native-user");
    assert.equal(
      vscode.workspace.getConfiguration("pi").inspect<string>("provider")?.workspaceValue,
      "native-workspace",
    );
    assert.equal(vscode.workspace.getConfiguration("pi").get("provider"), "native-workspace");
    await config.update("provider", undefined, vscode.ConfigurationTarget.Workspace);
    assert.equal(vscode.workspace.getConfiguration("pi").get("provider"), "native-user");
  } finally {
    await config.update("provider", previous?.globalValue, vscode.ConfigurationTarget.Global);
    await config.update("provider", previous?.workspaceValue, vscode.ConfigurationTarget.Workspace);
    await vscode.window.tabGroups.close(tabs());
  }
}

/** Exercise the production form protocol with real VS Code APIs and the cold operation owner. */
async function verifyNativeForm(): Promise<void> {
  assert.ok(process.env.PI_VSCODE_NATIVE_EVIDENCE, "Native form checks require the disposable fixture");
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder);
  const root = await realpath(folder.uri.fsPath);
  const directory = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-form-native-")));
  const agentDir = path.join(directory, "agent");
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const extension = vscode.extensions.getExtension("narumi.narumi-pi");
  assert.ok(extension);
  const runtime = new PiRuntimeManager({
    extensionUri: extension.extensionUri,
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: { clear: () => {} },
  } as unknown as vscode.ExtensionContext);
  let active = true;
  const form = new NativePiForm(runtime, () => active);
  let counter = 0;
  const request = async (message: Record<string, unknown>) => {
    const replies: Record<string, unknown>[] = [];
    const generation = message.type === "nativeLoad" ? form.supersede() : form.currentGeneration;
    await form.handle({ id: `native-check-${++counter}`, ...message }, generation, (reply) =>
      replies.push(reply as Record<string, unknown>),
    );
    assert.equal(replies.at(-1)?.ok, true, JSON.stringify(replies));
    return replies.find((reply) => reply.type === "nativeSnapshot") as unknown as NativeFormSnapshot;
  };
  const projectDir = path.join(root, ".pi");
  try {
    await assert.rejects(readFile(path.join(projectDir, "settings.json")), { code: "ENOENT" });
    await assert.rejects(readFile(path.join(projectDir, "mcp.json")), { code: "ENOENT" });
    for (const scope of ["global", "project"] as const) {
      let state = await request({ type: "nativeLoad", scope });
      assert.equal(state.entries.length, 8);
      assert.equal(state.servers.length, 0);
      state = await request({ type: "nativeReset", scope, revision: state.revision, key: "defaultModel" });
      const target = scope === "global" ? agentDir : projectDir;
      await assert.rejects(readFile(path.join(target, "settings.json")), { code: "ENOENT" });
      for (const control of nativeSettingControls) {
        state = await request({
          type: "nativeSave",
          scope,
          revision: state.revision,
          key: control.key,
          value: control.defaultValue,
        });
        assert.equal(state.entries.find((entry) => entry.key === control.key)?.hasOverride, true);
      }
      const opened = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(target, "settings.json")));
      assert.equal(opened.isDirty, false);
      state = await request({ type: "nativeReset", scope, revision: state.revision, key: "defaultModel" });
      assert.equal(state.entries.find((entry) => entry.key === "defaultModel")?.hasOverride, false);
    }
    await mkdir(agentDir, { recursive: true });
    const mcp =
      '{"mcpServers":{"docs":{"url":"https://example.invalid/TRANSPORT_CANARY","headers":{"Authorization":"AUTH_CANARY"}}}}';
    await writeFile(path.join(agentDir, "mcp.json"), mcp);
    let state = await request({ type: "nativeLoad", scope: "project" });
    assert.equal(state.servers[0].type, "http");
    assert.ok(!JSON.stringify(state).includes("CANARY"));
    state = await request({
      type: "nativeSave",
      scope: "project",
      revision: state.revision,
      server: "docs",
      key: "enabled",
      value: false,
    });
    assert.deepEqual(JSON.parse(await readFile(path.join(projectDir, "mcp.json"), "utf8")), {
      mcpServers: { docs: { enabled: false } },
    });
    state = await request({
      type: "nativeReset",
      scope: "project",
      revision: state.revision,
      server: "docs",
      key: "enabled",
    });
    assert.equal(state.servers[0].enabled, true);
    assert.equal(await readFile(path.join(agentDir, "mcp.json"), "utf8"), mcp);
    assert.equal(runtime.currentState.connected, false, "Form operations must not start Pi");
  } finally {
    active = false;
    form.invalidate();
    runtime.dispose();
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await rm(directory, { recursive: true, force: true });
    await rm(projectDir, { recursive: true, force: true });
  }
}
