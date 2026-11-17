import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { acquireAgentOperation, acquireOperation, hasOperation, observeOperations } from "../operationLocks";

function workspace(): string {
  return path.join(tmpdir(), `pi-operation-locks-${randomUUID()}`);
}

test("agent leases coexist and synchronously notify every lease on its first overlap", () => {
  const root = workspace();
  const calls = [0, 0, 0];
  const releases: (() => void)[] = [];
  try {
    releases.push(acquireAgentOperation(root, "first agent", () => calls[0]++));
    assert.equal(hasOperation(root), true);
    assert.deepEqual(calls, [0, 0, 0]);
    releases.push(acquireAgentOperation(root, "second agent", () => calls[1]++));
    assert.deepEqual(calls, [1, 1, 0], "both notifications complete before the second admission returns");
    releases.push(acquireAgentOperation(root, "third agent", () => calls[2]++));
    assert.deepEqual(calls, [1, 1, 1], "an already notified lease does not need another notification");
    assert.throws(() => acquireOperation(root, "checkpoint restore"), /first agent/);
  } finally {
    for (const release of releases) release();
  }
  assert.equal(hasOperation(root), false);
});

test("exclusive operations and agent leases block each other", () => {
  const root = workspace();
  let overlaps = 0;
  const releaseExclusive = acquireOperation(root, "Apply");
  try {
    assert.throws(() => acquireAgentOperation(root, "agent", () => overlaps++), /Wait for Apply before agent/);
    assert.throws(() => acquireOperation(root, "import"), /Wait for Apply before import/);
    assert.equal(overlaps, 0);
  } finally {
    releaseExclusive();
  }
  const releaseAgent = acquireAgentOperation(root, "agent", () => overlaps++);
  try {
    assert.throws(() => acquireOperation(root, "Apply"), /Wait for agent before Apply/);
    assert.equal(hasOperation(root), true);
    assert.equal(overlaps, 0);
  } finally {
    releaseAgent();
  }
});

test("releasing one agent is idempotent and cannot release another agent or a replacement operation", () => {
  const root = workspace();
  const first = acquireAgentOperation(root, "first", () => {});
  const second = acquireAgentOperation(root, "second", () => {});
  try {
    first();
    first();
    assert.equal(hasOperation(root), true);
    assert.throws(() => acquireOperation(root, "Apply"), /second/);
    second();
    assert.equal(hasOperation(root), false);
    const exclusive = acquireOperation(root, "Apply");
    try {
      first();
      second();
      assert.equal(hasOperation(root), true);
    } finally {
      exclusive();
    }
    const replacement = acquireAgentOperation(root, "replacement", () => {});
    try {
      first();
      second();
      assert.equal(hasOperation(root), true);
      assert.throws(() => acquireOperation(root, "restore"), /replacement/);
    } finally {
      replacement();
    }
  } finally {
    first();
    second();
  }
});

test("old exclusive releases cannot clear replacement leases and roots remain independent", () => {
  const root = workspace();
  const other = workspace();
  const first = acquireOperation(root, "first");
  first();
  const replacement = acquireAgentOperation(path.join(root, "."), "replacement", () => {});
  const independent = acquireOperation(other, "independent");
  try {
    first();
    assert.equal(hasOperation(root), true);
    assert.equal(hasOperation(other), true);
    assert.throws(() => acquireOperation(path.join(root, "child", ".."), "Apply"), /replacement/);
    independent();
    assert.equal(hasOperation(root), true);
  } finally {
    replacement();
    independent();
  }
});

test("a throwing overlap callback does not suppress other callbacks or leak the failed lease", () => {
  const root = workspace();
  const calls: string[] = [];
  const first = acquireAgentOperation(root, "first", () => {
    calls.push("first");
    throw new Error("callback failed");
  });
  try {
    assert.throws(
      () => acquireAgentOperation(root, "second", () => calls.push("second")),
      /notification failed; admission cancelled/,
    );
    assert.deepEqual(calls, ["first", "second"]);
    assert.equal(hasOperation(root), true);
  } finally {
    first();
  }
  assert.equal(hasOperation(root), false);
});

test("observers synchronously receive each admitted operation's opaque owner but not blocked admissions", () => {
  const root = workspace();
  const other = workspace();
  const owner = {};
  const owners: (object | undefined)[] = [];
  const held: boolean[] = [];
  const observer = observeOperations(root, (value) => {
    owners.push(value);
    held.push(hasOperation(root));
  });
  const releases: (() => void)[] = [];
  try {
    releases.push(acquireAgentOperation(root, "first", () => {}, owner));
    assert.deepEqual(owners, [owner]);
    releases.push(acquireAgentOperation(root, "second", () => {}));
    assert.deepEqual(owners, [owner, undefined]);
    assert.throws(() => acquireOperation(root, "blocked"));
    assert.equal(owners.length, 2);
    releases.push(acquireOperation(other, "other workspace"));
    assert.equal(owners.length, 2);
    for (const release of releases) release();
    releases.push(acquireOperation(root, "Apply", owner));
    assert.deepEqual(owners, [owner, undefined, owner]);
    assert.deepEqual(held, [true, true, true]);
  } finally {
    for (const release of releases) release();
    observer.dispose();
  }
});

test("observer registrations and disposal are independent even for the same listener", () => {
  const root = workspace();
  let calls = 0;
  const listener = () => calls++;
  const first = observeOperations(root, listener);
  const second = observeOperations(root, listener);
  first.dispose();
  first.dispose();
  try {
    acquireOperation(root, "Apply")();
    assert.equal(calls, 1);
    second.dispose();
    const replacement = observeOperations(root, listener);
    try {
      first.dispose();
      second.dispose();
      acquireOperation(root, "import")();
      assert.equal(calls, 2);
    } finally {
      replacement.dispose();
    }
    acquireOperation(root, "restore")();
    assert.equal(calls, 2);
  } finally {
    second.dispose();
  }
});

test("failed observer notifications reach remaining observers and overlap callbacks without leaking admission", () => {
  const root = workspace();
  const calls: string[] = [];
  const firstAgent = acquireAgentOperation(root, "first", () => calls.push("first agent"));
  const failing = observeOperations(root, () => {
    calls.push("failing observer");
    throw new Error("observer failed");
  });
  const remaining = observeOperations(root, () => calls.push("remaining observer"));
  try {
    assert.throws(() => acquireAgentOperation(root, "second", () => calls.push("second agent")), AggregateError);
    assert.deepEqual(calls, ["failing observer", "remaining observer", "first agent", "second agent"]);
    firstAgent();
    assert.equal(hasOperation(root), false);
    assert.throws(() => acquireOperation(root, "Apply"), AggregateError);
    assert.equal(hasOperation(root), false);
  } finally {
    firstAgent();
    failing.dispose();
    remaining.dispose();
  }
});
