import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { captureBackgroundResult, importBackgroundResult, validTaskOrigin, type TaskOrigin } from "../backgroundResults";
import { gitEnvironment, gitIdentity } from "../gitSnapshots";

async function fixture(run: (root: string, task: string, origin: TaskOrigin, git: (cwd: string, ...args: string[]) => string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-results-"));
  const task = `${root}-task`;
  const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: { ...gitEnvironment(), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } }).trim();
  try {
    git(root, "init", "-q");
    await writeFile(path.join(root, "modified"), "base\n"); await writeFile(path.join(root, "deleted"), "delete\n");
    git(root, "add", "."); git(root, "commit", "-qm", "base");
    const origin = { repository: await gitIdentity(root), baseCommit: git(root, "rev-parse", "HEAD") };
    git(root, "worktree", "add", "--detach", task, origin.baseCommit);
    await run(root, task, origin, git);
  } finally { await rm(task, { recursive: true, force: true }); await rm(root, { recursive: true, force: true }); }
}
const options = { assertInactive: () => {}, isDirty: () => false };
test("observed task commits, untracked additions, deletions and duplicate imports preserve unrelated edits", async () => fixture(async (root, task, origin, git) => {
  await writeFile(path.join(task, "modified"), "task commit\n"); git(task, "add", "modified"); git(task, "commit", "-qm", "task");
  await rm(path.join(task, "deleted")); await writeFile(path.join(task, "untracked"), "added\n");
  await writeFile(path.join(root, "unrelated"), "user work\n");
  const snapshot = await captureBackgroundResult(task, origin);
  const selected = snapshot.files.map(file => file.path);
  assert.deepEqual(new Set(selected), new Set(["modified", "deleted", "untracked"]));
  const report = await importBackgroundResult(snapshot, selected, options);
  assert.equal(report.applied.length, 3); assert.equal(report.failed.length, 0);
  assert.equal(await readFile(path.join(root, "unrelated"), "utf8"), "user work\n");
  assert.equal((await importBackgroundResult(snapshot, selected, options)).skipped.length, 3);
  assert.equal(git(root, "diff", "--cached", "--name-only"), "");
}));

test("stale source/target, dirty buffers, legacy metadata and unsafe selections fail closed", async () => fixture(async (root, task, origin) => {
  assert.equal(validTaskOrigin({}), false);
  await writeFile(path.join(task, "modified"), "result");
  const snapshot = await captureBackgroundResult(task, origin);
  await assert.rejects(importBackgroundResult(snapshot, ["../outside"], options), /Invalid/);
  await assert.rejects(importBackgroundResult(snapshot, ["modified"], { ...options, isDirty: () => true }), /Dirty/);
  await writeFile(path.join(root, "modified"), "user");
  await assert.rejects(importBackgroundResult(snapshot, ["modified"], options), /overlap/);
  await writeFile(path.join(task, "modified"), "new result");
  await assert.rejects(importBackgroundResult(snapshot, ["modified"], options), /stale/);
  await symlink("../outside", path.join(task, "link"));
  assert.match((await captureBackgroundResult(task, origin)).files.find(file => file.path === "link")?.skipped ?? "", /Symlink/);
  if (process.platform !== "win32") {
    await chmod(path.join(task, "modified"), 0o755);
    await writeFile(path.join(task, "executable"), "new executable", { mode: 0o755 });
    const modes = await captureBackgroundResult(task, origin);
    for (const name of ["modified", "executable"]) assert.match(modes.files.find(file => file.path === name)?.skipped ?? "", /Executable-bit/);
  }
}));

test("partial I/O failure reports exact progress and source remains recoverable", async () => fixture(async (root, task, origin) => {
  await writeFile(path.join(task, "a"), "first"); await writeFile(path.join(task, "b"), "second");
  const snapshot = await captureBackgroundResult(task, origin);
  const report = await importBackgroundResult(snapshot, ["a", "b"], { ...options, beforeWrite: async name => { if (name === "b") throw new Error("simulated I/O failure"); } });
  assert.deepEqual(report.applied, ["a"]); assert.match(report.failed[0] ?? "", /b: simulated/);
  assert.equal(await readFile(path.join(task, "b"), "utf8"), "second");
  // Reload recovery needs no stored raw content: recapture the worktree and skip an already-imported result.
  const recovered = await captureBackgroundResult(task, origin);
  assert.deepEqual((await importBackgroundResult(recovered, ["a", "b"], options)).skipped, ["a"]);
}));

test("Git index modes preserve executable content changes when filesystem modes are not authoritative", async () => fixture(async (root, task, origin, git) => {
  await writeFile(path.join(root, "executable"), "base\n");
  git(root, "add", "executable"); git(root, "update-index", "--chmod=+x", "executable"); git(root, "commit", "-qm", "executable base");
  const recorded = { ...origin, baseCommit: git(root, "rev-parse", "HEAD") };
  git(task, "reset", "--hard", recorded.baseCommit);
  git(task, "config", "core.filemode", "false");
  await chmod(path.join(task, "executable"), 0o644);
  await writeFile(path.join(task, "executable"), "changed\n");
  const snapshot = await captureBackgroundResult(task, recorded);
  assert.equal(snapshot.files.find(file => file.path === "executable")?.after, "changed\n");
  assert.deepEqual((await importBackgroundResult(snapshot, ["executable"], options)).applied, ["executable"]);
  git(task, "update-index", "--chmod=-x", "executable");
  assert.match((await captureBackgroundResult(task, recorded)).files.find(file => file.path === "executable")?.skipped ?? "", /Executable-bit/);
  await writeFile(path.join(task, "new-executable"), "new\n");
  git(task, "add", "new-executable"); git(task, "update-index", "--chmod=+x", "new-executable");
  assert.match((await captureBackgroundResult(task, recorded)).files.find(file => file.path === "new-executable")?.skipped ?? "", /Executable-bit/);
}));

test("a skipped oversized candidate does not consume the budget for later fitting files", async () => fixture(async (root, task, origin, git) => {
  for (const [name, size] of [["a", 90_000], ["b", 90_000], ["c", 30_000], ["d", 10]] as const) await writeFile(path.join(root, name), "a".repeat(size));
  git(root, "add", "a", "b", "c", "d"); git(root, "commit", "-qm", "bounded base");
  const recorded = { ...origin, baseCommit: git(root, "rev-parse", "HEAD") };
  git(task, "reset", "--hard", recorded.baseCommit);
  for (const [name, size] of [["a", 90_000], ["b", 90_000], ["c", 30_000], ["d", 10]] as const) await writeFile(path.join(task, name), "b".repeat(size));
  const snapshot = await captureBackgroundResult(task, recorded);
  assert.match(snapshot.files.find(file => file.path === "c")?.skipped ?? "", /Total snapshot limit/);
  assert.equal(snapshot.files.find(file => file.path === "d")?.after, "b".repeat(10));
  assert.equal(snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.before ?? "") + Buffer.byteLength(file.after ?? ""), 0), 360_020);
}));

test("observed Git reads never execute configured filters/fsmonitor or inherited external diff helpers", async () => fixture(async (root, task, origin, git) => {
  const helper = path.join(root, "helper.cjs"), marker = path.join(root, "helper-ran");
  await writeFile(helper, `require('fs').writeFileSync(${JSON.stringify(marker)},'unsafe helper');process.stdout.write('rewritten');`);
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(helper)}`;
  git(root, "config", "filter.fixture.clean", command);
  git(root, "config", "filter.fixture.required", "true");
  git(root, "config", "core.fsmonitor", command);
  await writeFile(path.join(task, ".gitattributes"), "modified filter=fixture\n");
  await writeFile(path.join(task, "modified"), "actual result\n");
  const previous = process.env.GIT_EXTERNAL_DIFF;
  process.env.GIT_EXTERNAL_DIFF = command;
  try {
    const result = await captureBackgroundResult(task, origin);
    assert.equal(result.files.find(file => file.path === "modified")?.after, "actual result\n");
    await assert.rejects(readFile(marker), { code: "ENOENT" });
  } finally { if (previous === undefined) delete process.env.GIT_EXTERNAL_DIFF; else process.env.GIT_EXTERNAL_DIFF = previous; }
}));
