import * as vscode from "vscode";
import path from "node:path";
import { realpath } from "node:fs/promises";
import { assertSafeFile, readRegularText } from "./backgroundResults";
import { runBoundedProcess, type ProcessResult } from "./boundedProcess";
import { computeEditHunks, selectedReplacement } from "./editHunks";
import { digest } from "./gitSnapshots";
import { acquireOperation } from "./operationLocks";
import type { PiConversationController } from "./conversationController";
import type { PiRuntimeManager } from "./piRuntime";
import { extractReplacement } from "./prompts";
import { boundedFailure, noTestsMatched, redactRecognizableSecrets, RepairAttempts, validateTestCommand, type TestCommand } from "./testRepair";
import { assertRuntimeTarget, cancellable, inspectForTransmission, pickWorkspace, requireTrustedFile, WorkflowDocuments, workflowCommand } from "./workflowUi";

export function registerTestRepair(context: vscode.ExtensionContext, runtime: PiRuntimeManager, conversation: PiConversationController): void {
  const documents = new WorkflowDocuments();
  context.subscriptions.push(documents);
  let active = false;
  workflowCommand(context, "picode.repairFailedTest", async () => {
    if (active) throw new Error("A test repair invocation is already active.");
    active = true;
    try {
      const folder = await pickWorkspace(); if (!folder) return;
      await assertRuntimeTarget(runtime, folder.fsPath);
      const sessionId = runtime.currentState.sessionId;
      const value = await vscode.window.showInputBox({ title: "Approved test command (JSON)", prompt: 'Executable and arguments only; no shell expressions. Example: {"executable":"node","args":["--test","test/example.test.js"]}' });
      if (!value) return;
      const command = validateTestCommand(JSON.parse(value));
      const sourceChoice = await vscode.window.showOpenDialog({ title: "Select the single source file to propose repairing", defaultUri: folder, canSelectMany: false, filters: { Source: ["*"] } });
      const uri = sourceChoice?.[0]; if (!uri) return;
      requireTrustedFile(uri);
      if (vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() !== folder.toString()) throw new Error("Choose a source file in the selected workspace.");
      const root = await realpath(folder.fsPath);
      const relative = path.relative(root, uri.fsPath).split(path.sep).join("/");
      await assertSafeFile(root, relative);
      const document = await vscode.workspace.openTextDocument(uri);
      const captureSource = async () => {
        const before = document.getText(), version = document.version;
        if (before.length > 200_000) throw new Error("Repair source is limited to 200,000 characters.");
        if (document.isClosed || document.isDirty) throw new Error("Save the selected source before capturing test evidence.");
        if (await readRegularText(root, relative, 800_000) !== before) throw new Error("Source disk contents differ from the editor; capture fresh test evidence.");
        if (document.isClosed || document.isDirty || document.version !== version) throw new Error("Source changed during test evidence capture.");
        return { before, version };
      };
      const validateSource = async (snapshot: { before: string; version: number }) => {
        const current = await captureSource();
        if (current.before !== snapshot.before || current.version !== snapshot.version) throw new Error("Source changed around the test run; capture fresh test evidence.");
      };
      const method = await vscode.window.showQuickPick(["Run Approved Command", "Supply Existing Failure Log"], { title: "Capture test evidence" });
      if (!method) return;
      let testedSource = await captureSource();
      let output: string;
      let evidence: { exitCode: number | null; status: ProcessResult["status"] | "supplied-log"; truncated: boolean };
      if (method === "Supply Existing Failure Log") {
        const logUri = (await vscode.window.showOpenDialog({ title: "Select existing UTF-8 failure log (up to 100,000 bytes; supplied, not observed evidence)", defaultUri: folder, canSelectMany: false, canSelectFiles: true, canSelectFolders: false }))?.[0];
        if (!logUri) return;
        requireTrustedFile(logUri);
        const input = await readRegularText(await realpath(path.dirname(logUri.fsPath)), path.basename(logUri.fsPath), 100_000);
        if (input === undefined) throw new Error("Failure log no longer exists.");
        output = input;
        evidence = { exitCode: null, status: "supplied-log", truncated: false };
      } else {
        const initial = await runApproved(command, folder.fsPath, sessionId, () => validateSource(testedSource)); if (!initial) return;
        output = initial.stdout.toString("utf8") + initial.stderr.toString("utf8");
        evidence = { exitCode: initial.exitCode, status: initial.status, truncated: initial.status === "output-limit" };
        if (initial.status !== "exited" || initial.exitCode === 0 || noTestsMatched(output)) {
          await documents.inspect("Test command evidence", `${initial.status}; exit ${initial.exitCode}; ${initial.cleanup}\n${output}`); return;
        }
      }
      const attempts = new RepairAttempts(output);
      while (!attempts.stopped) {
        await assertRuntimeTarget(runtime, folder.fsPath, sessionId);
        await validateSource(testedSource);
        const { before, version } = testedSource;
        const bounded = boundedFailure(output);
        const snapshot = { repository: folder.fsPath, command, exitCode: evidence.exitCode, status: evidence.status, output: redactRecognizableSecrets(bounded.output), truncated: bounded.truncated || evidence.truncated,
          source: { path: uri.fsPath, hash: digest(before), text: before }, capturedAt: new Date().toISOString(), attemptsRemaining: 2 - attempts.attempts };
        const inspected = await inspectForTransmission(documents, "Test repair context", JSON.stringify(snapshot, null, 2), 400_000);
        if (inspected === undefined) return;
        const validate = () => {
          if (document.isClosed || document.isDirty || document.version !== version) throw new Error("Source changed while inspecting the failure; start a fresh repair.");
          if (runtime.currentState.sessionId !== sessionId) throw new Error("Session changed; start a fresh repair.");
        };
        validate();
        await validateSource(testedSource);
        await assertRuntimeTarget(runtime, folder.fsPath, sessionId);
        attempts.approve();
        const response = await conversation.sendRequest("Propose one focused fix for the selected source file and failure. Do not execute tests or modify files.", [{ label: "Inspected test failure and source", content: inspected }], {
          resource: folder, policy: "read-only", validate, instructions: "Return only <<<PICODE_REPLACEMENT_START>>>, newline, the complete replacement source text, newline, <<<PICODE_REPLACEMENT_END>>>. The approved test command is evidence, not a request to execute it. Do not change it.",
        });
        const replacement = extractReplacement(response);
        if (replacement === undefined) throw new Error("Invalid repair proposal; no edits or rerun.");
        const after = document.eol === vscode.EndOfLine.CRLF ? replacement.replace(/\n/g, "\r\n") : replacement;
        const { hunks } = computeEditHunks(before, after);
        if (!hunks.length) { attempts.stop("No proposed changes"); break; }
        const applied = await new Promise<boolean>(resolve => {
          let previewKey: string | undefined;
          let preview: vscode.Uri | undefined;
          const check = () => {
            requireTrustedFile(uri);
            if (document.isClosed || document.version !== version) throw new Error("Source changed; regenerate the repair.");
            if (runtime.currentState.sessionId !== sessionId) throw new Error("Session changed; regenerate the repair.");
          };
          conversation.addEditProposal({ label: `Test repair ${attempts.attempts}/2: ${uri.fsPath}`, hunks,
            onPreview: async ids => {
              check();
              if (preview) documents.release(preview);
              preview = documents.create("test-repair-preview", selectedReplacement(before, hunks, ids ?? []));
              await vscode.commands.executeCommand("vscode.diff", uri, preview, "Pi Test Repair Preview", { preview: true });
              previewKey = JSON.stringify(ids);
            },
            onApply: async ids => {
              check();
              if (!preview || previewKey !== JSON.stringify(ids)) throw new Error("Preview the selected repair hunks first.");
              const edit = new vscode.WorkspaceEdit();
              edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(before.length)), selectedReplacement(before, hunks, ids ?? []));
              if (!await vscode.workspace.applyEdit(edit)) throw new Error("Repair Apply failed; no rerun.");
              resolve(true);
            }, onReject: () => resolve(false), onDispose: () => { if (preview) documents.release(preview); resolve(false); },
          });
        });
        if (!applied) { attempts.stop("Rejected/cancelled"); break; }
        // Reruns read disk, so saving is separate and explicit; preserve failed save/cancel outcomes.
        if (await vscode.window.showWarningMessage("Save the repaired source and rerun the same approved test command?", { modal: true }, "Save and Rerun") !== "Save and Rerun") return;
        await assertRuntimeTarget(runtime, folder.fsPath, sessionId);
        if (!await document.save()) throw new Error("Source could not be saved; no rerun.");
        testedSource = await captureSource();
        const rerun = await runApproved(command, folder.fsPath, sessionId, () => validateSource(testedSource)); if (!rerun) return;
        output = rerun.stdout.toString("utf8") + rerun.stderr.toString("utf8");
        evidence = { exitCode: rerun.exitCode, status: rerun.status, truncated: rerun.status === "output-limit" };
        attempts.observe(rerun.exitCode, output, rerun.status);
        await documents.inspect("Observed test rerun", `Attempt ${attempts.attempts}/2; ${rerun.status}; exit ${rerun.exitCode}\n${rerun.cleanup}\n${attempts.stopped ?? "Failure remains; one approved attempt remains."}\n${output}`);
      }
    } finally { active = false; }
  });

  async function runApproved(command: TestCommand, cwd: string, sessionId: string | undefined, validateSource: () => Promise<void>): Promise<ProcessResult | undefined> {
    await assertRuntimeTarget(runtime, cwd, sessionId);
    const approval = await vscode.window.showWarningMessage(`Run in ${cwd}:\n${JSON.stringify(command)}\nWorkspace code executes with your permissions. 60-second timeout, 256 KiB output limit. ${process.platform === "win32" ? "Windows descendant cleanup cannot be guaranteed." : "Owned process-group cleanup enabled."}`, { modal: true }, "Run Test Command");
    if (approval !== "Run Test Command") return undefined;
    await assertRuntimeTarget(runtime, cwd, sessionId);
    const release = acquireOperation(await realpath(cwd), "test command");
    try {
      await validateSource();
      const result = await cancellable("Run approved tests", signal => runBoundedProcess(command.executable, command.args, { cwd, signal, timeoutMs: 60_000, maxBytes: 256 * 1024 }));
      await validateSource();
      return result;
    } finally { release(); }
  }
}
