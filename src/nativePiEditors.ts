import { realpath } from "node:fs/promises";
import type * as vscode from "vscode";

/** Capture before dialogs. Retain editor URI aliases instead of opening canonical shadow buffers. */
export async function captureNativeEditorGuard(
  documents: readonly vscode.TextDocument[],
  targets: readonly string[],
): Promise<(current: readonly vscode.TextDocument[]) => Promise<void>> {
  const snapshots = (items: readonly vscode.TextDocument[]) => {
    const files = items.filter((document) => document.uri.scheme === "file");
    if (files.length > 1000)
      throw new Error("Too many open file-backed editors to verify native configuration safely.");
    return files.map((document) => ({
      document,
      path: document.uri.fsPath,
      version: document.version,
      dirty: document.isDirty,
    }));
  };
  const captured = snapshots(documents);
  const bindings = await Promise.all(captured.map(async (item) => ({ ...item, canonical: await realpath(item.path) })));
  // A matching editor changing during initial path resolution cannot become the accepted baseline.
  for (const item of bindings)
    if (
      targets.includes(item.canonical) &&
      (item.version !== item.document.version || item.dirty !== item.document.isDirty)
    )
      throw new Error("Native configuration editor changed during capture.");
  return async (current) => {
    const candidates = snapshots(current);
    const resolved = await Promise.all(
      candidates.map(async (item) => ({ ...item, canonical: await realpath(item.path) })),
    );
    for (const original of bindings) {
      if ((await realpath(original.path)) !== original.canonical)
        throw new Error("Native editor alias was retargeted.");
      if (
        targets.includes(original.canonical) &&
        (original.document.version !== original.version || original.document.isDirty !== original.dirty)
      )
        throw new Error("Native configuration editor changed. Reload before saving.");
    }
    for (const item of resolved)
      if (
        targets.includes(item.canonical) &&
        (item.dirty || item.document.isDirty || item.document.version !== item.version)
      )
        throw new Error("Native configuration has an unsaved or changed editor buffer.");
  };
}
