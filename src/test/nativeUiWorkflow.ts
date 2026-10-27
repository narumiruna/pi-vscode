/** Native UI test coordinator. File IPC exists only in the isolated test profile. */
import assert from "node:assert/strict";
import { readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { AnnotationThreadPrototype } from "./annotationThreadPrototype";

export async function run(): Promise<void> {
  const directory = process.env.PI_VSCODE_UI_FIXTURE;
  assert.ok(directory);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  const source = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "source.ts"));
  const other = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "other.ts"));
  const diagnostics = vscode.languages.createDiagnosticCollection("native-ui-fixture");
  const annotationPrototype = new AnnotationThreadPrototype();
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
  const annotationsOnly = await readFile(path.join(directory, "annotations-only"), "utf8").catch(() => "");
  const subscription = vscode.workspace.onDidChangeTextDocument(() => {
    if (!annotationsOnly) publish();
  });
  const annotationUri = (file: string) => {
    assert.ok(file === "code" || file === "markdown");
    return vscode.Uri.joinPath(root, file === "code" ? "annotations.ts" : "annotations.md");
  };
  const annotationState = () => ({
    active: vscode.window.activeTextEditor?.document.uri.toString(),
    selections: vscode.window.activeTextEditor?.selections,
    visibleRanges: vscode.window.activeTextEditor?.visibleRanges,
    // Native comments can add internal comment:// input editors even for read-only threads.
    // Preserve the source-editor contract, not VS Code-owned comment UI bookkeeping.
    editors: vscode.window.visibleTextEditors
      .filter((editor) => editor.document.uri.scheme === "file")
      .map((editor) => ({
        uri: editor.document.uri.toString(),
        selections: editor.selections,
        visibleRanges: editor.visibleRanges,
      })),
    documents: vscode.workspace.textDocuments
      .filter((document) => ["annotations.ts", "annotations.md"].includes(path.basename(document.uri.fsPath)))
      .map((document) => ({
        uri: document.uri.toString(),
        text: document.getText(),
        dirty: document.isDirty,
        version: document.version,
      })),
    tabs: vscode.window.tabGroups.all.flatMap((group) => group.tabs.map((tab) => tab.label)),
  });
  await vscode.extensions.getExtension("narumi.narumi-pi")?.activate();
  // The isolated selection run must let pi.askSelection resolve the sidebar for the first time.
  const selectionFirstOpen = await readFile(path.join(directory, "selection-first-open"), "utf8").catch(() => "");
  if (!selectionFirstOpen && !annotationsOnly) await vscode.commands.executeCommand("pi.openChat");
  await vscode.extensions.getExtension("vscode.typescript-language-features")?.activate();
  // Do not replay the reload command from the previous Extension Host.
  let extensionEditor: vscode.TextDocument | undefined;
  let extensionConfirmation: vscode.TextDocument | undefined;
  const commands = new Map<number, { complete: boolean; error?: string }>();
  let sessionSwitchTerminal: vscode.Terminal | undefined;
  let sessionSwitchTerminalInput = "";
  const sessionSwitchTerminalWrite = new vscode.EventEmitter<string>();
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
      const request: ReturnType<typeof JSON.parse> = await readFile(path.join(directory, "request.json"), "utf8")
        .then((text) => JSON.parse(text))
        .catch(() => undefined);
      if (!request || request.id <= lastId) continue;
      lastId = request.id;
      let result: unknown;
      let error: string | undefined;
      try {
        switch (request.action) {
          case "command":
            result = await vscode.commands.executeCommand(request.command, ...(request.args ?? []));
            break;
          case "clipboardRead":
            result = await vscode.env.clipboard.readText();
            break;
          case "sessionSwitchDefaults": {
            await vscode.commands.executeCommand("workbench.action.openDefaultKeybindingsFile");
            const document = vscode.window.activeTextEditor?.document;
            assert.ok(document, "Native default keyboard shortcuts document must be active");
            result = document.getText();
            break;
          }
          case "sessionSwitchTerminal":
            if (request.operation === "open") {
              sessionSwitchTerminalInput = "";
              sessionSwitchTerminal = vscode.window.createTerminal({
                name: "Session switch input fixture",
                pty: {
                  onDidWrite: sessionSwitchTerminalWrite.event,
                  open: () => sessionSwitchTerminalWrite.fire("Session switch input fixture\r\n"),
                  close() {},
                  handleInput: (data: string) => {
                    sessionSwitchTerminalInput += data;
                    sessionSwitchTerminalWrite.fire(data);
                  },
                },
              });
              sessionSwitchTerminal.show(false);
            } else if (request.operation === "close") {
              sessionSwitchTerminal?.dispose();
              sessionSwitchTerminal = undefined;
            } else {
              result = {
                input: sessionSwitchTerminalInput,
                active: vscode.window.activeTerminal === sessionSwitchTerminal,
              };
            }
            break;
          case "startCommand": {
            const id = request.id as number;
            commands.set(id, { complete: false });
            void Promise.resolve(vscode.commands.executeCommand(request.command, ...(request.args ?? []))).then(
              () => commands.set(id, { complete: true }),
              (failure) => commands.set(id, { complete: true, error: String(failure) }),
            );
            result = id;
            break;
          }
          case "commandResult":
            result = commands.get(request.commandId);
            break;
          case "annotationPrototype": {
            if (request.operation === "dispose") annotationPrototype.dispose();
            else if (request.operation === "clear") annotationPrototype.clear();
            else {
              const document = vscode.workspace.textDocuments.find(
                (document) => document.uri.toString() === annotationUri(request.file).toString(),
              );
              assert.ok(document && !document.isClosed, "Prototype requires an already-open fixture document");
              annotationPrototype.replace(document, request.annotations);
            }
            break;
          }
          case "annotationsDiff": {
            await vscode.commands.executeCommand(
              "vscode.diff",
              annotationUri("markdown"),
              annotationUri("code"),
              "Annotation prototype diff",
              { preview: false },
            );
            const modified = vscode.window.visibleTextEditors.find(
              (editor) => editor.document.uri.toString() === annotationUri("code").toString(),
            );
            assert.ok(modified, "Modified diff document must be visible before the probe");
            modified.selection = new vscode.Selection(31, 0, 31, 0);
            modified.revealRange(new vscode.Range(25, 0, 25, 0), vscode.TextEditorRevealType.AtTop);
            break;
          }
          case "annotationsState":
            result = annotationState();
            break;
          case "annotationsOpen": {
            const document = await vscode.workspace.openTextDocument(annotationUri(request.file));
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            editor.selections = [new vscode.Selection(30, 4, 30, 12), new vscode.Selection(32, 2, 32, 7)];
            editor.revealRange(new vscode.Range(25, 0, 25, 0), vscode.TextEditorRevealType.AtTop);
            break;
          }
          case "annotationsPosition": {
            const document = await vscode.workspace.openTextDocument(annotationUri(request.file));
            const editor = await vscode.window.showTextDocument(document, { preview: false });
            const line = request.line - 1;
            editor.selection = new vscode.Selection(line, 0, line, 0);
            editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenter);
            break;
          }
          case "annotationsEdit": {
            const editor = vscode.window.activeTextEditor;
            assert.equal(editor?.document.uri.toString(), annotationUri(request.file).toString());
            assert.ok(editor);
            assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "// user edit\n")));
            assert.ok(editor.document.isDirty);
            break;
          }
          case "annotationsClose": {
            const uri = annotationUri(request.file).toString();
            const tabs = vscode.window.tabGroups.all
              .flatMap((group) => group.tabs)
              .filter((tab) => tab.input instanceof vscode.TabInputText && tab.input.uri.toString() === uri);
            assert.ok(tabs.length > 0);
            assert.ok(await vscode.window.tabGroups.close(tabs));
            break;
          }
          case "extensionConfirmationState": {
            const editor = vscode.window.activeTextEditor;
            assert.ok(editor);
            assert.equal(editor.document.uri.scheme, "pi-extension-confirmation");
            extensionConfirmation = editor.document;
            const before = editor.document.getText();
            result = {
              text: before,
              editAccepted: await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "forbidden")),
              unchanged: editor.document.getText() === before,
            };
            break;
          }
          case "extensionConfirmationRefocus":
            assert.ok(extensionConfirmation);
            await vscode.window.showTextDocument(extensionConfirmation);
            break;
          case "extensionEditorState": {
            const active = vscode.window.activeTextEditor?.document;
            if (active?.uri.scheme === "untitled") extensionEditor = active;
            result = {
              text: active?.getText(),
              scheme: active?.uri.scheme,
              eol: active?.eol,
              confirmationTabs: vscode.window.tabGroups.all
                .flatMap((group) => group.tabs)
                .filter(
                  (tab) =>
                    tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === "pi-extension-confirmation",
                ).length,
              ownedTabs: extensionEditor
                ? vscode.window.tabGroups.all
                    .flatMap((group) => group.tabs)
                    .filter(
                      (tab) =>
                        tab.input instanceof vscode.TabInputText &&
                        tab.input.uri.toString() === extensionEditor?.uri.toString(),
                    ).length
                : 0,
            };
            break;
          }
          case "extensionEditorEdit": {
            const editor = vscode.window.activeTextEditor;
            assert.equal(editor?.document.uri.scheme, "untitled");
            assert.ok(editor);
            const document = editor.document;
            assert.ok(
              await editor.edit((edit) =>
                edit.replace(
                  new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
                  request.text,
                ),
              ),
            );
            break;
          }
          case "extensionEditorOtherDocument":
            await vscode.window.showTextDocument(source);
            await vscode.commands.executeCommand("pi.extensionEditor.submit");
            await vscode.commands.executeCommand("pi.extensionEditor.cancel");
            break;
          case "extensionEditorRefocus":
            assert.ok(extensionEditor);
            await vscode.window.showTextDocument(extensionEditor);
            break;
          case "extensionEditorClose":
            assert.ok(vscode.window.tabGroups.activeTabGroup.activeTab);
            result = await vscode.window.tabGroups.close(vscode.window.tabGroups.activeTabGroup.activeTab);
            break;
          case "closePiTerminal": {
            const terminals = await Promise.all(
              vscode.window.terminals.map(async (terminal) => ({
                terminal,
                name: terminal.name,
                pid: await terminal.processId,
              })),
            );
            const owned = terminals.filter((item) => item.pid === request.pid);
            for (const item of owned) item.terminal.dispose();
            result = { closed: owned.length, terminals: terminals.map(({ name, pid }) => ({ name, pid })) };
            break;
          }
          case "nativeSettingsDirty": {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ".pi", "settings.json"));
            const editor = await vscode.window.showTextDocument(document);
            await editor.edit((edit) =>
              edit.replace(new vscode.Range(0, 0, document.lineCount, 0), '{"userDraft":"retained"}\n'),
            );
            result = { dirty: document.isDirty, path: document.uri.fsPath };
            break;
          }
          case "nativeSettingsSave": {
            const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, ".pi", "settings.json"));
            result = { saved: await document.save(), text: document.getText() };
            break;
          }
          case "settingsState":
            result = {
              values: Object.fromEntries(
                [
                  "executablePath",
                  "provider",
                  "model",
                  "thinkingLevel",
                  "approveProjectResources",
                  "sensitiveContextNames",
                  "annotations.initialState",
                  "inlineCompletions.enabled",
                  "inlineCompletions.debounceMilliseconds",
                  "inlineCompletions.minimumPrefixLength",
                  "inlineCompletions.excludedLanguages",
                ].map((key) => [key, vscode.workspace.getConfiguration("pi").inspect(key)]),
              ),
              nativeTabs: vscode.window.tabGroups.all
                .flatMap((group) => group.tabs)
                .map((tab) => ({
                  label: tab.label,
                  webview: tab.input instanceof vscode.TabInputWebview,
                })),
              model: vscode.workspace.getConfiguration("pi").inspect("model"),
              tabs: vscode.window.tabGroups.all
                .flatMap((group) => group.tabs)
                .filter((tab) => tab.label === "Pi Configuration").length,
            };
            break;
          case "selection": {
            const editor = await vscode.window.showTextDocument(source);
            const range = request.range ?? [0, 0, 0, source.lineAt(0).text.length];
            assert.ok(Array.isArray(range) && range.length === 4 && range.every(Number.isInteger));
            editor.selection = new vscode.Selection(range[0], range[1], range[2], range[3]);
            result = source.getText(editor.selection);
            break;
          }
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
          case "completionExclusions":
            await vscode.workspace
              .getConfiguration("search")
              .update(
                "exclude",
                { "**/{completion-excluded,completion-other-excluded}/**": true },
                vscode.ConfigurationTarget.Workspace,
              );
            break;
          case "completionDirty": {
            const document: vscode.TextDocument = await vscode.workspace.openTextDocument(
              vscode.Uri.joinPath(root, "completion-capture.txt"),
            );
            const editor: vscode.TextEditor = await vscode.window.showTextDocument(document);
            assert.ok(
              await editor.edit((edit) =>
                edit.replace(new vscode.Range(0, 0, document.lineCount, 0), "completion dirty snapshot\n"),
              ),
            );
            assert.ok(document.isDirty);
            break;
          }
          case "completionInspection":
            result = vscode.window.activeTextEditor?.document.getText() ?? "";
            break;
          case "transferInspection": {
            let editor: vscode.TextEditor | undefined;
            for (let attempt = 0; attempt < 100 && !editor; attempt++) {
              editor = vscode.window.visibleTextEditors.find(
                (candidate) =>
                  candidate.document.uri.scheme === "pi-session-inspection" &&
                  candidate.document.uri.path.endsWith(`-${request.revision}.jsonl`),
              );
              if (!editor) await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(editor?.document.uri.scheme, "pi-session-inspection");
            assert.ok(editor);
            const text = editor.document.getText();
            result = {
              text,
              editAccepted: await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "forbidden")),
              unchanged: editor.document.getText() === text,
            };
            break;
          }
          case "theme":
            await vscode.workspace
              .getConfiguration("workbench")
              .update("colorTheme", request.theme, vscode.ConfigurationTarget.Global);
            break;
          case "zoom":
            await vscode.workspace
              .getConfiguration("window")
              .update("zoomLevel", request.level, vscode.ConfigurationTarget.Global);
            break;
          case "diagnostics":
            publish();
            break;
          case "dirtyReviewTarget": {
            const editor = await vscode.window.showTextDocument(other);
            assert.ok(await editor.edit((edit) => edit.insert(new vscode.Position(0, 0), "// unsaved\n")));
            assert.ok(other.isDirty);
            const finding = vscode.languages
              .getDiagnostics()
              .find(
                ([uri, items]) =>
                  uri.scheme === "pi-review" && items.some((item) => item.message === "Native workingTree finding"),
              );
            assert.ok(finding);
            await vscode.workspace.openTextDocument(finding[0]);
            const diagnostic = finding[1].find((item) => item.message === "Native workingTree finding");
            assert.ok(diagnostic);
            const actions = await vscode.commands.executeCommand<(vscode.CodeAction | vscode.Command)[]>(
              "vscode.executeCodeActionProvider",
              finding[0],
              diagnostic.range,
            );
            const findingActions =
              actions?.filter(
                (action): action is vscode.CodeAction =>
                  typeof action.command === "object" &&
                  ["pi.askReviewFinding", "pi.fixReviewFinding"].includes(action.command.command),
              ) ?? [];
            assert.deepEqual(
              findingActions.map((action) => action.command?.command),
              ["pi.askReviewFinding"],
            );
            const args = findingActions[0]?.command?.arguments;
            assert.ok(args);
            await assert.rejects(
              Promise.resolve(vscode.commands.executeCommand("pi.fixReviewFinding", ...args)),
              /no longer matches/,
            );
            break;
          }
          case "state":
            result = {
              texts: [source.getText(), other.getText()],
              active: vscode.window.activeTextEditor?.document.uri.toString(),
              findings: vscode.languages
                .getDiagnostics()
                .filter(([uri, items]) => uri.scheme === "pi-review" && items.length > 0)
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
    sessionSwitchTerminal?.dispose();
    sessionSwitchTerminalWrite.dispose();
    subscription.dispose();
    annotationPrototype.dispose();
    diagnostics.dispose();
  }
}
