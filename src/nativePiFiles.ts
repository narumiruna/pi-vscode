import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseNativeJson, patchNativeJson } from "./nativePiJson";
import { acquireOperation } from "./operationLocks";
import { readWorkspaceFile, safeRelativePath } from "./workspaceFiles";

export const nativeFileByteLimit = 128 * 1024;
export type NativeScope = "global" | "project";
export type NativeFileKind = "settings" | "mcp";
export interface NativeFileTarget {
  readonly root: string;
  readonly relative: string;
  readonly scope: NativeScope;
  readonly kind: NativeFileKind;
}
export interface NativeFileSnapshot {
  readonly target: NativeFileTarget;
  readonly text: string;
  readonly revision: string;
  readonly exists: boolean;
  readonly value: Record<string, unknown>;
}

export function resolveNativeAgentDirectory(cwd: string, env = process.env, home = os.homedir()): string {
  const override = env.PI_CODING_AGENT_DIR;
  const expanded = override === "~" ? home : override?.startsWith("~/") ? path.join(home, override.slice(2)) : override;
  return path.resolve(cwd, expanded || path.join(home, ".pi", "agent"));
}

/** Bind missing files/directories to the closest existing canonical directory. */
export async function nativeFileTarget(
  directory: string,
  scope: NativeScope,
  kind: NativeFileKind,
): Promise<NativeFileTarget> {
  let root = path.resolve(directory);
  const parts = [`${kind}.json`];
  while (true) {
    try {
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(root)) !== root)
        throw new Error("Native configuration directory must be canonical and not a symlink.");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      parts.unshift(path.basename(root));
      const parent = path.dirname(root);
      if (parent === root) throw new Error("No safe native configuration directory.");
      root = parent;
    }
  }
  const relative = parts.join("/");
  if (!safeRelativePath(relative)) throw new Error("Unsafe native configuration path.");
  return Object.freeze({ root, relative, scope, kind });
}

function revision(bytes: Buffer | undefined): string {
  return bytes ? createHash("sha256").update(bytes).digest("hex") : "missing";
}

export async function readNativeFile(target: NativeFileTarget): Promise<NativeFileSnapshot> {
  const bytes = await readWorkspaceFile(target.root, target.relative, nativeFileByteLimit);
  let text: string;
  try {
    text = bytes ? new TextDecoder("utf-8", { fatal: true }).decode(bytes) : "{}\n";
  } catch {
    throw new Error("Native configuration must use valid UTF-8.");
  }
  return { target, text, revision: revision(bytes), exists: bytes !== undefined, value: parseNativeJson(text) };
}

/** Host-only snapshots may contain secrets. Never project text/value into webviews or logs. */
export async function saveNativeFile(
  snapshot: NativeFileSnapshot,
  keys: readonly string[],
  value: unknown,
  assertOrigin: () => void | Promise<void>,
): Promise<NativeFileSnapshot> {
  const text = patchNativeJson(snapshot.text, keys, value);
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length > nativeFileByteLimit) throw new Error("Native configuration exceeds 128 KiB.");
  const releases: (() => void)[] = [];
  try {
    releases.push(
      acquireOperation(path.join(snapshot.target.root, snapshot.target.relative), "saving native Pi configuration"),
    );
    await assertOrigin();
    const current = await readNativeFile(snapshot.target);
    if (current.revision !== snapshot.revision) throw new Error("Native configuration changed. Reload before saving.");
    let parent = snapshot.target.root;
    for (const part of snapshot.target.relative.split("/").slice(0, -1)) {
      parent = path.join(parent, part);
      try {
        await mkdir(parent, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const info = await lstat(parent);
      if (!info.isDirectory() || info.isSymbolicLink() || (await realpath(parent)) !== parent)
        throw new Error("Native configuration parent changed.");
    }
    // Repeat the descriptor-bound snapshot after directory creation and before opening for write.
    if ((await readNativeFile(snapshot.target)).revision !== snapshot.revision)
      throw new Error("Native configuration changed. Reload before saving.");
    const absolute = path.join(snapshot.target.root, snapshot.target.relative);
    const handle = await open(
      absolute,
      constants.O_RDWR |
        constants.O_NOFOLLOW |
        constants.O_NONBLOCK |
        (snapshot.exists ? 0 : constants.O_CREAT | constants.O_EXCL),
      0o600,
    );
    try {
      const opened = await handle.stat();
      const named = await lstat(absolute);
      if (
        !opened.isFile() ||
        (!snapshot.exists && opened.size !== 0) ||
        opened.nlink !== 1 ||
        opened.size > nativeFileByteLimit ||
        named.isSymbolicLink() ||
        opened.dev !== named.dev ||
        opened.ino !== named.ino ||
        (opened.mode & 0o222) === 0 ||
        (await realpath(absolute)) !== absolute
      )
        throw new Error("Native configuration is read-only or its identity changed.");
      const before = Buffer.alloc(opened.size + 1);
      const read = await handle.read(before, 0, before.length, 0);
      if (snapshot.exists && revision(before.subarray(0, read.bytesRead)) !== snapshot.revision)
        throw new Error("Native configuration changed. Reload before saving.");
      // The checked reader revalidates the complete directory chain too.
      if (snapshot.exists && (await readNativeFile(snapshot.target)).revision !== snapshot.revision)
        throw new Error("Native configuration changed. Reload before saving.");
      await assertOrigin();
      if (snapshot.exists && (await readNativeFile(snapshot.target)).revision !== snapshot.revision)
        throw new Error("Native configuration changed. Reload before saving.");
      const finalNamed = await lstat(absolute);
      const finalOpened = await handle.stat();
      if (
        finalNamed.isSymbolicLink() ||
        finalNamed.dev !== opened.dev ||
        finalNamed.ino !== opened.ino ||
        finalOpened.nlink !== 1 ||
        finalOpened.size !== opened.size ||
        finalOpened.mtimeMs !== opened.mtimeMs ||
        finalOpened.ctimeMs !== opened.ctimeMs ||
        (await realpath(absolute)) !== absolute
      )
        throw new Error("Native configuration changed before write.");
      await assertOrigin();
      await handle.writeFile(bytes);
      await handle.truncate(bytes.length);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const saved = await readNativeFile(snapshot.target);
    if (saved.revision !== revision(bytes))
      throw new Error("Native configuration differs after write. Inspect before retrying.");
    return saved;
  } finally {
    for (const release of releases.reverse()) release();
  }
}
