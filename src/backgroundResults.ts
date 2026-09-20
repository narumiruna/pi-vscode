import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import {
  decodeText,
  digest,
  type GitIdentity,
  git,
  gitIdentity,
  gitRevision,
  gitText,
  safeRelativePath,
  validGitOid,
} from "./gitSnapshots";

export interface TaskOrigin {
  readonly repository: GitIdentity;
  readonly baseCommit: string;
}
export interface ResultFile {
  readonly path: string;
  readonly before?: string;
  readonly after?: string;
  readonly skipped?: string;
}
export interface BackgroundResult {
  readonly source: GitIdentity;
  readonly origin: TaskOrigin;
  readonly files: readonly ResultFile[];
  readonly identity: string;
  readonly capturedAt: number;
}
export interface ImportReport {
  readonly applied: string[];
  readonly skipped: string[];
  readonly failed: string[];
}
export function validTaskOrigin(value: unknown): value is TaskOrigin {
  if (!value || typeof value !== "object") return false;
  const item = value as TaskOrigin;
  return (
    typeof item.baseCommit === "string" &&
    validGitOid(item.baseCommit) &&
    !!item.repository &&
    [item.repository.root, item.repository.gitDir, item.repository.commonDir].every(
      (v) => typeof v === "string" && path.isAbsolute(v) && !v.includes("\0"),
    )
  );
}
export async function assertSafeFile(root: string, relative: string): Promise<string> {
  if (!safeRelativePath(relative)) throw new Error("Unsafe relative file path.");
  if ((await realpath(root)) !== root) throw new Error("Worktree root is no longer canonical.");
  let current = root;
  for (const [index, part] of relative.split("/").entries()) {
    current = path.join(current, part);
    try {
      const stat = await lstat(current);
      if (stat.isSymbolicLink() || (index < relative.split("/").length - 1 ? !stat.isDirectory() : !stat.isFile()))
        throw new Error("Symlink or unsupported file type.");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return current;
}
export async function readRegularText(root: string, relative: string, maxBytes = 100_000): Promise<string | undefined> {
  const file = await assertSafeFile(root, relative);
  try {
    const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) throw new Error("Oversized or unsupported file.");
      const bytes = Buffer.alloc(maxBytes + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      const after = await handle.stat();
      const named = await lstat(file);
      if (
        bytesRead !== stat.size ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs ||
        named.dev !== stat.dev ||
        named.ino !== stat.ino ||
        named.isSymbolicLink()
      )
        throw new Error("File changed during snapshot capture.");
      const text = decodeText(bytes.subarray(0, bytesRead));
      if (text === undefined) throw new Error("Binary or non-UTF-8 file.");
      return text;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function captureBackgroundResult(
  sourceRoot: string,
  origin: TaskOrigin,
  signal?: AbortSignal,
): Promise<BackgroundResult> {
  const deadline = AbortSignal.timeout(45_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  if (!validTaskOrigin(origin))
    throw new Error("Verified task origin/base metadata is unavailable. Open Source Control instead.");
  const source = await gitIdentity(sourceRoot, signal);
  if (source.commonDir !== origin.repository.commonDir || source.root === origin.repository.root)
    throw new Error("This task is not an isolated worktree of the recorded repository.");
  const revision = await gitRevision(source.root, signal);
  const tree = gitText(await git(source.root, ["ls-tree", "-r", "-z", origin.baseCommit], signal)).split("\0");
  const base = new Map<string, { mode: string; oid: string }>();
  for (const record of tree.filter(Boolean)) {
    const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Invalid base tree.");
    base.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  const changed = gitText(
    await git(
      source.root,
      ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", origin.baseCommit, "--"],
      signal,
    ),
  ).split("\0");
  const untracked = gitText(await git(source.root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)).split(
    "\0",
  );
  // Git's index is authoritative when the filesystem cannot represent executable bits.
  const trustFileMode =
    process.platform !== "win32" &&
    (await git(source.root, ["config", "--type=bool", "--default=true", "--get", "core.filemode"], signal))
      .toString()
      .trim() === "true";
  const indexModes = new Map<string, string>();
  if (!trustFileMode) {
    for (const record of gitText(await git(source.root, ["ls-files", "--stage", "-z"], signal))
      .split("\0")
      .filter(Boolean)) {
      const match = /^(\d+) [a-f0-9]+ ([0-3])\t([\s\S]+)$/.exec(record);
      if (!match) throw new Error("Invalid task index record.");
      indexModes.set(match[3]!, match[2] === "0" ? match[1]! : "unmerged");
    }
  }
  const files: ResultFile[] = [];
  let bytes = 0;
  for (const name of [...new Set([...changed, ...untracked].filter(Boolean))].sort()) {
    try {
      if (files.length >= 100) throw new Error("File-count limit.");
      const entry = base.get(name);
      if (entry && !["100644", "100755"].includes(entry.mode))
        throw new Error("Unsupported base mode (symlink/submodule).");
      let before: string | undefined;
      if (entry) {
        const size = Number((await git(source.root, ["cat-file", "-s", entry.oid], signal)).toString());
        if (!Number.isSafeInteger(size) || size > 100_000) throw new Error("Oversized base blob.");
        before = decodeText(await git(source.root, ["cat-file", "blob", entry.oid], signal, 100_001));
        if (before === undefined) throw new Error("Binary base blob.");
      }
      const after = await readRegularText(source.root, name);
      if (after !== undefined) {
        const mode = trustFileMode
          ? ((await lstat(await assertSafeFile(source.root, name))).mode & 0o111) !== 0
            ? "100755"
            : "100644"
          : (indexModes.get(name) ?? "100644");
        if (mode !== (entry?.mode ?? "100644"))
          throw new Error("Executable-bit changes/additions or unsupported index modes require Source Control.");
      }
      if (before !== after) {
        const candidateBytes = Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
        if (bytes + candidateBytes > 400_000) throw new Error("Total snapshot limit.");
        files.push({ path: name, before, after });
        bytes += candidateBytes;
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      files.push({ path: name, skipped: error instanceof Error ? error.message : "Unavailable" });
    }
  }
  if (JSON.stringify(await gitRevision(source.root, signal)) !== JSON.stringify(revision))
    throw new Error("Task Git state changed during capture.");
  // Detect writes occurring during collection, not only index changes.
  for (const file of files.filter((file) => !file.skipped))
    if ((await readRegularText(source.root, file.path)) !== file.after)
      throw new Error("Task files changed during capture.");
  return { source, origin, files, identity: digest(JSON.stringify({ revision, files })), capturedAt: Date.now() };
}

/** All destinations are preflighted before any write. Partial I/O failures remain recoverable at source. */
export async function importBackgroundResult(
  snapshot: BackgroundResult,
  selected: readonly string[],
  options: {
    assertInactive: () => void;
    isDirty: (absolutePath: string) => boolean;
    beforeWrite?: (file: string) => Promise<void>;
  },
): Promise<ImportReport> {
  options.assertInactive();
  if (
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((name) => !snapshot.files.some((file) => !file.skipped && file.path === name))
  )
    throw new Error("Invalid selected result files.");
  const current = await captureBackgroundResult(snapshot.source.root, snapshot.origin);
  if (current.identity !== snapshot.identity) throw new Error("Task results are stale; review again.");
  const target = await gitIdentity(snapshot.origin.repository.root);
  if (JSON.stringify(target) !== JSON.stringify(snapshot.origin.repository))
    throw new Error("Target repository identity changed.");
  const files = snapshot.files.filter((file) => selected.includes(file.path));
  const validate = async (file: ResultFile) => {
    options.assertInactive();
    const absolute = await assertSafeFile(target.root, file.path);
    if (options.isDirty(absolute)) throw new Error(`Dirty editor buffer: ${file.path}`);
    const text = await readRegularText(target.root, file.path);
    if (text !== file.before && text !== file.after) throw new Error(`Target overlap/stale base: ${file.path}`);
    return text;
  };
  for (const file of files) await validate(file);
  const report: ImportReport = { applied: [], skipped: [], failed: [] };
  for (const file of files) {
    try {
      await options.beforeWrite?.(file.path);
      if ((await validate(file)) === file.after) {
        report.skipped.push(file.path);
        continue;
      }
      if ((await readRegularText(snapshot.source.root, file.path)) !== file.after)
        throw new Error("Source changed after Preview.");
      const absolute = await assertSafeFile(target.root, file.path);
      if (file.after === undefined) await unlink(absolute);
      else {
        await mkdir(path.dirname(absolute), { recursive: true });
        await validate(file);
        const handle = await open(
          absolute,
          constants.O_RDWR |
            constants.O_NOFOLLOW |
            (file.before === undefined ? constants.O_CREAT | constants.O_EXCL : 0),
          0o644,
        );
        try {
          await assertSafeFile(target.root, file.path);
          const opened = await handle.stat();
          const named = await lstat(absolute);
          if (opened.ino !== named.ino || opened.dev !== named.dev || opened.nlink !== 1 || options.isDirty(absolute))
            throw new Error("Destination identity changed while opening.");
          if (file.before !== undefined) {
            const original = Buffer.alloc(Buffer.byteLength(file.before) + 1);
            const { bytesRead } = await handle.read(original, 0, original.length, 0);
            if (original.subarray(0, bytesRead).toString("utf8") !== file.before)
              throw new Error("Destination changed before writing.");
          }
          await handle.writeFile(file.after, "utf8");
          await handle.truncate(Buffer.byteLength(file.after));
        } finally {
          await handle.close();
        }
      }
      report.applied.push(file.path);
    } catch (error) {
      report.failed.push(`${file.path}: ${error instanceof Error ? error.message : "I/O failure"}`);
      // No automatic retry or rollback of partially applied files.
      report.skipped.push(...files.slice(files.indexOf(file) + 1).map((item) => item.path));
      break;
    }
  }
  return report;
}
