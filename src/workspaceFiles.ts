import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export function safeRelativePath(value: string): boolean {
  return (
    !!value &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !path.posix.isAbsolute(value) &&
    !/^[a-z]:/i.test(value) &&
    value
      .split("/")
      .every(
        (part) =>
          part !== ".." &&
          part !== "." &&
          part !== "" &&
          part.toLowerCase() !== ".git" &&
          !/[. ]$/.test(part) &&
          !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
  );
}

/** Bounded, descriptor-bound capture; no bytes escape failed containment/identity checks. */
export async function readWorkspaceFile(root: string, relative: string, maxBytes: number): Promise<Buffer | undefined> {
  if (!safeRelativePath(relative)) throw new Error("Unsupported or unsafe path");
  if ((await realpath(root)) !== root) throw new Error("Workspace root changed.");
  const parents: { path: string; stat: BigIntStats }[] = [];
  let parent = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    parent = path.join(parent, part);
    try {
      const info = await lstat(parent, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsupported workspace parent");
      parents.push({ path: parent, stat: info });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const absolute = path.join(root, relative);
  const checkedName = async () => {
    if ((await realpath(absolute)) !== absolute) throw new Error("Workspace file escaped its canonical path");
    // O_NOFOLLOW protects only the leaf. Bind the name to the captured directory
    // chain as well; change times detect a renamed parent restored before this check.
    for (const parent of parents) {
      const current = await lstat(parent.path, { bigint: true });
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== parent.stat.dev ||
        current.ino !== parent.stat.ino ||
        current.ctimeNs !== parent.stat.ctimeNs ||
        current.mtimeNs !== parent.stat.mtimeNs
      )
        throw new Error("Workspace parent changed during capture");
    }
    return lstat(absolute);
  };
  let handle: FileHandle | undefined;
  try {
    const namedBefore = await lstat(absolute);
    if (namedBefore.isSymbolicLink() || !namedBefore.isFile() || namedBefore.nlink !== 1 || namedBefore.size > maxBytes)
      throw new Error("Oversized or unsupported workspace file");
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxBytes)
      throw new Error("Oversized or unsupported opened workspace file");
    const namedOpened = await checkedName();
    if (
      opened.dev !== namedBefore.dev ||
      opened.ino !== namedBefore.ino ||
      namedOpened.isSymbolicLink() ||
      namedOpened.dev !== opened.dev ||
      namedOpened.ino !== opened.ino ||
      namedOpened.nlink !== 1
    )
      throw new Error("Workspace file identity changed during capture");
    const bytes = Buffer.alloc(opened.size + 1);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const after = await handle.stat();
    const namedAfter = await checkedName();
    if (
      namedAfter.isSymbolicLink() ||
      namedAfter.nlink !== 1 ||
      after.nlink !== 1 ||
      namedAfter.dev !== opened.dev ||
      namedAfter.ino !== opened.ino ||
      bytesRead !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs ||
      after.ctimeMs !== opened.ctimeMs
    )
      throw new Error("Workspace file changed during capture");
    return bytes.subarray(0, bytesRead);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
