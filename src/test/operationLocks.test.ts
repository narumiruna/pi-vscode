import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  acquireAgentOperation,
  acquireOperation,
  hasOperation,
  markWorkspaceCleanupUnverified,
  observeOperations,
} from "../operationLocks";

function workspace(): string {
  return path.join(tmpdir(), `pi-operation-locks-${randomUUID()}`);
}

function assertCleanupUnverified(root: string): void {
  assert.equal(hasOperation(root), true);
  assert.throws(
    () => acquireOperation(root, "exclusive work"),
    /cleanup is unverified.*Inspect and stop residual processes, then reload the window before exclusive work\./,
  );
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

test("idle cleanup reservations use the same root key and admit no later exclusive action", () => {
  const root = workspace();
  assert.equal(hasOperation(root), false);
  markWorkspaceCleanupUnverified(path.join(root, "child", ".."));
  assertCleanupUnverified(root);
  assertCleanupUnverified(path.join(root, "."));
  let admittedActions = 0;
  for (const label of ["Apply", "checkpoint restore", "import", "direct shell", "session controls"]) {
    assert.throws(() => {
      const release = acquireOperation(root, label);
      admittedActions++;
      release();
    }, /cleanup is unverified.*Inspect and stop residual processes, then reload the window before/);
  }
  assert.equal(admittedActions, 0);
  markWorkspaceCleanupUnverified(root);
  assertCleanupUnverified(root);
});

test("marking an active agent notifies overlap once and survives all lease releases", () => {
  const root = workspace();
  const calls: string[] = [];
  const first = acquireAgentOperation(root, "first", () => calls.push("first"));
  try {
    assert.deepEqual([...calls], []);
    markWorkspaceCleanupUnverified(root);
    assert.deepEqual(calls, ["first"]);
    assertCleanupUnverified(root);
    markWorkspaceCleanupUnverified(root);
    first();
    first();
    assertCleanupUnverified(root);
    const second = acquireAgentOperation(root, "second", () => calls.push("second"));
    try {
      assert.deepEqual(calls, ["first", "second"], "a sole later shared agent immediately overlaps the reservation");
      first();
      markWorkspaceCleanupUnverified(root);
      assert.deepEqual(calls, ["first", "second"]);
    } finally {
      second();
      second();
    }
    assertCleanupUnverified(root);
    const third = acquireAgentOperation(root, "third", () => calls.push("third"));
    third();
    assert.deepEqual(calls, ["first", "second", "third"]);
  } finally {
    first();
  }
  assertCleanupUnverified(root);
});

test("repeated marking does not repeat existing overlap callbacks or reservation notifications", () => {
  const root = workspace();
  const calls = [0, 0, 0];
  const first = acquireAgentOperation(root, "first", () => calls[0]++);
  const second = acquireAgentOperation(root, "second", () => calls[1]++);
  const owners: (object | undefined)[] = [];
  const observer = observeOperations(root, (owner) => owners.push(owner));
  try {
    assert.deepEqual(calls, [1, 1, 0]);
    markWorkspaceCleanupUnverified(root);
    markWorkspaceCleanupUnverified(path.join(root, "child", ".."));
    assert.deepEqual(calls, [1, 1, 0]);
    assert.deepEqual(owners, [undefined]);
    const third = acquireAgentOperation(root, "third", () => calls[2]++);
    try {
      assert.deepEqual(calls, [1, 1, 1]);
      markWorkspaceCleanupUnverified(root);
      assert.deepEqual(calls, [1, 1, 1]);
      assert.deepEqual(owners, [undefined, undefined], "shared admission still notifies observers");
    } finally {
      third();
    }
  } finally {
    first();
    second();
    observer.dispose();
  }
  assertCleanupUnverified(root);
});

test("active exclusive release and observer disposal cannot clear unverified cleanup", () => {
  const root = workspace();
  const release = acquireOperation(root, "existing operation");
  const owners: (object | undefined)[] = [];
  const observer = observeOperations(root, (owner) => owners.push(owner));
  try {
    markWorkspaceCleanupUnverified(root);
    assert.deepEqual(owners, [undefined]);
    assertCleanupUnverified(root);
    assert.throws(() => acquireAgentOperation(root, "agent", () => {}), /Wait for existing operation/);
    release();
    observer.dispose();
    observer.dispose();
    release();
    assertCleanupUnverified(root);
    let overlapped = false;
    const releaseAgent = acquireAgentOperation(root, "agent", () => {
      overlapped = true;
    });
    releaseAgent();
    assert.equal(overlapped, true);
    assert.deepEqual(owners, [undefined]);
  } finally {
    release();
    observer.dispose();
  }
  assertCleanupUnverified(root);
});

test("cleanup notifies every observer without an owner to invalidate historical attribution", () => {
  const root = workspace();
  const firstOwner = {};
  const secondOwner = {};
  const owners: (object | undefined)[][] = [[], []];
  const invalidated = [false, false];
  const observers = [firstOwner, secondOwner].map((own, index) =>
    observeOperations(root, (owner) => {
      owners[index].push(owner);
      if (owner !== own) invalidated[index] = true;
    }),
  );
  try {
    acquireOperation(root, "historical checkpoint", firstOwner)();
    assert.deepEqual(owners, [[firstOwner], [firstOwner]]);
    assert.deepEqual(invalidated, [false, true]);
    markWorkspaceCleanupUnverified(root);
    assert.deepEqual(owners, [
      [firstOwner, undefined],
      [firstOwner, undefined],
    ]);
    assert.deepEqual(invalidated, [true, true]);
    assertCleanupUnverified(root);
    assert.deepEqual(
      owners,
      [
        [firstOwner, undefined],
        [firstOwner, undefined],
      ],
      "rejected work sends no notification",
    );
  } finally {
    for (const observer of observers) observer.dispose();
  }
  assertCleanupUnverified(root);
});

test("cleanup protection precedes callbacks and survives reentry, releases, and notification failures", () => {
  const root = workspace();
  const calls: string[] = [];
  const held: boolean[] = [];
  let blockedCallbacks = 0;
  const first = acquireAgentOperation(root, "first", () => {
    calls.push("overlap");
    held.push(hasOperation(root));
    assertCleanupUnverified(root);
    blockedCallbacks++;
    throw new Error("overlap failed");
  });
  const failing = observeOperations(root, () => {
    calls.push("failing observer");
    first();
    held.push(hasOperation(root));
    markWorkspaceCleanupUnverified(root);
    assertCleanupUnverified(root);
    blockedCallbacks++;
    throw new Error("observer failed");
  });
  const remaining = observeOperations(root, () => {
    calls.push("remaining observer");
    held.push(hasOperation(root));
    assertCleanupUnverified(root);
    blockedCallbacks++;
    throw new Error("remaining observer failed");
  });
  try {
    assert.doesNotThrow(() => markWorkspaceCleanupUnverified(root));
    assert.deepEqual(calls, ["failing observer", "remaining observer", "overlap"]);
    assert.deepEqual(held, [true, true, true]);
    assert.equal(blockedCallbacks, 3, "every callback sees installed protection even after the last lease releases");
    assert.doesNotThrow(() => markWorkspaceCleanupUnverified(root));
    assert.equal(calls.length, 3);
  } finally {
    first();
    failing.dispose();
    remaining.dispose();
  }
  assertCleanupUnverified(root);
});

test("idle cleanup observer failures do not escape or remove the reservation", () => {
  const root = workspace();
  const calls: string[] = [];
  const failing = observeOperations(root, () => {
    calls.push("failing");
    throw new Error("observer failed");
  });
  const remaining = observeOperations(root, () => calls.push("remaining"));
  try {
    assert.doesNotThrow(() => markWorkspaceCleanupUnverified(root));
    assert.deepEqual(calls, ["failing", "remaining"]);
    assertCleanupUnverified(root);
    let overlaps = 0;
    assert.throws(() => acquireAgentOperation(root, "failed agent", () => overlaps++), AggregateError);
    assert.equal(overlaps, 1, "admission notification errors do not suppress the new agent's overlap callback");
    assert.deepEqual(calls, ["failing", "remaining", "failing", "remaining"]);
  } finally {
    failing.dispose();
    remaining.dispose();
  }
  assertCleanupUnverified(root);
});

test.each(["shared", "exclusive"])("%s admission rollback cannot clear cleanup marked by an observer", (kind) => {
  const root = workspace();
  const owner = {};
  const owners: (object | undefined)[] = [];
  let overlaps = 0;
  const observer = observeOperations(root, (value) => {
    owners.push(value);
    if (value !== owner) return;
    markWorkspaceCleanupUnverified(root);
    throw new Error("admission failed");
  });
  try {
    assert.throws(() => {
      if (kind === "shared") acquireAgentOperation(root, "failed agent", () => overlaps++, owner);
      else acquireOperation(root, "failed exclusive", owner);
    }, AggregateError);
    assert.deepEqual(owners, [owner, undefined]);
    assert.equal(overlaps, kind === "shared" ? 1 : 0);
  } finally {
    observer.dispose();
  }
  assertCleanupUnverified(root);
  const release = acquireAgentOperation(root, "later agent", () => overlaps++);
  release();
  assert.equal(overlaps, kind === "shared" ? 2 : 1);
  assertCleanupUnverified(root);
});

test("a failed later sole-agent overlap callback cannot clear sticky cleanup protection", () => {
  const root = workspace();
  markWorkspaceCleanupUnverified(root);
  let overlaps = 0;
  assert.throws(() => {
    acquireAgentOperation(root, "failed agent", () => {
      overlaps++;
      throw new Error("overlap failed");
    });
  }, /notification failed; admission cancelled/);
  assert.equal(overlaps, 1);
  assertCleanupUnverified(root);
  const release = acquireAgentOperation(root, "later agent", () => overlaps++);
  release();
  assert.equal(overlaps, 2);
  assertCleanupUnverified(root);
});

test("cleanup reservation and notifications do not affect an unrelated root", () => {
  const root = workspace();
  const other = workspace();
  const owners: (object | undefined)[] = [];
  const observer = observeOperations(other, (owner) => owners.push(owner));
  let overlaps = 0;
  const releaseOther = acquireAgentOperation(other, "unrelated agent", () => overlaps++);
  try {
    assert.deepEqual(owners, [undefined]);
    markWorkspaceCleanupUnverified(root);
    assert.equal(overlaps, 0);
    assert.deepEqual(owners, [undefined]);
    releaseOther();
    assert.equal(hasOperation(other), false);
    const owner = {};
    acquireOperation(other, "unrelated exclusive work", owner)();
    assert.deepEqual(owners, [undefined, owner]);
    assert.equal(hasOperation(other), false);
  } finally {
    releaseOther();
    observer.dispose();
  }
  assertCleanupUnverified(root);
});
