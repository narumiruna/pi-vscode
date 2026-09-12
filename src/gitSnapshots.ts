import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess } from "./boundedProcess";

export interface GitIdentity { readonly root: string; readonly gitDir: string; readonly commonDir: string }
export interface GitRevision { readonly head: string | null; readonly index: string }
export interface GitSnapshotFile {
  readonly path: string; readonly oldPath: string; readonly status: string;
  readonly before?: string; readonly after?: string; readonly skipped?: string;
}
export interface StagedSnapshot {
  readonly repository: GitIdentity; readonly revision: GitRevision;
  readonly files: readonly GitSnapshotFile[]; readonly diff: string; readonly capturedAt: number;
}
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const validGitOid = (value: string): boolean => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);
export function safeRelativePath(value: string): boolean {
  return !!value && !value.includes("\0") && !value.includes("\\") && !value.includes(":") && !path.posix.isAbsolute(value)
    && !/^[a-z]:/i.test(value) && value.split("/").every(part => part !== ".." && part !== "." && part !== "" && part.toLowerCase() !== ".git" && !/[. ]$/.test(part) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part));
}

export function gitEnvironment(): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_"))),
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_LITERAL_PATHSPECS: "1", LC_ALL: "C" };
}

export async function git(cwd: string, args: readonly string[], signal?: AbortSignal, maxBytes = 2 * 1024 * 1024): Promise<Buffer> {
  const overrides: string[] = [];
  if (args[0] === "diff" && !args.includes("--cached")) {
    const keys = gitText(await git(cwd, ["config", "--null", "--name-only", "--list"], signal, 128_000)).split("\0");
    for (const key of new Set(keys.filter(key => /^filter\.[^\r\n\0]+\.(?:clean|smudge|process|required)$/.test(key)))) {
      overrides.push("-c", `${key}=${key.endsWith(".required") ? "false" : ""}`);
    }
  }
  const result = await runBoundedProcess("git", ["--no-pager", "--no-optional-locks", "-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...overrides, ...args], {
    cwd, signal, maxBytes, timeoutMs: 15_000,
    env: gitEnvironment(),
  });
  if (result.status !== "exited" || result.exitCode !== 0) {
    throw new Error(`Git ${args[0]} failed (${result.status}, exit ${result.exitCode}). ${result.stderr.toString("utf8").slice(0, 500)}`);
  }
  return result.stdout;
}
export function gitText(bytes: Buffer): string {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new Error("Git records contain unsupported non-UTF-8 names."); }
}
const line = (bytes: Buffer): string => gitText(bytes).replace(/\r?\n$/, "");
export async function gitIdentity(cwd: string, signal?: AbortSignal): Promise<GitIdentity> {
  const root = await realpath(line(await git(cwd, ["rev-parse", "--show-toplevel"], signal)));
  const gitDir = await realpath(line(await git(root, ["rev-parse", "--absolute-git-dir"], signal)));
  const commonDir = await realpath(path.resolve(root, line(await git(root, ["rev-parse", "--git-common-dir"], signal))));
  return { root, gitDir, commonDir };
}
export async function gitRevision(root: string, signal?: AbortSignal): Promise<GitRevision> {
  let head: string | null;
  try { head = line(await git(root, ["rev-parse", "--verify", "HEAD"], signal)); }
  catch (error) {
    // Unborn is valid only when the symbolic branch has no ref; other failures propagate.
    const ref = line(await git(root, ["symbolic-ref", "HEAD"], signal));
    if (!ref.startsWith("refs/heads/") || (await git(root, ["for-each-ref", "--format=%(objectname)", ref], signal)).length) throw error;
    head = null;
  }
  if (head !== null && !validGitOid(head)) throw new Error("Invalid Git HEAD.");
  return { head, index: digest(await git(root, ["ls-files", "--stage", "-z"], signal)) };
}
export async function assertStagedCurrent(snapshot: StagedSnapshot, signal?: AbortSignal): Promise<void> {
  const identity = await gitIdentity(snapshot.repository.root, signal);
  const revision = await gitRevision(identity.root, signal);
  if (JSON.stringify(identity) !== JSON.stringify(snapshot.repository) || JSON.stringify(revision) !== JSON.stringify(snapshot.revision)) {
    throw new Error("Staged review is stale: repository, HEAD, or index changed. Run Review Staged Changes again.");
  }
}
export function decodeText(bytes: Buffer): string | undefined {
  try { return bytes.includes(0) ? undefined : new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return undefined; }
}

export async function captureStaged(cwd: string, signal?: AbortSignal): Promise<StagedSnapshot> {
  const deadline = AbortSignal.timeout(45_000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const repository = await gitIdentity(cwd, signal);
  const revision = await gitRevision(repository.root, signal);
  const raw = await git(repository.root, ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-ext-diff", "--no-textconv", "--find-renames", "--"], signal);
  const records = gitText(raw).split("\0");
  const files: GitSnapshotFile[] = [];
  let remaining = 400_000;
  for (let index = 0; index < records.length - 1;) {
    const match = /^:(\d{6}) (\d{6}) ([a-f0-9]+) ([a-f0-9]+) ([A-Z])\d*$/.exec(records[index++]!);
    if (!match) throw new Error("Unsupported staged index record (including unresolved conflicts).");
    const [, beforeMode, afterMode, beforeOid, afterOid, status] = match as unknown as [string, string, string, string, string, string];
    if (!["A", "D", "M", "R", "C", "T"].includes(status)) throw new Error("Unresolved or unsupported staged change.");
    const oldPath = records[index++]!;
    const filePath = status === "R" || status === "C" ? records[index++]! : oldPath;
    if (filePath === undefined) throw new Error("Incomplete Git path record.");
    let skipped: string | undefined;
    if (!safeRelativePath(oldPath) || !safeRelativePath(filePath)) skipped = "Unsupported or unsafe path";
    else if (![beforeMode, afterMode].every(mode => ["000000", "100644", "100755"].includes(mode))) skipped = "Symlink, submodule, or unsupported file mode";
    else if (files.length >= 100) skipped = "File-count limit";
    const texts: Array<string | undefined> = [];
    if (!skipped) {
      for (const oid of [beforeOid, afterOid]) {
        if (/^0+$/.test(oid)) { texts.push(undefined); continue; }
        if (!validGitOid(oid)) throw new Error("Invalid Git object identity.");
        const size = Number(line(await git(repository.root, ["cat-file", "-s", oid], signal)));
        if (!Number.isSafeInteger(size) || size < 0 || size > Math.min(100_000, remaining)) { skipped = "Oversized file or context limit"; break; }
        const bytes = await git(repository.root, ["cat-file", "blob", oid], signal, 100_001);
        const text = decodeText(bytes);
        if (text === undefined) { skipped = "Binary or non-UTF-8 file"; break; }
        remaining -= bytes.length;
        texts.push(text);
      }
    }
    files.push({ path: filePath, oldPath, status, ...(skipped ? { skipped } : { before: texts[0], after: texts[1] }) });
  }
  // Generate diffs only for bounded reviewed paths. Blob snapshots remain the navigation authority.
  const reviewed = files.filter(file => !file.skipped);
  let diff = "";
  if (reviewed.length) {
    try {
      diff = (await git(repository.root, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--", ...new Set(reviewed.flatMap(file => [file.oldPath, file.path]))], signal, 200_000)).toString("utf8");
    } catch (error) {
      if (signal.aborted) throw error;
      // Complete before/after content is present even when the textual diff itself exceeds its bound.
      diff = "Diff omitted: output limit or Git diff error. Compare the supplied immutable before/after blobs instead.";
    }
  }
  const snapshot = { repository, revision, files, diff, capturedAt: Date.now() };
  await assertStagedCurrent(snapshot, signal);
  return snapshot;
}
