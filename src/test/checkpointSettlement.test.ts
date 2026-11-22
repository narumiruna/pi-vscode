import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { WorkspaceChangeTracker } from "../changeTracker";
import { maxCheckpointFile, type SettlementEntry } from "../checkpointCapture";
import { checkpointCaptureWorker } from "../checkpointCaptureHost";
import type { CheckpointHistory } from "../checkpointHistory";
import { acquireAgentOperation, acquireOperation } from "../operationLocks";
import { installVscodeMock, MockUri } from "./vscodeMock";

interface MockEditor {
  emitTextDocumentChange(event: { document: { uri: MockUri; isDirty: boolean }; contentChanges: object[] }): void;
  textDocuments: { uri: MockUri; isDirty: boolean }[];
}

async function fixture(run: (root: string, tracker: WorkspaceChangeTracker, editor: MockEditor) => Promise<void>) {
  const vscode = installVscodeMock();
  const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
  const tracker = new WorkspaceChangeTracker();
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "pi-settlement-")));
  try {
    mkdirSync(path.join(root, "filler"));
    for (let i = 0; i < 520; i++) writeFileSync(path.join(root, "filler", `${i}.txt`), "unchanged\n");
    await run(root, tracker, vscode.workspace);
  } finally {
    tracker.dispose();
    await checkpointCaptureWorker.close();
    vscode.restore();
    rmSync(root, { recursive: true, force: true });
  }
}

function records(tracker: WorkspaceChangeTracker) {
  return (tracker as unknown as { history: CheckpointHistory }).history.values;
}

function announce(tracker: WorkspaceChangeTracker, name: string, text?: string) {
  tracker.captureToolEvent({ type: "tool_execution_start", toolName: "write", args: { path: name, content: text } });
}

test("worker settlement matches exact before and announced results, retains exclusions and preserves restore preflight", async () => {
  await fixture(async (root, tracker, editor) => {
    const names = [
      "covered",
      "dirty",
      "bufferedited",
      "unannounced",
      "mismatch",
      "unsupported",
      "deleted",
      "binary",
      "linked",
      "large",
    ];
    const file = (name: string) => path.join(root, name);
    for (const name of names) writeFileSync(file(name), "before");
    const large = "é".repeat(maxCheckpointFile / 2);
    writeFileSync(file("large"), large);
    await tracker.startRequest(root, "fixture");
    for (const name of [
      "covered",
      "dirty",
      "bufferedited",
      "unannounced",
      "mismatch",
      "unsupported",
      "binary",
      "linked",
    ]) {
      writeFileSync(file(name), "result");
      if (name !== "unannounced") announce(tracker, name, name === "unsupported" ? undefined : "result");
    }
    writeFileSync(file("mismatch"), "external result");
    writeFileSync(file("binary"), Buffer.from([0, 0xff]));
    rmSync(file("deleted"));
    if (process.platform !== "win32") {
      rmSync(file("linked"));
      symlinkSync("covered", file("linked"));
    } else writeFileSync(file("linked"), "external result");
    const after = `${large.slice(0, -1)}è`;
    writeFileSync(file("large"), after);
    announce(tracker, "large", after);
    const settled = tracker.finishRequest("cancelled");
    assert.equal(tracker.finishRequest(), settled);
    assert.deepEqual(tracker.changes, [], "do not publish partial restore authority");
    editor.textDocuments = [{ uri: MockUri.file(file("dirty")), isDirty: true }];
    editor.emitTextDocumentChange({
      document: { uri: MockUri.file(file("bufferedited")), isDirty: true },
      contentChanges: [{}],
    });
    const changes = await settled;
    assert.deepEqual(
      changes?.map((change) => change.label),
      ["covered", "large"],
    );
    const record = records(tracker).at(-1);
    assert.ok(record);
    assert.equal(record.status, "cancelled");
    assert.equal(record.files.find((candidate) => candidate.path === "large")?.before, large);
    for (const name of names.filter((name) => !["covered", "large"].includes(name))) {
      assert.ok(
        record.exclusions.some((reason) => reason.startsWith(`${name}:`)),
        name,
      );
    }
    assert.ok(changes);
    const [covered, largeChange] = changes;
    assert.ok(covered && largeChange);
    await tracker.review(covered.id);
    tracker.revert(covered.id);
    assert.equal(readFileSync(file("covered"), "utf8"), "before");
    writeFileSync(file("large"), "stale");
    assert.throws(() => tracker.revert(largeChange.id), /stale/);
    assert.equal(readFileSync(file("large"), "utf8"), "stale");
    assert.equal(tracker.hasProtectedRecovery, true);
    assert.equal(record.files.find((candidate) => candidate.path === "large")?.after, after);
  });
});

test("a stale early match remains available for inspection but cannot offer Revert", async () => {
  await fixture(async (root, tracker) => {
    const name = "a-covered";
    const file = path.join(root, name);
    writeFileSync(file, "before");
    await tracker.startRequest(root);
    announce(tracker, name, "Pi result");
    writeFileSync(file, "Pi result");
    const pool = checkpointCaptureWorker;
    const original = pool.settle;
    let changedBeforeComplete = false;
    pool.settle = (root, entries, signal, accept) =>
      original.call(pool, root, entries, signal, (change) => {
        accept(change);
        if (change.path === name && change.matched) {
          changedBeforeComplete = true;
          writeFileSync(file, "external result");
        }
      });
    try {
      const [change] = (await tracker.finishRequest()) ?? [];
      assert.equal(changedBeforeComplete, true);
      assert.ok(change);
      assert.equal(change.canPreview, true);
      assert.equal(change.canRevert, false);
      assert.equal(records(tracker)[0]?.files[0]?.after, "Pi result");
      assert.throws(() => tracker.checkRestore(change.id), /stale/);
      assert.equal(readFileSync(file, "utf8"), "external result");
    } finally {
      pool.settle = original;
    }
  });
});

test("ownership replacement and reset reject stale jobs without poisoning the next settlement", async () => {
  await fixture(async (root, tracker) => {
    const name = "covered";
    const file = path.join(root, name);
    writeFileSync(file, "before");
    await tracker.startRequest(root, "old");
    writeFileSync(file, "old result");
    announce(tracker, name, "old result");
    let ownerMatches = true;
    const stale = tracker.finishRequest("completed", () => ownerMatches);
    ownerMatches = false;
    assert.equal(await stale, undefined);
    assert.equal(records(tracker).length, 0);
    await tracker.startRequest(root, "closing");
    writeFileSync(file, "closing result");
    announce(tracker, name, "closing result");
    const reset = tracker.finishRequest();
    tracker.resetSession();
    assert.equal(await reset, undefined);
    assert.equal(records(tracker).length, 0);
    await tracker.startRequest(root, "new");
    announce(tracker, name, "retained result");
    writeFileSync(file, "retained result");
    assert.deepEqual(
      (await tracker.finishRequest())?.map((change) => change.label),
      [name],
    );
    assert.equal(records(tracker)[0]?.sessionId, "new");
  });
});

test("same-path workspace replacement discards a pending result", async () => {
  await fixture(async (root, tracker) => {
    const name = "covered";
    const file = path.join(root, name);
    writeFileSync(file, "before");
    await tracker.startRequest(root);
    writeFileSync(file, "after");
    announce(tracker, name, "after");
    const pending = tracker.finishRequest();
    const previousRoot = `${root}-original`;
    renameSync(root, previousRoot);
    try {
      mkdirSync(root);
      writeFileSync(file, "after");
      assert.equal(await pending, undefined);
      assert.deepEqual(records(tracker), []);
    } finally {
      rmSync(previousRoot, { recursive: true, force: true });
    }
  });
});

test("same-root overlap and process exit supersede in-flight worker matches", async () => {
  await fixture(async (root, tracker) => {
    const name = "covered";
    const file = path.join(root, name);
    writeFileSync(file, "before");
    const releaseFirst = acquireAgentOperation(root, "request", () => tracker.invalidateConcurrentRequest(), tracker);
    try {
      await tracker.startRequest(root, "fixture");
      writeFileSync(file, "result");
      announce(tracker, name, "result");
      const pending = tracker.finishRequest();
      assert.throws(() => acquireOperation(root, "Apply"), /Wait for request/);
      const releaseOther = acquireAgentOperation(root, "another request", () => {});
      releaseOther();
      assert.equal(tracker.finishRequest("process-exit"), pending);
      assert.deepEqual(await pending, []);
      assert.equal(records(tracker).length, 1);
      const record = records(tracker)[0];
      assert.ok(record);
      assert.equal(record.status, "process-exit");
      assert.match(record.exclusions.join("\n"), /Concurrent workspace writers/);
      assert.match(record.exclusions.join("\n"), /Process exited without settlement/);
    } finally {
      releaseFirst();
    }
    acquireOperation(root, "Apply")();
  });
});

test("worker termination discards partial reports and releases queued jobs", async () => {
  await fixture(async (root, tracker) => {
    const file = path.join(root, "covered");
    writeFileSync(file, "before");
    await tracker.startRequest(root);
    writeFileSync(file, "after");
    announce(tracker, "covered", "after");
    const pool = checkpointCaptureWorker;
    const original = pool.settle;
    const settle = original.bind(pool);
    let terminated: Promise<void> | undefined;
    pool.settle = (root, entries, signal, accept) =>
      settle(root, entries, signal, (change) => {
        accept(change);
        terminated ??= pool.close();
      });
    try {
      const report = tracker.finishRequest();
      const empty: SettlementEntry[] = [];
      const queued = settle(root, empty.values(), new AbortController().signal, () =>
        assert.fail("no report for empty request"),
      );
      const [changes] = await Promise.all([report, assert.rejects(queued, /worker stopped/)]);
      assert.ok(terminated, "wait for an actual partial result before stopping the worker");
      await terminated;
      assert.deepEqual(changes, []);
      assert.match(records(tracker)[0]?.exclusions.join("\n") ?? "", /settlement failed/);
    } finally {
      pool.settle = original;
    }
    await tracker.startRequest(root);
    assert.deepEqual(await tracker.finishRequest(), []);
  });
});
