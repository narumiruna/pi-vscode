import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { runIsolatedPiHelper } from "./isolatedPi";
import type { PiRpcClient } from "./piRpcClient";
import type { PiRuntimeManager } from "./piRuntime";
import type { PiSessionTransferSnapshot } from "./piRuntimeControl";
import { redactSessionPayload, uploadSessionGist } from "./sessionShare";
import {
  assertSessionJsonlWorkspace,
  hashSessionEntries,
  maxSessionTransferBytes,
  maxShareBytes,
  readTransferFile,
  validateSessionJsonl,
  writeTransferFile,
} from "./sessionTransfer";
import { readPiInvocationOptions } from "./vscodePi";

function sameSnapshot(a: PiSessionTransferSnapshot, b: PiSessionTransferSnapshot): boolean {
  return (
    a.sessionId === b.sessionId &&
    a.sessionFile === b.sessionFile &&
    a.sessionDir === b.sessionDir &&
    a.leafId === b.leafId &&
    a.entriesHash === b.entriesHash
  );
}

/** Native dialogs only. Payload inspection is memory-only and cannot execute session content. */
export function registerSessionTransfer(context: vscode.ExtensionContext, runtime: PiRuntimeManager): void {
  const inspections = new Map<string, string>();
  const controllers = new Set<AbortController>();
  let disposed = false;
  context.subscriptions.push(
    {
      dispose: () => {
        disposed = true;
        inspections.clear();
        for (const controller of controllers) controller.abort();
        controllers.clear();
      },
    },
    vscode.workspace.registerTextDocumentContentProvider("pi-session-inspection", {
      provideTextDocumentContent: (uri) => inspections.get(uri.toString()) ?? "This session inspection has expired.",
    }),
  );
  const helper = path.join(context.extensionUri.fsPath, "resources", "pi-isolated-helper.ts");
  const command = (
    id: string,
    label: string,
    action: (client: PiRpcClient, assertCurrent: () => Promise<void>, signal: AbortSignal) => Promise<void>,
  ): void => {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, async () => {
        const controller = new AbortController();
        controllers.add(controller);
        try {
          await runtime.withForegroundOperation(label, async (client, assertCurrent) => {
            const check = async (): Promise<void> => {
              if (disposed || controller.signal.aborted) throw new Error("Session transfer cancelled.");
              await assertCurrent();
            };
            await action(client, check, controller.signal);
          });
        } catch (error) {
          await vscode.window.showWarningMessage(
            error instanceof Error ? error.message : "The session transfer did not complete. No operation was retried.",
          );
        } finally {
          controller.abort();
          controllers.delete(controller);
        }
      }),
    );
  };
  const stage = async <T>(action: (directory: string) => Promise<T>): Promise<T> => {
    let directory = await mkdtemp(path.join(tmpdir(), "pi-transfer-"));
    try {
      directory = await realpath(directory);
      return await action(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  };
  const prepareActiveBranchExport = async (
    client: PiRpcClient,
    check: () => Promise<void>,
    signal: AbortSignal,
    directory: string,
  ): Promise<{ payload: Buffer; revalidate: () => Promise<void> }> => {
    await check();
    const snapshot = await runtime.getSessionTransferSnapshot(client, check);
    const source = snapshot.sessionFile;
    // The descriptor-bound reader checks the 32 MiB file bound before parsing or SDK handoff.
    const bytes = await readTransferFile(source);
    const session = validateSessionJsonl(bytes);
    await assertSessionJsonlWorkspace(session, runtime.currentCwd);
    if (
      session.header.id !== snapshot.sessionId ||
      hashSessionEntries(session.entries) !== snapshot.entriesHash ||
      (snapshot.leafId !== null && !session.entries.some((entry) => entry.id === snapshot.leafId))
    )
      throw new Error("The persisted session does not match Pi's active entries. Save or refresh Pi before exporting.");
    const input = path.join(directory, "source.jsonl");
    const output = path.join(directory, "branch.jsonl");
    await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
    const revalidate = async (): Promise<void> => {
      await check();
      const actual = await runtime.getSessionTransferSnapshot(client, check, snapshot.leafId);
      if (!sameSnapshot(actual, snapshot) || !(await readTransferFile(source)).equals(bytes))
        throw new Error("The Pi session branch or source file changed. Prepare a new export.");
      await check();
    };
    await runIsolatedPiHelper(
      readPiInvocationOptions(vscode.Uri.file(runtime.currentCwd)),
      helper,
      {
        operation: "export",
        cwd: runtime.currentCwd,
        input,
        output,
        leaf: snapshot.leafId,
      },
      undefined,
      signal,
    );
    const payload = await readTransferFile(output);
    await assertSessionJsonlWorkspace(validateSessionJsonl(payload), runtime.currentCwd);
    await revalidate();
    return { payload, revalidate };
  };
  command("pi.exportSession", "export Pi session", async (client, check, signal) => {
    const format = await vscode.window.showQuickPick(
      [
        { label: "HTML — complete session tree", format: "html" },
        { label: "JSONL — active branch only", format: "jsonl" },
      ],
      { title: "Export Pi Session: Format and Scope" },
    );
    if (!format) return;
    await check();
    const target = await vscode.window.showSaveDialog({
      title: "Export Pi Session (New File Only)",
      defaultUri: vscode.Uri.file(path.join(runtime.currentCwd, `pi-session.${format.format}`)),
      filters: format.format === "html" ? { HTML: ["html"] } : { "Pi active branch": ["jsonl"] },
      saveLabel: "Export New File",
    });
    if (!target) return;
    if (target.scheme !== "file") throw new Error("Export requires a local file in this Extension Host.");
    await check();
    await stage(async (directory) => {
      let payload: Buffer;
      if (format.format === "jsonl") {
        const branch = await prepareActiveBranchExport(client, check, signal, directory);
        payload = branch.payload;
        await branch.revalidate();
      } else {
        // Keep Pi's existing renderer and full-tree HTML behavior, but stage before exclusive creation.
        const output = path.join(directory, "session.html");
        const exported = await client.exportHtml(output);
        if (exported !== output) throw new Error("Pi did not export to the approved staging file.");
        await check();
        payload = await readTransferFile(output, maxSessionTransferBytes);
      }
      await check();
      await writeTransferFile(target.fsPath, payload);
      void vscode.window.showInformationMessage(
        `Pi session exported to ${target.fsPath}. Existing files are never replaced.`,
      );
    });
  });
  command("pi.importSession", "import Pi session", async (client, check, signal) => {
    const selected = await vscode.window.showOpenDialog({
      title: "Import a Copy of a Pi v3 Session",
      canSelectFiles: true,
      canSelectFolders: false,
      canSelectMany: false,
      filters: { "Pi sessions": ["jsonl"] },
      openLabel: "Validate Import",
    });
    const source = selected?.[0];
    if (!source) return;
    if (source.scheme !== "file") throw new Error("Import requires a regular file in this Extension Host.");
    await check();
    const bytes = await readTransferFile(source.fsPath);
    const session = validateSessionJsonl(bytes);
    await assertSessionJsonlWorkspace(session, runtime.currentCwd);
    const snapshot = await runtime.getSessionTransferSnapshot(client, check);
    const approval = await vscode.window.showWarningMessage(
      `Import ${session.entries.length} entries as a new copy and activate it? Its working directory matches this workspace. The source and old session file stay unchanged.`,
      { modal: true },
      "Import Copy",
    );
    if (approval !== "Import Copy") return;
    await check();
    if (!(await readTransferFile(source.fsPath)).equals(bytes))
      throw new Error("The selected import changed. Select it again.");
    await stage(async (directory) => {
      const input = path.join(directory, "import.jsonl");
      const output = path.join(directory, "validated.jsonl");
      await writeFile(input, bytes, { flag: "wx", mode: 0o600 });
      await runIsolatedPiHelper(
        readPiInvocationOptions(vscode.Uri.file(runtime.currentCwd)),
        helper,
        {
          operation: "import",
          cwd: runtime.currentCwd,
          input,
          output,
        },
        undefined,
        signal,
      );
      const imported = await readTransferFile(output);
      await assertSessionJsonlWorkspace(validateSessionJsonl(imported), runtime.currentCwd);
      await check();
      if (!(await readTransferFile(source.fsPath)).equals(bytes))
        throw new Error("The import source changed. No copy was activated.");
      if (!sameSnapshot(snapshot, await runtime.getSessionTransferSnapshot(client, check, snapshot.leafId)))
        throw new Error("The active Pi session changed. Prepare a new import.");
      const target = path.join(snapshot.sessionDir, `import-${randomUUID()}.jsonl`);
      await writeTransferFile(target, imported);
      try {
        await check();
        if (!sameSnapshot(snapshot, await runtime.getSessionTransferSnapshot(client, check, snapshot.leafId)))
          throw new Error("The active Pi session changed before activation.");
        // Runtime reconciles actual session state and emits session_imported only after verified activation.
        await runtime.activateImportedSession(client, target);
      } catch {
        throw new Error(
          `The imported copy remains at ${target}, but activation or history refresh did not complete. The source and old session file were retained. Verify the active session before selecting the copy; no switch was retried.`,
        );
      }
      void vscode.window.showInformationMessage(
        "Pi imported and activated the validated copy. The source was not changed.",
      );
    });
  });
  command("pi.shareSession", "share Pi session", async (client, check, signal) => {
    const destination = await vscode.window.showQuickPick(
      [
        {
          label: "GitHub non-public gist",
          destination: "gist",
          detail: "Requires an authenticated gh CLI on this Extension Host. Anyone with the link can read it.",
        },
        {
          label: "Radius — unavailable",
          destination: "radius",
          detail: "Blocked: Pi 1.3.0 has no verified public artifact-upload API.",
        },
      ],
      { title: "Share Pi Session: Choose Destination", matchOnDetail: true },
    );
    if (!destination) return;
    await check();
    if (destination.destination === "radius")
      throw new Error("Radius sharing is blocked pending a public upload contract. No private endpoint was used.");
    await stage(async (directory) => {
      const branch = await prepareActiveBranchExport(client, check, signal, directory);
      let payload = branch.payload;
      if (payload.length > maxShareBytes)
        throw new Error("Sharing supports at most 2 MiB. Use local export for larger sessions.");
      let revision = 0;
      let inspected = false;
      const uris: string[] = [];
      try {
        for (let steps = 0; steps < 100; steps++) {
          const action = await vscode.window.showQuickPick(
            [
              { label: "Inspect exact active-branch JSONL payload", action: "inspect" },
              { label: "Redact a literal from string values", action: "redact" },
              ...(inspected ? [{ label: "Continue to upload approval", action: "upload" }] : []),
            ],
            { title: `Prepare Share: ${payload.length} bytes, active branch only (no upload yet)` },
          );
          if (!action) return;
          await branch.revalidate();
          if (action.action === "inspect") {
            const uri = vscode.Uri.from({
              scheme: "pi-session-inspection",
              path: `/share-${randomUUID()}-${revision}.jsonl`,
            });
            inspections.clear();
            inspections.set(uri.toString(), payload.toString("utf8"));
            uris.push(uri.toString());
            const document = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(document, { preview: true });
            inspected = true;
          } else if (action.action === "redact") {
            let literal = await vscode.window.showInputBox({
              title: "Redact Session Share",
              prompt: "Literal to replace in JSON string values. The next payload must be inspected again.",
              password: true,
              validateInput: (value) => (!value || value.length > 8_192 ? "Enter 1 to 8,192 characters." : undefined),
            });
            if (literal === undefined) continue;
            await branch.revalidate();
            payload = redactSessionPayload(payload, literal);
            inspections.clear();
            literal = undefined;
            revision++;
            inspected = false;
          } else {
            const approval = await vscode.window.showWarningMessage(
              `Upload the inspected ${payload.length}-byte active-branch JSONL to a non-public GitHub gist using this Extension Host's gh account? Prompts, !! shell entries, images, tool arguments/output, thinking signatures and custom metadata can contain secrets. A non-public gist is not confidential storage: anyone with the link can read it. Redacted JSONL may no longer be resumable. Delete the gist separately on GitHub; local deletion does not remove it.`,
              { modal: true },
              "Upload Inspected Payload",
            );
            if (approval !== "Upload Inspected Payload") return;
            await branch.revalidate();
            const url = await vscode.window.withProgress(
              {
                location: vscode.ProgressLocation.Notification,
                title: "Upload Pi session to GitHub gist (no automatic retry)",
                cancellable: true,
              },
              async (_progress, token) => {
                const controller = new AbortController();
                const abort = (): void => controller.abort();
                signal.addEventListener("abort", abort, { once: true });
                const cancellation = token.onCancellationRequested(abort);
                if (signal.aborted || token.isCancellationRequested) controller.abort();
                try {
                  return await uploadSessionGist(payload, runtime.currentCwd, controller.signal);
                } finally {
                  cancellation.dispose();
                  signal.removeEventListener("abort", abort);
                }
              },
            );
            // Do not hide an uploaded artifact if the session origin changed after network submission.
            const open = await vscode.window.showInformationMessage(
              `Uploaded non-public gist: ${url}. Delete it separately on GitHub.`,
              "Open Gist",
            );
            if (open === "Open Gist") await vscode.env.openExternal(vscode.Uri.parse(url, true));
            return;
          }
        }
        throw new Error("Share preparation reached its 100-step limit. Nothing was uploaded.");
      } finally {
        for (const uri of uris) inspections.delete(uri);
        payload = Buffer.alloc(0);
      }
    });
  });
}
