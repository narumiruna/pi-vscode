import { createHash } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess } from "./boundedProcess";

export interface GitIdentity {
  readonly root: string;
  readonly gitDir: string;
  readonly commonDir: string;
}
export interface GitRevision {
  readonly head: string | null;
  readonly index: string;
}
export interface GitSnapshotFile {
  readonly path: string;
  readonly oldPath: string;
  readonly status: string;
  readonly before?: string;
  readonly after?: string;
  readonly skipped?: string;
}
export type GitReviewScope =
  | { readonly kind: "staged" }
  | { readonly kind: "unstaged" }
  | { readonly kind: "workingTree" }
  | {
      readonly kind: "branch";
      readonly baseRef: string;
      readonly baseOid?: string;
      readonly mergeBase?: string;
      readonly headOid?: string;
    };
export interface GitReviewSnapshot {
  readonly repository: GitIdentity;
  readonly revision: GitRevision;
  readonly scope: GitReviewScope;
  readonly files: readonly GitSnapshotFile[];
  readonly diff: string;
  readonly capturedAt: number;
  readonly identity: string;
}
export type StagedSnapshot = GitReviewSnapshot;
export interface GitReviewBase {
  readonly ref: string;
  readonly oid: string;
  readonly label: string;
}
export const maxGitReviewFiles = 100;
export const maxGitReviewFileBytes = 100_000;
export const maxGitReviewBlobBytes = 400_000;
export const maxGitReviewDiffBytes = 200_000;
export const gitReviewTimeoutMs = 45_000;
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const validGitOid = (value: string): boolean => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
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

export function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LITERAL_PATHSPECS: "1",
    LC_ALL: "C",
  };
}

export async function git(
  cwd: string,
  args: readonly string[],
  signal?: AbortSignal,
  maxBytes = 2 * 1024 * 1024,
): Promise<Buffer> {
  const overrides: string[] = [];
  if (args[0] === "diff" && !args.includes("--cached")) {
    const keys = gitText(await git(cwd, ["config", "--null", "--name-only", "--list"], signal, 128_000)).split("\0");
    for (const key of new Set(
      keys.filter((key) => /^filter\.[^\r\n\0]+\.(?:clean|smudge|process|required)$/.test(key)),
    )) {
      overrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    }
  }
  const result = await runBoundedProcess(
    "git",
    [
      "--no-pager",
      "--no-optional-locks",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      ...overrides,
      ...args,
    ],
    {
      cwd,
      signal,
      maxBytes,
      timeoutMs: 15_000,
      env: gitEnvironment(),
    },
  );
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error(
      `Git ${args[0]} failed (${result.status}, exit ${result.exitCode}). ${result.stderr.toString("utf8").slice(0, 500)}`,
    );
  }
  return result.stdout;
}
export function gitText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Git records contain unsupported non-UTF-8 names.");
  }
}
const line = (bytes: Buffer): string => gitText(bytes).replace(/\r?\n$/, "");
export async function gitIdentity(cwd: string, signal?: AbortSignal): Promise<GitIdentity> {
  const root = await realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"], signal)));
  const gitDir = await realpath(line(await git(root, ["rev-parse", "--absolute-git-dir"], signal)));
  const commonDir = await realpath(
    path.resolve(root, line(await git(root, ["rev-parse", "--git-common-dir"], signal))),
  );
  return { root, gitDir, commonDir };
}
export async function gitRevision(root: string, signal?: AbortSignal): Promise<GitRevision> {
  let head: string | null;
  try {
    head = line(await git(root, ["rev-parse", "--verify", "HEAD"], signal));
  } catch (error) {
    // Unborn is valid only when the symbolic branch has no ref; other failures propagate.
    const ref = line(await git(root, ["symbolic-ref", "HEAD"], signal));
    if (
      !ref.startsWith("refs/heads/") ||
      (await git(root, ["for-each-ref", "--format=%(objectname)", ref], signal)).length
    )
      throw error;
    head = null;
  }
  if (head !== null && !validGitOid(head)) throw new Error("Invalid Git HEAD.");
  return { head, index: digest(await git(root, ["ls-files", "--stage", "-z"], signal)) };
}
export async function assertStagedCurrent(snapshot: StagedSnapshot, signal?: AbortSignal): Promise<void> {
  const identity = await gitIdentity(snapshot.repository.root, signal);
  const revision = await gitRevision(identity.root, signal);
  if (
    JSON.stringify(identity) !== JSON.stringify(snapshot.repository) ||
    JSON.stringify(revision) !== JSON.stringify(snapshot.revision)
  ) {
    throw new Error("Staged review is stale: repository, HEAD, or index changed. Run Review Staged Changes again.");
  }
}
export function decodeText(bytes: Buffer): string | undefined {
  try {
    return bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return undefined;
  }
}

export async function captureStaged(cwd: string, signal?: AbortSignal): Promise<StagedSnapshot> {
  const deadline = AbortSignal.timeout(gitReviewTimeoutMs);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const repository = await gitIdentity(cwd, signal);
  const revision = await gitRevision(repository.root, signal);
  const raw = await git(
    repository.root,
    ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--find-renames", "--"],
    signal,
  );
  const records = gitText(raw).split("\0");
  const files: GitSnapshotFile[] = [];
  let remaining = maxGitReviewBlobBytes;
  for (let index = 0; index < records.length - 1; ) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(records[index++]!);
    if (!match) throw new Error("Unsupported staged index record (including unresolved conflicts).");
    const [, beforeMode, afterMode, beforeOid, afterOid, status] = match as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    if (!["A", "D", "M", "R", "C", "T"].includes(status)) throw new Error("Unresolved or unsupported staged change.");
    const oldPath = records[index++]!;
    const filePath = status === "R" || status === "C" ? records[index++]! : oldPath;
    if (filePath === undefined) throw new Error("Incomplete Git path record.");
    let skipped: string | undefined;
    if (!safeRelativePath(oldPath) || !safeRelativePath(filePath)) skipped = "Unsupported or unsafe path";
    else if (![beforeMode, afterMode].every((mode) => ["000000", "100644", "100755"].includes(mode)))
      skipped = "Symlink, submodule, or unsupported file mode";
    else if (files.length >= maxGitReviewFiles) skipped = "File-count limit";
    const texts: Array<string | undefined> = [];
    let fileBytes = 0;
    if (!skipped) {
      for (const oid of [beforeOid, afterOid]) {
        if (/^0+$/.test(oid)) {
          texts.push(undefined);
          continue;
        }
        if (!validGitOid(oid)) throw new Error("Invalid Git object identity.");
        const size = Number(line(await git(repository.root, ["cat-file", "-s", oid], signal)));
        if (!Number.isSafeInteger(size) || size < 0 || size > Math.min(maxGitReviewFileBytes, remaining - fileBytes)) {
          skipped = "Oversized file or context limit";
          break;
        }
        const bytes = await git(repository.root, ["cat-file", "blob", oid], signal, maxGitReviewFileBytes + 1);
        const text = decodeText(bytes);
        if (text === undefined) {
          skipped = "Binary or non-UTF-8 file";
          break;
        }
        fileBytes += bytes.length;
        texts.push(text);
      }
    }
    if (!skipped) remaining -= fileBytes;
    files.push({ path: filePath, oldPath, status, ...(skipped ? { skipped } : { before: texts[0], after: texts[1] }) });
  }
  // Generate diffs only for bounded reviewed paths. Blob snapshots remain the navigation authority.
  const reviewed = files.filter((file) => !file.skipped);
  let diff = "";
  if (reviewed.length) {
    try {
      diff = (
        await git(
          repository.root,
          [
            "diff",
            "--cached",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--find-renames",
            "--",
            ...new Set(reviewed.flatMap((file) => [file.oldPath, file.path])),
          ],
          signal,
          maxGitReviewDiffBytes,
        )
      ).toString("utf8");
    } catch (error) {
      if (signal.aborted) throw error;
      // Complete before/after content is present even when the textual diff itself exceeds its bound.
      diff = "Diff omitted: output limit or Git diff error. Compare the supplied immutable before/after blobs instead.";
    }
  }
  const core = { repository, revision, scope: { kind: "staged" } as const, files, diff, capturedAt: Date.now() };
  const snapshot: StagedSnapshot = { ...core, identity: digest(JSON.stringify(core)) };
  await assertStagedCurrent(snapshot, signal);
  return snapshot;
}

export async function listGitReviewBases(cwd: string, signal?: AbortSignal): Promise<GitReviewBase[]> {
  const repository = await gitIdentity(cwd, signal);
  const fields = gitText(
    await git(
      repository.root,
      ["for-each-ref", "--format=%(refname)%00%(objectname)%00", "refs/heads", "refs/remotes"],
      signal,
      512_000,
    ),
  ).split("\0");
  const values: GitReviewBase[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const ref = fields[index]?.trim();
    const oid = fields[index + 1]?.trim();
    if (!ref || !oid || !validGitOid(oid) || ref.endsWith("/HEAD")) continue;
    values.push({ ref, oid, label: ref.replace(/^refs\/(?:heads|remotes)\//, "") });
    if (values.length >= 200) break;
  }
  return values.sort((left, right) => left.label.localeCompare(right.label));
}

export async function captureGitReview(
  cwd: string,
  requested: GitReviewScope,
  signal?: AbortSignal,
  validate = true,
): Promise<GitReviewSnapshot> {
  if (requested.kind === "staged") return captureStaged(cwd, signal);
  const deadline = AbortSignal.timeout(gitReviewTimeoutMs);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const repository = await gitIdentity(cwd, signal);
  const revision = await gitRevision(repository.root, signal);
  let scope: GitReviewScope = requested;
  let before = new Map<string, TreeEntry>();
  let names: string[] = [];
  let diffArgs: string[] = [];
  if (requested.kind === "unstaged") {
    before = await indexTree(repository.root, signal);
    names = await changedWorktreeNames(repository.root, [], signal);
    diffArgs = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", "--"];
  } else if (requested.kind === "workingTree") {
    await indexTree(repository.root, signal); // Reject unresolved conflicts instead of reviewing ambiguous worktree text.
    before = revision.head ? await commitTree(repository.root, revision.head, signal) : new Map();
    names = revision.head ? await changedWorktreeNames(repository.root, [revision.head], signal) : [...before.keys()];
    diffArgs = revision.head
      ? ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", revision.head, "--"]
      : [];
  } else {
    if (!revision.head) throw new Error("Branch review requires an existing HEAD commit.");
    const bases = await listGitReviewBases(repository.root, signal);
    const selected = bases.find(
      (base) => base.ref === requested.baseRef && (!requested.baseOid || base.oid === requested.baseOid),
    );
    if (!selected) throw new Error("The selected branch base is unavailable or changed.");
    const mergeBase = line(await git(repository.root, ["merge-base", selected.oid, revision.head], signal));
    if (!validGitOid(mergeBase)) throw new Error("Git returned an invalid merge base.");
    before = await commitTree(repository.root, mergeBase, signal);
    const afterTree = await commitTree(repository.root, revision.head, signal);
    names = [...new Set([...before.keys(), ...afterTree.keys()])].filter(
      (name) =>
        before.get(name)?.oid !== afterTree.get(name)?.oid || before.get(name)?.mode !== afterTree.get(name)?.mode,
    );
    scope = { kind: "branch", baseRef: selected.ref, baseOid: selected.oid, mergeBase, headOid: revision.head };
    const snapshot = await captureNamedFiles(
      repository,
      revision,
      scope,
      names,
      before,
      (name) => readTreeText(repository.root, afterTree.get(name), signal),
      ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "--no-renames", mergeBase, revision.head, "--"],
      signal,
    );
    if (validate) await assertGitReviewCurrent(snapshot, signal);
    return snapshot;
  }
  const untracked = gitText(await git(repository.root, ["ls-files", "--others", "--exclude-standard", "-z"], signal))
    .split("\0")
    .filter(Boolean);
  names = [...new Set([...names, ...untracked])].sort();
  if (!revision.head && requested.kind === "workingTree")
    names = [...new Set([...names, ...(await trackedNames(repository.root, signal)), ...untracked])].sort();
  const snapshot = await captureNamedFiles(
    repository,
    revision,
    scope,
    names,
    before,
    (name) => readWorktreeText(repository.root, name),
    diffArgs,
    signal,
  );
  if (validate) await assertGitReviewCurrent(snapshot, signal);
  return snapshot;
}

export async function assertGitReviewCurrent(snapshot: GitReviewSnapshot, signal?: AbortSignal): Promise<void> {
  if (snapshot.scope.kind === "staged") return assertStagedCurrent(snapshot, signal);
  const refreshed = await captureGitReview(snapshot.repository.root, snapshot.scope, signal, false);
  if (refreshed.identity !== snapshot.identity)
    throw new Error(
      `${scopeLabel(snapshot.scope)} review is stale: Git state or retained files changed. Capture a fresh review.`,
    );
}

export function scopeLabel(scope: GitReviewScope): string {
  return { staged: "Staged", unstaged: "Unstaged", workingTree: "Working tree", branch: "Branch" }[scope.kind];
}

interface TreeEntry {
  readonly mode: string;
  readonly oid: string;
}

async function captureNamedFiles(
  repository: GitIdentity,
  revision: GitRevision,
  scope: GitReviewScope,
  names: readonly string[],
  beforeTree: ReadonlyMap<string, TreeEntry>,
  afterText: (name: string) => Promise<string | undefined>,
  diffArgs: readonly string[],
  signal?: AbortSignal,
): Promise<GitReviewSnapshot> {
  const files: GitSnapshotFile[] = [];
  let remaining = maxGitReviewBlobBytes;
  for (const name of names) {
    let skipped: string | undefined;
    let before: string | undefined;
    let after: string | undefined;
    try {
      if (!safeRelativePath(name)) throw new Error("Unsupported or unsafe path");
      if (files.length >= maxGitReviewFiles) throw new Error("File-count limit");
      const entry = beforeTree.get(name);
      if (entry && !["100644", "100755"].includes(entry.mode))
        throw new Error("Symlink, submodule, or unsupported file mode");
      before = await readTreeText(repository.root, entry, signal);
      after = await afterText(name);
      if (before === after) throw new Error("Non-content or vanished change; inspect Source Control");
      const bytes = Buffer.byteLength(before ?? "") + Buffer.byteLength(after ?? "");
      if (
        Buffer.byteLength(before ?? "") > maxGitReviewFileBytes ||
        Buffer.byteLength(after ?? "") > maxGitReviewFileBytes ||
        bytes > remaining
      )
        throw new Error("Oversized file or context limit");
      remaining -= bytes;
    } catch (error) {
      if (signal?.aborted) throw error;
      skipped = error instanceof Error ? error.message : "Unavailable";
    }
    files.push({
      path: name,
      oldPath: name,
      status: before === undefined ? "A" : after === undefined ? "D" : "M",
      ...(skipped ? { skipped } : { before, after }),
    });
  }
  let diff = "";
  if (diffArgs.length && files.some((file) => !file.skipped)) {
    try {
      diff = gitText(
        await git(
          repository.root,
          [...diffArgs, ...files.filter((file) => !file.skipped).map((file) => file.path)],
          signal,
          maxGitReviewDiffBytes,
        ),
      );
    } catch (error) {
      if (signal?.aborted) throw error;
      diff = "Diff omitted: output limit or Git diff error. Compare the supplied immutable before/after blobs instead.";
    }
  }
  const core = { repository, revision, scope, files, diff, capturedAt: Date.now() };
  // capturedAt is presentation metadata and must not make a stable snapshot identity change.
  const identity = digest(
    JSON.stringify({
      repository,
      revision: scope.kind === "branch" ? { head: revision.head } : revision,
      scope,
      names,
      files,
      diff,
    }),
  );
  return { ...core, identity };
}

async function changedWorktreeNames(root: string, prefix: readonly string[], signal?: AbortSignal): Promise<string[]> {
  return gitText(
    await git(
      root,
      ["diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", ...prefix, "--"],
      signal,
    ),
  )
    .split("\0")
    .filter(Boolean);
}

async function trackedNames(root: string, signal?: AbortSignal): Promise<string[]> {
  return gitText(await git(root, ["ls-files", "-z"], signal))
    .split("\0")
    .filter(Boolean);
}

async function indexTree(root: string, signal?: AbortSignal): Promise<Map<string, TreeEntry>> {
  const result = new Map<string, TreeEntry>();
  for (const record of gitText(await git(root, ["ls-files", "--stage", "-z"], signal))
    .split("\0")
    .filter(Boolean)) {
    const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0") throw new Error("Unresolved or invalid index entry.");
    result.set(match[4]!, { mode: match[1]!, oid: match[2]! });
  }
  return result;
}

async function commitTree(root: string, commit: string, signal?: AbortSignal): Promise<Map<string, TreeEntry>> {
  if (!validGitOid(commit)) throw new Error("Invalid Git commit identity.");
  const result = new Map<string, TreeEntry>();
  for (const record of gitText(await git(root, ["ls-tree", "-r", "-z", commit], signal))
    .split("\0")
    .filter(Boolean)) {
    const match = /^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Invalid Git tree entry.");
    result.set(match[3]!, { mode: match[1]!, oid: match[2]! });
  }
  return result;
}

async function readTreeText(
  root: string,
  entry: TreeEntry | undefined,
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!entry) return undefined;
  if (!["100644", "100755"].includes(entry.mode)) throw new Error("Symlink, submodule, or unsupported file mode");
  if (!validGitOid(entry.oid)) throw new Error("Invalid Git blob identity.");
  const size = Number(line(await git(root, ["cat-file", "-s", entry.oid], signal)));
  if (!Number.isSafeInteger(size) || size < 0 || size > maxGitReviewFileBytes)
    throw new Error("Oversized file or context limit");
  const text = decodeText(await git(root, ["cat-file", "blob", entry.oid], signal, maxGitReviewFileBytes + 1));
  if (text === undefined) throw new Error("Binary or non-UTF-8 file");
  return text;
}

async function readWorktreeText(root: string, relative: string): Promise<string | undefined> {
  if (!safeRelativePath(relative)) throw new Error("Unsupported or unsafe path");
  if ((await realpath(root)) !== root) throw new Error("Repository root changed.");
  const parents: { path: string; stat: BigIntStats }[] = [];
  let parent = root;
  for (const part of ["", ...relative.split("/").slice(0, -1)]) {
    parent = path.join(parent, part);
    try {
      const info = await lstat(parent, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Unsupported worktree parent");
      parents.push({ path: parent, stat: info });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const absolute = path.join(root, relative);
  const checkedName = async () => {
    if ((await realpath(absolute)) !== absolute) throw new Error("Worktree file escaped its canonical path");
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
        throw new Error("Worktree parent changed during capture");
    }
    return lstat(absolute);
  };
  let handle: FileHandle | undefined;
  try {
    const namedBefore = await lstat(absolute);
    if (
      namedBefore.isSymbolicLink() ||
      !namedBefore.isFile() ||
      namedBefore.nlink !== 1 ||
      namedBefore.size > maxGitReviewFileBytes
    )
      throw new Error("Oversized or unsupported worktree file");
    handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > maxGitReviewFileBytes)
      throw new Error("Oversized or unsupported opened worktree file");
    const namedOpened = await checkedName();
    if (
      opened.dev !== namedBefore.dev ||
      opened.ino !== namedBefore.ino ||
      namedOpened.isSymbolicLink() ||
      namedOpened.dev !== opened.dev ||
      namedOpened.ino !== opened.ino ||
      namedOpened.nlink !== 1
    )
      throw new Error("Worktree file identity changed during capture");
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
      throw new Error("Worktree file changed during capture");
    const text = decodeText(bytes.subarray(0, bytesRead));
    if (text === undefined) throw new Error("Binary or non-UTF-8 file");
    return text;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  } finally {
    await handle?.close();
  }
}
