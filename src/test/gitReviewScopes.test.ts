import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseGitReview, reviewContext } from "../gitReview";
import {
  assertGitReviewCurrent,
  captureGitReview,
  digest,
  type GitReviewSnapshot,
  gitEnvironment,
  listGitReviewBases,
} from "../gitSnapshots";

async function fixture(run: (root: string, git: (...args: string[]) => string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-review-scopes-"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...gitEnvironment(),
        GIT_AUTHOR_NAME: "Fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
      },
    }).trim();
  try {
    git("init", "-q");
    await run(root, git);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("unstaged and final working-tree snapshots distinguish index/HEAD and preserve disk/index", async () =>
  fixture(async (root, git) => {
    await writeFile(path.join(root, "a.ts"), "base\n");
    await writeFile(path.join(root, "deleted.ts"), "deleted\n");
    git("add", ".");
    git("commit", "-qm", "base");
    await writeFile(path.join(root, "a.ts"), "staged\n");
    git("add", "a.ts");
    await writeFile(path.join(root, "a.ts"), "working\n");
    await rm(path.join(root, "deleted.ts"));
    await writeFile(path.join(root, "漢字\tfile.ts"), "new\n");
    await writeFile(path.join(root, ".gitignore"), "ignored\n");
    await writeFile(path.join(root, "ignored"), "secret");
    const index = digest(await readFile(path.join(root, ".git/index")));
    const unstaged = await captureGitReview(root, { kind: "unstaged" });
    const working = await captureGitReview(root, { kind: "workingTree" });
    assert.equal(unstaged.files.find((file) => file.path === "a.ts")?.before, "staged\n");
    assert.equal(working.files.find((file) => file.path === "a.ts")?.before, "base\n");
    for (const snapshot of [unstaged, working]) {
      assert.equal(snapshot.files.find((file) => file.path === "a.ts")?.after, "working\n");
      assert.equal(snapshot.files.find((file) => file.path === "deleted.ts")?.status, "D");
      assert.equal(snapshot.files.find((file) => file.path === "漢字\tfile.ts")?.status, "A");
      assert.equal(
        snapshot.files.some((file) => file.path === "ignored"),
        false,
      );
      await assertGitReviewCurrent(snapshot);
    }
    assert.equal(digest(await readFile(path.join(root, ".git/index"))), index);
    assert.equal(await readFile(path.join(root, "a.ts"), "utf8"), "working\n");
    await writeFile(path.join(root, "new-untracked"), "new");
    await assert.rejects(assertGitReviewCurrent(unstaged), /stale/);
    await assert.rejects(assertGitReviewCurrent(working), /stale/);
  }));

test("working-tree scope handles unborn commits, deletes, and rename as exact before/after paths", async () =>
  fixture(async (root, git) => {
    await writeFile(path.join(root, "a"), "first");
    git("add", "a");
    await writeFile(path.join(root, "a"), "second");
    const unborn = await captureGitReview(root, { kind: "workingTree" });
    assert.equal(unborn.files[0]?.before, undefined);
    assert.equal(unborn.files[0]?.after, "second");
    git("add", "a");
    git("commit", "-qm", "base");
    git("mv", "a", "renamed");
    const renamed = await captureGitReview(root, { kind: "workingTree" });
    assert.equal(renamed.files.find((file) => file.path === "a")?.before, "second");
    assert.equal(renamed.files.find((file) => file.path === "renamed")?.after, "second");
  }));

test("branch review resolves listed refs, pins merge-base/HEAD, excludes dirty worktree and notices ref movement", async () =>
  fixture(async (root, git) => {
    await writeFile(path.join(root, "a"), "base");
    git("add", "a");
    git("commit", "-qm", "base");
    git("branch", "base");
    await writeFile(path.join(root, "a"), "branch");
    git("add", "a");
    git("commit", "-qm", "branch");
    await writeFile(path.join(root, "a"), "dirty");
    const bases = await listGitReviewBases(root);
    assert.ok(bases.some((base) => base.ref === "refs/heads/base"));
    git("update-ref", "refs/remotes/origin/base", git("rev-parse", "base"));
    assert.ok((await listGitReviewBases(root)).some((base) => base.ref === "refs/remotes/origin/base"));
    assert.equal(
      (await captureGitReview(root, { kind: "branch", baseRef: "refs/remotes/origin/base" })).files[0]?.after,
      "branch",
    );
    const snapshot = await captureGitReview(root, { kind: "branch", baseRef: "refs/heads/base" });
    assert.equal(snapshot.files[0]?.before, "base");
    assert.equal(snapshot.files[0]?.after, "branch");
    assert.equal(snapshot.scope.kind, "branch");
    git("add", "a");
    await assertGitReviewCurrent(snapshot); // Index does not affect commit-to-commit review.
    git("checkout", "--detach", "-q");
    await assertGitReviewCurrent(snapshot);
    git("commit", "-qm", "new detached head");
    await assert.rejects(assertGitReviewCurrent(snapshot), /stale/);
    git("branch", "-f", "base", "HEAD");
    await assert.rejects(assertGitReviewCurrent(snapshot), /changed|stale/);
    for (const baseRef of ["--help", "HEAD", "refs/heads/missing"])
      await assert.rejects(captureGitReview(root, { kind: "branch", baseRef }), /unavailable/);
  }));

test("review response validation and context preserve every scope without invented paths, sides or ranges", () => {
  for (const scope of [
    { kind: "staged" },
    { kind: "unstaged" },
    { kind: "workingTree" },
    { kind: "branch", baseRef: "refs/heads/base" },
  ] as const) {
    const snapshot: GitReviewSnapshot = {
      repository: { root: "/repo", gitDir: "/repo/.git", commonDir: "/repo/.git" },
      revision: { head: null, index: "index" },
      scope,
      capturedAt: 1,
      identity: "fixture",
      diff: "",
      files: [{ path: "a.ts", oldPath: "old.ts", status: "R", before: "before\n", after: "after\n" }],
    };
    assert.deepEqual(JSON.parse(reviewContext(snapshot)).scope, scope);
    const finding = { path: "a.ts", side: "after", startLine: 1, endLine: 1, severity: "warning", message: "Finding" };
    assert.equal(
      parseGitReview(JSON.stringify({ incomplete: false, findings: [finding] }), snapshot).findings.length,
      1,
    );
    for (const invalid of [
      { path: "invented.ts" },
      { side: "worktree" },
      { endLine: 2 },
      { startLine: 0 },
      { path: "old.ts" },
      { severity: "fatal" },
    ]) {
      assert.throws(() =>
        parseGitReview(JSON.stringify({ incomplete: false, findings: [{ ...finding, ...invalid }] }), snapshot),
      );
    }
  }
});

test("worktree review bounds unsafe files and never executes Git filters or external diff", async () =>
  fixture(async (root, git) => {
    await writeFile(path.join(root, "a"), "base");
    git("add", "a");
    git("commit", "-qm", "base");
    await writeFile(path.join(root, "a"), "new");
    await writeFile(path.join(root, "binary"), Buffer.from([0, 1]));
    await writeFile(path.join(root, "large"), "x".repeat(100_001));
    await symlink("../escape", path.join(root, "link"));
    await mkdir(path.join(root, "dir"));
    git("update-index", "--add", "--cacheinfo", "160000", git("rev-parse", "HEAD"), "submodule");
    await writeFile(path.join(root, ".gitattributes"), "a filter=unsafe diff=unsafe\n");
    git("config", "filter.unsafe.clean", "touch forbidden");
    git("config", "diff.unsafe.command", "touch forbidden");
    git("config", "core.fsmonitor", "touch forbidden");
    const snapshot = await captureGitReview(root, { kind: "unstaged" });
    assert.ok(snapshot.files.find((file) => file.path === "binary")?.skipped);
    assert.ok(snapshot.files.find((file) => file.path === "large")?.skipped);
    assert.ok(snapshot.files.find((file) => file.path === "link")?.skipped);
    assert.ok(snapshot.files.find((file) => file.path === "submodule")?.skipped);
    await assert.rejects(readFile(path.join(root, "forbidden")), { code: "ENOENT" });
    const cancelled = new AbortController();
    cancelled.abort();
    await assert.rejects(captureGitReview(root, { kind: "unstaged" }, cancelled.signal), /cancelled/);
  }));
