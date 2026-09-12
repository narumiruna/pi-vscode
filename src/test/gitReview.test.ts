import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertStagedCurrent, captureStaged, digest, gitEnvironment, safeRelativePath } from "../gitSnapshots";
import { parseGitReview } from "../gitReview";

async function fixture(run: (root: string, git: (...args: string[]) => Buffer) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "pi-git-review-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: root, env: { ...gitEnvironment(), GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" } });
  try { git("init", "-q"); await run(root, git); } finally { await rm(root, { recursive: true, force: true }); }
}

test("staged snapshots preserve index/worktree and partial staging with unusual names", async () => fixture(async (root, git) => {
  const names = ["space name.ts", "漢字.ts", "tab\tfile", "new\nline"];
  for (const name of names) await writeFile(path.join(root, name), "base\n");
  git("add", "--", ...names); git("commit", "-qm", "base");
  for (const name of names) await writeFile(path.join(root, name), "staged\n");
  git("add", "--", ...names);
  for (const name of names) await writeFile(path.join(root, name), "unstaged\n");
  const beforeIndex = digest(await readFile(path.join(root, ".git/index")));
  const snapshot = await captureStaged(root);
  assert.deepEqual(new Set(snapshot.files.map(file => file.path)), new Set(names));
  assert.ok(snapshot.files.every(file => file.before === "base\n" && file.after === "staged\n"));
  assert.equal(digest(await readFile(path.join(root, ".git/index"))), beforeIndex);
  for (const name of names) assert.equal(await readFile(path.join(root, name), "utf8"), "unstaged\n");
  await assertStagedCurrent(snapshot);
  git("add", "--", names[0]!);
  await assert.rejects(assertStagedCurrent(snapshot), /stale/);
}));

test("unborn and empty staging, additions, deleted sides, rename and unsupported files", async () => fixture(async (root, git) => {
  assert.equal((await captureStaged(root)).files.length, 0);
  await writeFile(path.join(root, "added"), "one\ntwo\n"); git("add", "added");
  const unborn = await captureStaged(root);
  assert.equal(unborn.revision.head, null);
  assert.equal(unborn.files[0]?.before, undefined);
  git("commit", "-qm", "base");
  git("mv", "added", "renamed");
  const renamed = await captureStaged(root);
  assert.equal(renamed.files[0]?.oldPath, "added");
  assert.equal(renamed.files[0]?.path, "renamed");
  git("commit", "-qm", "rename"); git("rm", "renamed");
  await writeFile(path.join(root, "binary"), Buffer.from([0, 1, 2]));
  await writeFile(path.join(root, "huge"), "x".repeat(100_001));
  await symlink("../outside", path.join(root, "link")); git("add", "binary", "huge", "link");
  git("update-index", "--add", "--cacheinfo", `160000,${git("rev-parse", "HEAD").toString().trim()},submodule`);
  const snapshot = await captureStaged(root);
  assert.equal(snapshot.files.filter(file => file.skipped).length, 4);
  const valid = { incomplete: false, findings: [{ path: "renamed", side: "before", startLine: 1, endLine: 2, severity: "warning", message: "Deletion removes required behavior" }] };
  assert.equal(parseGitReview(JSON.stringify(valid), snapshot).incomplete, true);
  for (const patch of [{ path: "../secret" }, { path: "invented" }, { side: "after" }, { startLine: 0 }, { endLine: 3 }, { severity: "critical" }, { message: "x".repeat(2001) }]) {
    assert.throws(() => parseGitReview(JSON.stringify({ ...valid, findings: [{ ...valid.findings[0], ...patch }] }), snapshot));
  }
  for (const value of ["", "{}", '{"findings":[]}', "x".repeat(100001)]) assert.throws(() => parseGitReview(value, snapshot));
}));

test("rejected staged file sides do not consume the retained review budget", async () => fixture(async (root, git) => {
  for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(root, name), "a".repeat(100_000));
  git("add", "a", "b", "c", "d"); git("commit", "-qm", "base");
  await writeFile(path.join(root, "a"), "x".repeat(100_001));
  await writeFile(path.join(root, "b"), Buffer.from([0, 1]));
  await writeFile(path.join(root, "c"), "x".repeat(100_001));
  await writeFile(path.join(root, "d"), "b".repeat(100_000));
  git("add", "a", "b", "c", "d");
  const index = digest(await readFile(path.join(root, ".git/index")));
  const snapshot = await captureStaged(root);
  assert.equal(snapshot.files.filter(file => file.skipped).length, 3);
  assert.equal(snapshot.files.find(file => file.path === "d")?.after, "b".repeat(100_000));
  assert.equal(snapshot.files.reduce((sum, file) => sum + Buffer.byteLength(file.before ?? "") + Buffer.byteLength(file.after ?? ""), 0), 200_000);
  assert.equal(digest(await readFile(path.join(root, ".git/index"))), index);
}));

test("repository identities differ; cancellation and unsafe paths fail closed", async () => {
  await fixture(async root => fixture(async other => {
    assert.notEqual((await captureStaged(root)).repository.gitDir, (await captureStaged(other)).repository.gitDir);
  }));
  const abort = new AbortController(); abort.abort();
  await assert.rejects(captureStaged(process.cwd(), abort.signal), /cancelled/);
  for (const file of ["../x", "/x", "C:/x", "x/../y", "x\\y", ".git/config"]) assert.equal(safeRelativePath(file), false);
  if (process.platform !== "win32") await fixture(async (root, git) => {
    await writeFile(Buffer.concat([Buffer.from(root + "/"), Buffer.from([255])]), "unsupported filename");
    git("add", ".");
    await assert.rejects(captureStaged(root), /non-UTF-8/);
  });
});
