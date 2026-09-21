/** Native UI test coordinator. File IPC exists only in the isolated test profile. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

export async function run(): Promise<void> {
  const directory = process.env.PICODE_UI_FIXTURE;
  assert.ok(directory);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "source.ts"));
  const other = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "other.ts"));
  const diagnostics = vscode.languages.createDiagnosticCollection("native-ui-fixture");
  const original = [source.getText(), other.getText()];
  const publish = () => {
    for (const [index, document] of [source, other].entries()) {
      const diagnostic = new vscode.Diagnostic(
        new vscode.Range(0, 0, 0, 10),
        `Fixture diagnostic ${index + 1}`,
        vscode.DiagnosticSeverity.Warning,
      );
      diagnostic.source = "native-ui-fixture";
      diagnostics.set(document.uri, index === 0 && document.getText() !== original[0] ? [] : [diagnostic]);
    }
  };
  const subscription = vscode.workspace.onDidChangeTextDocument(publish);
  await vscode.extensions.getExtension("narumi.pi-coding-agent-vscode")?.activate();
  await vscode.commands.executeCommand("picode.openChat");
  await vscode.extensions.getExtension("vscode.typescript-language-features")?.activate();
  // Do not replay the reload command from the previous Extension Host.
  let lastId = await readFile(path.join(directory, "request.json"), "utf8")
    .then((text) => JSON.parse(text).id as number)
    .catch(() => 0);
  await writeFile(
    path.join(directory, "ready.json"),
    JSON.stringify({
      version: vscode.version,
      boot: Date.now(),
      trusted: vscode.workspace.isTrusted,
      workspace: root.fsPath,
    }),
  );
  try {
    for (let attempt = 0; attempt < 6000; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      const request = await readFile(path.join(directory, "request.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      if (!request || request.id <= lastId) continue;
      lastId = request.id;
      let result: unknown;
      let error: string | undefined;
      try {
        switch (request.action) {
          case "command":
            result = await vscode.commands.executeCommand(request.command);
            break;
          case "source": {
            const editor = await vscode.window.showTextDocument(source);
            editor.selection = new vscode.Selection(0, 17, 0, 17);
            result = (
              await vscode.commands.executeCommand<unknown[]>(
                "vscode.executeDefinitionProvider",
                source.uri,
                editor.selection.active,
              )
            )?.length;
            break;
          }
          case "diagnostics":
            publish();
            break;
          case "state":
            result = {
              texts: [source.getText(), other.getText()],
              active: vscode.window.activeTextEditor?.document.uri.toString(),
              findings: vscode.languages
                .getDiagnostics()
                .filter(([uri, items]) => uri.scheme === "picode-review" && items.length > 0)
                .map(([uri, items]) => ({ uri: uri.toString(), messages: items.map((item) => item.message) })),
              tabs: vscode.window.tabGroups.all.flatMap((group) =>
                group.tabs.map((tab) => ({ label: tab.label, diff: tab.input instanceof vscode.TabInputTextDiff })),
              ),
            };
            break;
          case "undo":
            await vscode.window.showTextDocument(other);
            await vscode.commands.executeCommand("undo");
            assert.deepEqual([source.getText(), other.getText()], original);
            break;
          case "finish":
            return;
          default:
            throw new Error(`Unknown native UI test action: ${request.action}`);
        }
      } catch (failure) {
        error = failure instanceof Error ? failure.stack : String(failure);
      }
      await writeFile(path.join(directory, "result.tmp"), JSON.stringify({ id: request.id, result, error }));
      await rename(path.join(directory, "result.tmp"), path.join(directory, "result.json"));
    }
    throw new Error("Native UI coordinator timed out");
  } finally {
    subscription.dispose();
    diagnostics.dispose();
  }
}
