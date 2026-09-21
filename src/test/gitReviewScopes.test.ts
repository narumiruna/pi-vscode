import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

test.each(["unstaged", "workingTree"] as const)(
  "%s reads stable nested files through canonical and aliased workspace roots",
  async (kind) =>
    fixture(async (root, git) => {
      const alias = await mkdtemp(path.join(tmpdir(), "pi-review-root-alias-"));
      const target = path.join(root, "parent", "child", "file.ts");
      try {
        await rm(alias, { recursive: true });
        await symlink(root, alias, "junction");
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "base\n");
        git("add", "parent/child/file.ts");
        git("commit", "-qm", "base");
        await writeFile(target, "inside change\n");
        const index = digest(await readFile(path.join(root, ".git/index")));
        const canonical = await captureGitReview(root, { kind });
        const aliased = await captureGitReview(alias, { kind });
        assert.equal(canonical.files[0]?.after, "inside change\n");
        assert.equal(aliased.identity, canonical.identity);
        assert.equal(digest(await readFile(path.join(root, ".git/index"))), index);
      } finally {
        await rm(alias, { recursive: true, force: true });
      }
    }),
);

test.each(
  (["unstaged", "workingTree"] as const).flatMap((kind) =>
    (["after-parent-check", "before-open", "after-open", "restore-after-open", "during-read"] as const).map(
      (timing) => ({ kind, timing }),
    ),
  ),
)("$kind capture rejects parent swaps ($timing) without reading foreign descriptors", async ({ kind, timing }) =>
  fixture(async (root, git) => {
    const parent = path.join(root, "parent");
    const parked = path.join(root, "parked");
    const target = path.join(parent, "file.ts");
    const outside = await mkdtemp(path.join(tmpdir(), "pi-review-outside-"));
    await mkdir(parent);
    await writeFile(target, "base\n");
    git("add", "parent/file.ts");
    git("commit", "-qm", "base");
    await writeFile(target, "inside change\n");
    await writeFile(path.join(outside, "file.ts"), "OUTSIDE_PRIVATE_CONTENT\n");
    const fs = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalLstat = fs.lstat;
    const originalOpen = fs.open;
    let swapped = false;
    let swaps = 0;
    let blockedSwaps = 0;
    let foreignReads = 0;
    let opened = 0;
    let closed = 0;
    let armed = true;
    const outsideStat = await originalLstat(path.join(outside, "file.ts"));
    const swap = async () => {
      if (!armed) return;
      try {
        await rename(parent, parked);
      } catch (error) {
        // Windows can deny moving a directory while its child descriptor is open.
        if (process.platform === "win32" && ["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? ""))
          blockedSwaps++;
        throw error;
      }
      await symlink(outside, parent, "junction");
      swapped = true;
      armed = false;
      swaps++;
    };
    const restore = async () => {
      if (!swapped) return;
      await unlink(parent);
      await rename(parked, parent);
      swapped = false;
    };
    const lstatSpy = vi.spyOn(fs, "lstat").mockImplementation(async (file, options) => {
      const stat = await originalLstat(file, options);
      if (String(file) === parent && (timing === "after-parent-check" || timing === "restore-after-open")) await swap();
      return stat;
    });
    const openSpy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === target && timing === "before-open") await swap();
      const handle = await originalOpen(...args);
      if (String(args[0]) === target) {
        opened++;
        const stat = await handle.stat();
        const foreign = stat.dev === outsideStat.dev && stat.ino === outsideStat.ino;
        try {
          if (timing === "after-open") await swap();
          if (timing === "restore-after-open") await restore();
        } catch (error) {
          // The real open succeeded, but an injected scheduling operation failed
          // before the caller received the handle. The fixture owns cleanup here.
          await handle.close();
          closed++;
          await restore();
          armed = true;
          throw error;
        }
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async (...readArgs) => {
          if (timing === "during-read") await swap();
          if (foreign) foreignReads++;
          return read(...readArgs);
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          try {
            await close();
            closed++;
          } finally {
            await restore();
            armed = true;
          }
        });
      }
      return handle;
    });
    try {
      const snapshot = await captureGitReview(root, { kind });
      assert.ok(swaps > 0 || blockedSwaps > 0, "The injected swap must execute or be denied by Windows");
      if (blockedSwaps) console.log(`Windows denied ${blockedSwaps} directory rename attempts (${timing})`);
      assert.doesNotMatch(reviewContext(snapshot), /OUTSIDE_PRIVATE_CONTENT/);
      assert.ok(snapshot.files.find((file) => file.path === "parent/file.ts")?.skipped);
      assert.equal(foreignReads, 0, "Reject the opened foreign descriptor before reading bytes");
      assert.equal(opened, closed, "Every rejected descriptor must close");
    } finally {
      lstatSpy.mockRestore();
      openSpy.mockRestore();
      await restore();
      await rm(outside, { recursive: true, force: true });
    }
  }),
);

test("worktree capture rechecks the opened size before allocating or reading", async () =>
  fixture(async (root, git) => {
    const target = path.join(root, "file.ts");
    await writeFile(target, "base\n");
    git("add", "file.ts");
    git("commit", "-qm", "base");
    await writeFile(target, "inside change\n");
    const fs = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalOpen = fs.open;
    let reads = 0;
    let opened = 0;
    let closed = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (String(args[0]) === target) {
        opened++;
        await writeFile(target, "x".repeat(100_001));
        const read = handle.read.bind(handle);
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementation((...readArgs) => {
          reads++;
          return read(...readArgs);
        });
        vi.spyOn(handle, "close").mockImplementation(async () => {
          try {
            await close();
            closed++;
          } finally {
            await writeFile(target, "inside change\n");
          }
        });
      }
      return handle;
    });
    try {
      const snapshot = await captureGitReview(root, { kind: "workingTree" });
      assert.match(snapshot.files[0]?.skipped ?? "", /Oversized/);
      assert.ok(opened > 0);
      assert.equal(reads, 0);
      assert.equal(closed, opened);
    } finally {
      spy.mockRestore();
    }
  }));

test.skipIf(process.platform === "win32")("worktree capture rejects a substituted FIFO without blocking", async () =>
  fixture(async (root, git) => {
    const target = path.join(root, "file.ts");
    await writeFile(target, "base\n");
    git("add", "file.ts");
    git("commit", "-qm", "base");
    await writeFile(target, "inside change\n");
    const fs = require("node:fs/promises") as typeof import("node:fs/promises");
    const originalOpen = fs.open;
    let opened = 0;
    let closed = 0;
    const spy = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]) === target) {
        await unlink(target);
        execFileSync("mkfifo", [target]);
      }
      const handle = await originalOpen(...args);
      if (String(args[0]) === target) {
        opened++;
        const close = handle.close.bind(handle);
        vi.spyOn(handle, "read").mockImplementation(async () => assert.fail("Never read a substituted FIFO"));
        vi.spyOn(handle, "close").mockImplementation(async () => {
          try {
            await close();
            closed++;
          } finally {
            await unlink(target);
            await writeFile(target, "inside change\n");
          }
        });
      }
      return handle;
    });
    try {
      const snapshot = await captureGitReview(root, { kind: "workingTree" });
      assert.match(snapshot.files[0]?.skipped ?? "", /unsupported opened workspace file/);
      assert.ok(opened > 0);
      assert.equal(closed, opened);
    } finally {
      spy.mockRestore();
    }
  }),
);

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
