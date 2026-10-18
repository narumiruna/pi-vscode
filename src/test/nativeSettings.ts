import assert from "node:assert/strict";
import * as vscode from "vscode";

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
