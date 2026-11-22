import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceChangeTracker } from "../changeTracker";
import type { CheckpointHistory } from "../checkpointHistory";
import { acquireAgentOperation, acquireOperation, hasOperation } from "../operationLocks";
import { installVscodeMock } from "./vscodeMock";

function fixture() {
  const vscode = installVscodeMock();
  const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-concurrent-checkpoint-")));
  const first = new WorkspaceChangeTracker();
  const second = new WorkspaceChangeTracker();
  writeFileSync(path.join(root, "file"), "before");
  return {
    root,
    first,
    second,
    dispose: () => {
      first.dispose();
      second.dispose();
      vscode.restore();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function write(tracker: WorkspaceChangeTracker, root: string, content: string, name = "file"): void {
  tracker.captureToolEvent({ type: "tool_execution_start", toolName: "write", args: { path: name, content } });
  writeFileSync(path.join(root, name), content);
}

async function checkpoint(tracker: WorkspaceChangeTracker, root: string, content: string, session = "session") {
  await tracker.startRequest(root, session);
  write(tracker, root, content);
  const changes = tracker.finishRequest();
  assert.equal(changes.length, 1);
  const change = changes[0];
  assert.ok(change);
  assert.equal(change.canRevert, true);
  return change;
}

function history(tracker: WorkspaceChangeTracker): CheckpointHistory {
  return (tracker as unknown as { history: CheckpointHistory }).history;
}

function latestCheckpoint(tracker: WorkspaceChangeTracker) {
  const record = history(tracker).values.at(-1);
  assert.ok(record);
  return record;
}

test("overlapping agent requests exclude both captures and invalidate prior history without discarding recovery data", async () => {
  const f = fixture();
  const releases: (() => void)[] = [];
  try {
    const prior = await checkpoint(f.first, f.root, "prior result");
    const priorRecord = latestCheckpoint(f.first);
    priorRecord.restoreFailed = true;
    writeFileSync(path.join(f.root, "other"), "other before");
    const overlapped = [false, false];
    releases.push(
      acquireAgentOperation(f.root, "first", () => {
        overlapped[0] = true;
        f.first.invalidateConcurrentRequest();
      }),
    );
    await f.first.startRequest(f.root, "first");
    releases.push(
      acquireAgentOperation(f.root, "second", () => {
        overlapped[1] = true;
        f.second.invalidateConcurrentRequest();
      }),
    );
    assert.deepEqual(overlapped, [true, true]);
    await f.second.startRequest(f.root, "second");
    if (overlapped[1]) f.second.invalidateConcurrentRequest();
    write(f.first, f.root, "first result");
    write(f.second, f.root, "second result", "other");
    assert.deepEqual(f.first.finishRequest(), []);
    assert.deepEqual(f.second.finishRequest(), []);
    for (const tracker of [f.first, f.second]) {
      const record = latestCheckpoint(tracker);
      assert.deepEqual(record.files, []);
      assert.match(record.exclusions.join("\n"), /Concurrent workspace writers: request attribution is unproven/);
    }
    for (const release of releases) release();
    writeFileSync(path.join(f.root, "file"), "prior result");
    assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "prior result");
    assert.equal(history(f.first).values[0], priorRecord);
    assert.equal(priorRecord.restoreFailed, true);
    assert.deepEqual(priorRecord.files, [{ path: "file", before: "before", after: "prior result" }]);
    assert.equal(history(f.first).retainedBytes, Buffer.byteLength("beforeprior result"));
  } finally {
    for (const release of releases) release();
    f.dispose();
  }
});

test("overlap known before capture invalidates completed checkpoints and can be reapplied after startRequest", async () => {
  const f = fixture();
  try {
    f.first.invalidateConcurrentRequest();
    const prior = await checkpoint(f.first, f.root, "prior result");
    f.first.invalidateConcurrentRequest();
    f.first.invalidateConcurrentRequest();
    assert.equal(f.first.changes[0]?.canRevert, false);
    assert.throws(() => f.first.revert(prior.id), /restore unavailable/);
    await f.first.startRequest(f.root, "session");
    f.first.invalidateConcurrentRequest();
    f.first.invalidateConcurrentRequest();
    write(f.first, f.root, "overlapped result");
    assert.deepEqual(f.first.finishRequest(), []);
    const record = latestCheckpoint(f.first);
    assert.equal(record.exclusions.filter((reason) => reason.startsWith("Concurrent workspace writers:")).length, 1);
    const fresh = await checkpoint(f.first, f.root, "later independent result");
    f.first.revert(fresh.id);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "overlapped result");
  } finally {
    f.dispose();
  }
});

test("concurrent-writer exclusion remains explicit when other exclusions have reached the report limit", async () => {
  const f = fixture();
  try {
    await f.first.startRequest(f.root);
    for (let index = 0; index < 1_001; index++) {
      f.first.captureToolEvent({ type: "tool_execution_start", toolName: "write", args: { path: `missing-${index}` } });
    }
    f.first.invalidateConcurrentRequest();
    write(f.first, f.root, "result");
    assert.deepEqual(f.first.finishRequest(), []);
    const exclusions = latestCheckpoint(f.first).exclusions;
    assert.equal(exclusions.length, 1_000);
    assert.match(exclusions[0] ?? "", /^Concurrent workspace writers:/);
  } finally {
    f.dispose();
  }
});

test("sequential sibling agent admission invalidates old attribution even if final bytes match again", async () => {
  const f = fixture();
  const releases: (() => void)[] = [];
  try {
    f.first.enableConcurrentSafety(f.root);
    f.second.enableConcurrentSafety(f.root);
    let overlaps = 0;
    const releaseFirst = acquireAgentOperation(f.root, "first", () => overlaps++, f.first);
    releases.push(releaseFirst);
    const prior = await checkpoint(f.first, f.root, "first result", "first");
    releaseFirst();
    assert.equal(f.first.changes[0]?.canRevert, true);
    const releaseSecond = acquireAgentOperation(f.root, "second", () => overlaps++, f.second);
    releases.push(releaseSecond);
    assert.equal(f.first.changes[0]?.canRevert, false);
    await f.second.startRequest(f.root, "second");
    write(f.second, f.root, "temporary sibling result");
    write(f.second, f.root, "first result");
    assert.deepEqual(f.second.finishRequest(), []);
    releaseSecond();
    assert.equal(overlaps, 0, "these requests did not overlap");
    assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "first result");
  } finally {
    for (const release of releases) release();
    f.dispose();
  }
});

for (const label of ["Apply", "worktree import", "checkpoint restore"]) {
  test(`sibling ${label} admission makes earlier checkpoints non-restorable`, async () => {
    const f = fixture();
    try {
      f.first.enableConcurrentSafety(f.root);
      const releaseAgent = acquireAgentOperation(f.root, "first", () => {}, f.first);
      let prior: Awaited<ReturnType<typeof checkpoint>>;
      try {
        prior = await checkpoint(f.first, f.root, "first result");
      } finally {
        releaseAgent();
      }
      const releaseMutation = acquireOperation(f.root, label, f.second);
      try {
        assert.equal(f.first.changes[0]?.canRevert, false);
      } finally {
        releaseMutation();
      }
      assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
      assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "first result");
    } finally {
      f.dispose();
    }
  });
}

test("a tracker can restore its own valid checkpoint without invalidating itself", async () => {
  const f = fixture();
  try {
    f.first.enableConcurrentSafety(f.root);
    f.second.enableConcurrentSafety(f.root);
    const release = acquireAgentOperation(f.root, "first", () => {}, f.first);
    let change: Awaited<ReturnType<typeof checkpoint>>;
    try {
      change = await checkpoint(f.first, f.root, "first result");
    } finally {
      release();
    }
    f.first.revert(change.id);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "before");
    assert.equal(hasOperation(f.root), false);
    assert.equal(history(f.first).values[0]?.files[0]?.reverted, true);
  } finally {
    f.dispose();
  }
});

test("enabling concurrent safety invalidates existing checkpoints but single-tracker behavior stays unchanged", async () => {
  const f = fixture();
  try {
    const baseline = await checkpoint(f.first, f.root, "baseline");
    acquireOperation(f.root, "unrelated existing control")();
    f.first.revert(baseline.id);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "before");
    const prior = await checkpoint(f.first, f.root, "prior result");
    f.first.enableConcurrentSafety(f.root);
    assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
    const fresh = await checkpoint(f.first, f.root, "fresh result");
    f.first.enableConcurrentSafety(path.join(f.root, "."));
    f.first.revert(fresh.id);
    assert.equal(readFileSync(path.join(f.root, "file"), "utf8"), "prior result");
  } finally {
    f.dispose();
  }
});

test("concurrent observation survives session reset and is removed on disposal", async () => {
  const f = fixture();
  try {
    f.first.enableConcurrentSafety(f.root);
    f.first.resetSession();
    const prior = await checkpoint(f.first, f.root, "after reset");
    acquireOperation(f.root, "sibling Apply", f.second)();
    assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
    f.first.dispose();
    let invalidations = 0;
    f.first.invalidateCheckpoints = () => invalidations++;
    acquireOperation(f.root, "after disposal")();
    assert.equal(invalidations, 0);
  } finally {
    f.dispose();
  }
});

test("preview lookup distinguishes another tracker's missing content from an empty captured file", async () => {
  const f = fixture();
  try {
    const { Uri } = require("vscode") as typeof import("vscode");
    const change = await checkpoint(f.first, f.root, "");
    const record = latestCheckpoint(f.first);
    const before = Uri.from({ scheme: "pi-checkpoint", path: "/file", query: `${record.id}-before` });
    const after = before.with({ query: `${record.id}-after` });
    await f.first.review(change.id);
    assert.equal(f.first.lookupPreview(before), "before");
    assert.equal(f.first.lookupPreview(after), "");
    assert.equal(f.first.provideTextDocumentContent(after), "");
    assert.equal(f.second.lookupPreview(after), undefined);
    assert.equal(f.second.provideTextDocumentContent(after), "Checkpoint preview expired.");
    f.first.invalidateCheckpoints();
    assert.equal(f.first.lookupPreview(after), undefined);
    assert.equal(f.first.provideTextDocumentContent(after), "Checkpoint preview expired.");
  } finally {
    f.dispose();
  }
});

test("startRequest rebinds enabled observation when its canonical workspace changes", async () => {
  const f = fixture();
  const other = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-rebound-checkpoint-")));
  try {
    writeFileSync(path.join(other, "file"), "other before");
    f.first.enableConcurrentSafety(f.root);
    const prior = await checkpoint(f.first, other, "other result");
    acquireOperation(f.root, "old workspace operation")();
    assert.equal(f.first.changes[0]?.canRevert, true);
    acquireOperation(other, "current workspace operation")();
    assert.throws(() => f.first.revert(prior.id), /historical checkpoint attribution is unverified/);
  } finally {
    f.dispose();
    rmSync(other, { recursive: true, force: true });
  }
});
