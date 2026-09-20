import path from "node:path";
import * as vscode from "vscode";
import { assertSafeFile } from "./backgroundResults";
import type { PiConversationController } from "./conversationController";
import { computeEditHunks, selectedReplacement } from "./editHunks";
import { acquireOperation } from "./operationLocks";
import { requireTrustedFile } from "./workflowUi";

const maxProposalFiles = 20;

export interface DocumentEditSnapshot {
  readonly document: vscode.TextDocument;
  readonly version: number;
  readonly range: vscode.Range;
}

export interface MultiFileEditSnapshot {
  readonly root: string;
  readonly files: readonly {
    readonly path: string;
    readonly document: vscode.TextDocument;
    readonly version: number;
    readonly original: string;
    readonly replacement: string;
  }[];
}

export class EditPreviewProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  public readonly scheme = `picode-edit-preview-${randomId()}`;
  private readonly contents = new Map<string, string>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  public readonly onDidChange = this.emitter.event;

  public create(original: vscode.Uri, content: string): vscode.Uri {
    const uri = vscode.Uri.from({ scheme: this.scheme, path: original.path, query: randomId() });
    this.contents.set(uri.toString(), content);
    return uri;
  }

  public delete(uri: vscode.Uri): void {
    this.contents.delete(uri.toString());
  }

  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "";
  }

  public dispose(): void {
    this.contents.clear();
    this.emitter.dispose();
  }
}

export function registerEditPreviewProvider(context: vscode.ExtensionContext): EditPreviewProvider {
  const previews = new EditPreviewProvider();
  context.subscriptions.push(previews, vscode.workspace.registerTextDocumentContentProvider(previews.scheme, previews));
  return previews;
}

export function addDocumentEditProposal(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  snapshot: DocumentEditSnapshot,
  replacement: string,
  label = `${path.basename(snapshot.document.uri.fsPath)}:${snapshot.range.start.line + 1}-${snapshot.range.end.line + 1}`,
  validate?: () => Promise<void>,
): string {
  assertDocumentSnapshotCurrent(
    snapshot,
    "The document changed while Pi was working. Regenerate the edit before previewing it.",
  );
  const convertedReplacement = convertLineEndings(replacement, snapshot.document.eol);
  const originalText = snapshot.document.getText();
  const startOffset = snapshot.document.offsetAt(snapshot.range.start);
  const endOffset = snapshot.document.offsetAt(snapshot.range.end);
  const originalTarget = originalText.slice(startOffset, endOffset);
  const { hunks } = computeEditHunks(originalTarget, convertedReplacement);
  if (!hunks.length) throw new Error("Pi proposed no changes.");
  let previewUri: vscode.Uri | undefined;
  let previewSelection: string | undefined;
  return conversation.addEditProposal({
    label,
    hunks,
    onPreview: async (selected) => {
      requireTrustedFile(snapshot.document.isUntitled ? undefined : snapshot.document.uri);
      await validate?.();
      assertDocumentSnapshotCurrent(
        snapshot,
        "The document changed after Pi generated the proposal. Regenerate the edit before previewing it.",
      );
      const target = selectedReplacement(originalTarget, hunks, selected ?? hunks.map((hunk) => hunk.id));
      if (previewUri) previews.delete(previewUri);
      previewUri = previews.create(
        snapshot.document.uri,
        originalText.slice(0, startOffset) + target + originalText.slice(endOffset),
      );
      previewSelection = JSON.stringify(selected);
      await vscode.commands.executeCommand(
        "vscode.diff",
        snapshot.document.uri,
        previewUri,
        `Pi Edit Preview: ${path.basename(snapshot.document.uri.fsPath)}`,
        { preview: true },
      );
    },
    onApply: async (selected) => {
      requireTrustedFile(snapshot.document.isUntitled ? undefined : snapshot.document.uri);
      await validate?.();
      assertDocumentSnapshotCurrent(
        snapshot,
        "The document changed after Pi generated the proposal. Regenerate the edit before applying it.",
      );
      if (!previewUri || previewSelection !== JSON.stringify(selected))
        throw new Error("Preview the current hunk selection before applying.");
      const edit = new vscode.WorkspaceEdit();
      edit.replace(
        snapshot.document.uri,
        snapshot.range,
        selectedReplacement(originalTarget, hunks, selected ?? hunks.map((hunk) => hunk.id)),
      );
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code could not apply the Pi edit.");
    },
    onDispose: () => {
      if (previewUri) previews.delete(previewUri);
    },
  });
}

export function addMultiFileEditProposal(
  previews: EditPreviewProvider,
  conversation: PiConversationController,
  snapshot: MultiFileEditSnapshot,
  options?: {
    readonly label?: string;
    readonly onWillApply?: () => void;
    readonly onApplied?: () => Promise<void> | void;
    readonly onDispose?: () => void;
  },
): string {
  if (
    !snapshot.files.length ||
    snapshot.files.length > maxProposalFiles ||
    new Set(snapshot.files.map((file) => file.document.uri.toString())).size !== snapshot.files.length
  )
    throw new Error("Invalid multi-file proposal targets.");
  const files = snapshot.files
    .map((file, index) => {
      assertWorkspaceFile(snapshot.root, file.document.uri);
      assertFileCurrent(file);
      const replacement = convertLineEndings(file.replacement, file.document.eol);
      const { hunks } = computeEditHunks(file.original, replacement);
      return {
        ...file,
        replacement,
        hunks: hunks.map((hunk) => ({ ...hunk, id: `${index}:${hunk.id}`, label: `${file.path}: ${hunk.label}` })),
      };
    })
    .filter((file) => file.hunks.length > 0);
  if (!files.length) throw new Error("Pi proposed no changes.");
  const choices = files.flatMap((file) => file.hunks.map(({ id, label }) => ({ id, label })));
  const previewsByPath = new Map<string, vscode.Uri>();
  let previewSelection: string | undefined;
  return conversation.addEditProposal({
    label: options?.label ?? `${files.length} files · ${choices.length} hunks`,
    managesApplyLock: true,
    hunks: choices,
    onPreview: async (selected) => {
      requireTrustedFile(vscode.Uri.file(snapshot.root));
      for (const file of files) {
        assertWorkspaceFile(snapshot.root, file.document.uri);
        assertFileCurrent(file);
      }
      clearPreviews(previews, previewsByPath);
      previewSelection = undefined;
      const ids = checkedIds(selected, choices);
      for (const file of files) {
        const selectedIds = ids.filter((id) => file.hunks.some((hunk) => hunk.id === id));
        if (!selectedIds.length) continue;
        const target = selectedReplacement(file.original, file.hunks, selectedIds);
        const preview = previews.create(file.document.uri, target);
        previewsByPath.set(file.path, preview);
        await vscode.commands.executeCommand(
          "vscode.diff",
          file.document.uri,
          preview,
          `Pi Edit Preview: ${file.path}`,
          { preview: false },
        );
      }
      previewSelection = JSON.stringify(selected);
    },
    onApply: async (selected) => {
      requireTrustedFile(vscode.Uri.file(snapshot.root));
      if (!previewsByPath.size || previewSelection !== JSON.stringify(selected))
        throw new Error("Preview the current hunk selection before applying.");
      const release = acquireOperation(snapshot.root, "workspace edit proposal");
      try {
        for (const file of files) {
          assertWorkspaceFile(snapshot.root, file.document.uri);
          await assertSafeFile(
            snapshot.root,
            path.relative(snapshot.root, file.document.uri.fsPath).split(path.sep).join("/"),
          );
          assertFileCurrent(file);
          if (!(await isDocumentWritable(file.document))) throw new Error(`Read-only document: ${file.path}`);
        }
        // Recheck all versions after every asynchronous permission/path check.
        for (const file of files) assertFileCurrent(file);
        const ids = checkedIds(selected, choices);
        const edit = new vscode.WorkspaceEdit();
        for (const file of files) {
          const selectedIds = ids.filter((id) => file.hunks.some((hunk) => hunk.id === id));
          if (!selectedIds.length) continue;
          const range = new vscode.Range(file.document.positionAt(0), file.document.positionAt(file.original.length));
          edit.replace(file.document.uri, range, selectedReplacement(file.original, file.hunks, selectedIds));
        }
        options?.onWillApply?.();
        if (!(await vscode.workspace.applyEdit(edit)))
          throw new Error("VS Code could not apply the Pi workspace edit.");
        try {
          await options?.onApplied?.();
        } catch {
          void vscode.window.showWarningMessage(
            "Edits applied; diagnostic verification was unavailable. Do not apply again.",
          );
        }
      } finally {
        release();
      }
    },
    onDispose: () => {
      clearPreviews(previews, previewsByPath);
      options?.onDispose?.();
    },
  });
}

export function assertDocumentSnapshotCurrent(
  snapshot: Pick<DocumentEditSnapshot, "document" | "version">,
  message: string,
): void {
  if (snapshot.document.isClosed || snapshot.document.version !== snapshot.version) throw new Error(message);
}

export async function isDocumentWritable(document: vscode.TextDocument): Promise<boolean> {
  if (document.isUntitled) return true;
  if (vscode.workspace.fs.isWritableFileSystem(document.uri.scheme) !== true) return false;
  try {
    const stat = await vscode.workspace.fs.stat(document.uri);
    return ((stat.permissions ?? 0) & vscode.FilePermission.Readonly) === 0;
  } catch {
    return false;
  }
}

function assertWorkspaceFile(root: string, uri: vscode.Uri): void {
  if (uri.scheme !== "file") throw new Error("Multi-file proposals require file-backed documents.");
  const relative = path.relative(path.resolve(root), path.resolve(uri.fsPath));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("Edit target is outside the selected workspace.");
}

function assertFileCurrent(
  file: Pick<MultiFileEditSnapshot["files"][number], "document" | "version" | "original" | "path">,
): void {
  if (file.document.isClosed || file.document.version !== file.version || file.document.getText() !== file.original)
    throw new Error(`Document changed or is stale: ${file.path}`);
}

function checkedIds(selected: readonly string[] | undefined, choices: readonly { id: string }[]): readonly string[] {
  const ids = selected ?? choices.map((choice) => choice.id);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some((id) => !choices.some((choice) => choice.id === id)))
    throw new Error("Invalid hunk selection.");
  return ids;
}

function clearPreviews(previews: EditPreviewProvider, values: Map<string, vscode.Uri>): void {
  for (const uri of values.values()) previews.delete(uri);
  values.clear();
}

function convertLineEndings(value: string, lineEnding: vscode.EndOfLine): string {
  const normalized = value.replace(/\r\n/g, "\n");
  return lineEnding === vscode.EndOfLine.CRLF ? normalized.replace(/\n/g, "\r\n") : normalized;
}

function randomId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
