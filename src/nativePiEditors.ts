import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type * as vscode from "vscode";

function isTarget(file: string, targets: readonly string[]): boolean {
  const insensitive = process.platform === "win32" || process.platform === "darwin";
  return targets.some((target) => target === file || (insensitive && target.toUpperCase() === file.toUpperCase()));
}

/** Only a proved missing non-target path can bypass full realpath resolution. */
async function resolveEditorPath(file: string, targets: readonly string[]): Promise<string> {
  try {
    return await realpath(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const suffix: string[] = [];
  let ancestor = file;
  while (true) {
    try {
      await lstat(ancestor);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(ancestor);
      if (parent === ancestor) throw new Error("No verifiable native editor ancestor.");
      suffix.unshift(path.basename(ancestor));
      ancestor = parent;
      continue;
    }
    // Do not climb past a dangling link: it can hide an alias to the configuration target.
    const canonicalParent = await realpath(ancestor);
    if (!(await lstat(canonicalParent)).isDirectory()) throw new Error("Unverifiable missing native editor path.");
    const canonical = path.join(canonicalParent, ...suffix);
    if (isTarget(canonical, targets)) throw new Error("Native configuration has a missing editor file.");
    return canonical;
  }
}

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
  const bindings = await Promise.all(
    captured.map(async (item) => ({ ...item, canonical: await resolveEditorPath(item.path, targets) })),
  );
  // A matching editor changing during initial path resolution cannot become the accepted baseline.
  for (const item of bindings)
    if (
      isTarget(item.canonical, targets) &&
      (item.version !== item.document.version || item.dirty !== item.document.isDirty)
    )
      throw new Error("Native configuration editor changed during capture.");
  return async (current) => {
    const candidates = snapshots(current);
    const resolved = await Promise.all(
      candidates.map(async (item) => ({ ...item, canonical: await resolveEditorPath(item.path, targets) })),
    );
    for (const original of bindings) {
      if ((await resolveEditorPath(original.path, targets)) !== original.canonical)
        throw new Error("Native editor alias was retargeted.");
      if (
        isTarget(original.canonical, targets) &&
        (original.document.version !== original.version || original.document.isDirty !== original.dirty)
      )
        throw new Error("Native configuration editor changed. Reload before saving.");
    }
    for (const item of resolved)
      if (
        isTarget(item.canonical, targets) &&
        (item.dirty || item.document.isDirty || item.document.version !== item.version)
      )
        throw new Error("Native configuration has an unsaved or changed editor buffer.");
  };
}
