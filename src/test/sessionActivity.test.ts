import assert from "node:assert/strict";
import { SessionActivity, type SessionActivityOutcome } from "../sessionActivity";

const outcomes: readonly SessionActivityOutcome[] = ["completed", "failed", "stopped"];

function snapshot(activity: SessionActivity) {
  return {
    status: activity.status,
    activeRequestId: activity.activeRequestId,
    resultRevision: activity.resultRevision,
    acknowledgedRevision: activity.acknowledgedRevision,
    unread: activity.unread,
  };
}

test("new activity is idle with no inferred historical result", () => {
  const activity = new SessionActivity();
  assert.deepEqual(snapshot(activity), {
    status: "idle",
    activeRequestId: undefined,
    resultRevision: 0,
    acknowledgedRevision: 0,
    unread: false,
  });
  for (const outcome of outcomes) activity.finish("unknown", outcome, true);
  assert.equal(activity.status, "idle");
  assert.equal(activity.resultRevision, 0);
  assert.equal(activity.acknowledge(0), true);
  assert.equal(activity.unread, false);
});

test("accepted startup stays running until an owned outcome, not runtime idle", () => {
  const activity = new SessionActivity();
  activity.begin("request");
  assert.equal(activity.status, "running");
  assert.equal(activity.activeRequestId, "request");
  assert.equal(activity.resultRevision, 0);

  activity.updateRuntime({ busy: true, pendingDialogs: false });
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "running", "runtime idle or disconnect does not settle the request");
  assert.equal(activity.activeRequestId, "request");
  assert.equal(activity.unread, false);

  activity.finish("request", "completed", true);
  assert.deepEqual(snapshot(activity), {
    status: "completed",
    activeRequestId: undefined,
    resultRevision: 1,
    acknowledgedRevision: 0,
    unread: true,
  });
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "completed");
});

for (const outcome of outcomes) {
  for (const hasResult of [false, true]) {
    test(`${outcome} increments once only when hasResult is ${hasResult}`, () => {
      const activity = new SessionActivity();
      activity.begin("request");
      activity.finish("request", outcome, hasResult);
      const settled = snapshot(activity);
      assert.deepEqual(settled, {
        status: outcome,
        activeRequestId: undefined,
        resultRevision: hasResult ? 1 : 0,
        acknowledgedRevision: 0,
        unread: hasResult,
      });
      for (const duplicateOutcome of outcomes) {
        activity.finish("request", duplicateOutcome, true);
        activity.finish("request", duplicateOutcome, false);
        assert.deepEqual(snapshot(activity), settled, "duplicate error, exit or settlement cannot change an outcome");
      }
    });
  }

  test(`begin replaces ${outcome} without resetting result or acknowledged revisions`, () => {
    const activity = new SessionActivity();
    activity.begin("first");
    activity.finish("first", outcome, true);
    assert.equal(activity.acknowledge(1), true);
    activity.begin("second");
    assert.deepEqual(snapshot(activity), {
      status: "running",
      activeRequestId: "second",
      resultRevision: 1,
      acknowledgedRevision: 1,
      unread: false,
    });
    activity.finish("second", "completed", true);
    activity.begin("third");
    assert.equal(activity.status, "running");
    assert.equal(activity.resultRevision, 2);
    assert.equal(activity.acknowledgedRevision, 1);
    assert.equal(activity.unread, true, "starting another request does not acknowledge an earlier result");
  });
}

test("delayed old outcomes cannot settle or overwrite a newer request", () => {
  const activity = new SessionActivity();
  activity.begin("old");
  activity.begin("new");
  const running = snapshot(activity);
  for (const outcome of outcomes) {
    activity.finish("old", outcome, true);
    activity.finish("unknown", outcome, true);
    assert.deepEqual(snapshot(activity), running);
  }
  activity.finish("new", "failed", true);
  const failed = snapshot(activity);
  assert.equal(failed.status, "failed");
  assert.equal(failed.resultRevision, 1);
  for (const outcome of outcomes) {
    activity.finish("old", outcome, true);
    activity.finish("new", outcome, true);
    assert.deepEqual(snapshot(activity), failed);
  }
});

test("waiting has priority over idle, runtime work, owned work and settled outcomes", () => {
  const activity = new SessionActivity();
  activity.updateRuntime({ busy: false, pendingDialogs: true });
  assert.equal(activity.status, "waiting");
  activity.updateRuntime({ busy: true, pendingDialogs: true });
  assert.equal(activity.status, "waiting");
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "idle");

  activity.begin("first");
  activity.updateRuntime({ busy: false, pendingDialogs: true });
  assert.equal(activity.status, "waiting");
  assert.equal(activity.activeRequestId, "first");
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "running");

  for (const outcome of outcomes) {
    activity.begin(outcome);
    activity.updateRuntime({ busy: false, pendingDialogs: true });
    activity.finish(outcome, outcome, true);
    assert.equal(activity.status, "waiting", "a settled result does not dismiss an originating dialog");
    assert.equal(activity.activeRequestId, undefined);
    activity.updateRuntime({ busy: false, pendingDialogs: false });
    assert.equal(activity.status, outcome);
  }
});

test("runtime busy represents queues, tools, retry and compaction without inferring completion", () => {
  const activity = new SessionActivity();
  activity.updateRuntime({ busy: true, pendingDialogs: false });
  assert.equal(activity.status, "running");
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "idle", "reconnect or idle without an owned outcome is not completion");
  assert.equal(activity.resultRevision, 0);

  activity.begin("request");
  activity.updateRuntime({ busy: true, pendingDialogs: false });
  activity.finish("request", "completed", true);
  assert.equal(activity.status, "running", "remaining runtime work takes priority over a settled outcome");
  assert.equal(activity.activeRequestId, undefined);
  for (const pendingDialogs of [true, false, true, false]) {
    activity.updateRuntime({ busy: true, pendingDialogs });
    assert.equal(activity.status, pendingDialogs ? "waiting" : "running");
    assert.equal(activity.resultRevision, 1, "progress and status reads do not create results");
  }
  activity.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(activity.status, "completed");
  assert.equal(activity.resultRevision, 1);
});

test("explicit stopped and failed outcomes survive runtime disconnect and reconnect", () => {
  for (const outcome of ["stopped", "failed"] as const) {
    const activity = new SessionActivity();
    activity.begin("request");
    activity.updateRuntime({ busy: false, pendingDialogs: false });
    assert.equal(activity.status, "running", "cancellation and disconnect need a final owned outcome");
    activity.finish("request", outcome, outcome === "failed");
    const settled = snapshot(activity);
    activity.updateRuntime({ busy: true, pendingDialogs: false });
    assert.equal(activity.status, "running");
    activity.updateRuntime({ busy: false, pendingDialogs: false });
    assert.deepEqual(snapshot(activity), settled);
  }
});

test("acknowledgement requires an exact nonnegative safe integer revision", () => {
  const activity = new SessionActivity();
  activity.begin("request");
  activity.finish("request", "failed", true);
  for (const revision of [-1, 0, 0.5, 1.5, 2, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(activity.acknowledge(revision), false);
    assert.equal(activity.acknowledgedRevision, 0);
    assert.equal(activity.unread, true);
  }
  assert.equal(activity.acknowledge(1), true);
  assert.equal(activity.acknowledge(1), true, "exact duplicate acknowledgements are idempotent");
  assert.equal(activity.resultRevision, 1);
  assert.equal(activity.acknowledgedRevision, 1);
  assert.equal(activity.unread, false);
});

test("an older rendered acknowledgement cannot clear a newer unread result", () => {
  const activity = new SessionActivity();
  activity.begin("first");
  activity.finish("first", "completed", true);
  const renderedRevision = activity.resultRevision;
  assert.equal(activity.acknowledge(renderedRevision), true);
  activity.begin("second");
  activity.finish("second", "failed", true);
  assert.equal(activity.resultRevision, 2);
  assert.equal(activity.acknowledge(renderedRevision), false);
  assert.equal(activity.acknowledge(3), false);
  assert.equal(activity.acknowledgedRevision, 1);
  assert.equal(activity.unread, true);
  assert.equal(activity.acknowledge(2), true);
  assert.equal(activity.unread, false);
});

test("acknowledgements may skip older unread results but never acknowledge a future result", () => {
  const activity = new SessionActivity();
  for (const request of ["first", "second"]) {
    activity.begin(request);
    activity.finish(request, "completed", true);
  }
  assert.equal(activity.acknowledge(1), false);
  assert.equal(activity.acknowledge(2), true);
  activity.begin("third");
  assert.equal(activity.acknowledge(3), false);
  activity.finish("third", "completed", true);
  assert.equal(activity.acknowledgedRevision, 2);
  assert.equal(activity.unread, true);
});

test("instances isolate equal request IDs, waiting, outcomes and read acknowledgements", () => {
  const a = new SessionActivity();
  const b = new SessionActivity();
  a.begin("same-id");
  b.begin("same-id");
  a.updateRuntime({ busy: true, pendingDialogs: true });
  b.finish("same-id", "completed", true);
  assert.equal(a.status, "waiting");
  assert.equal(a.activeRequestId, "same-id");
  assert.equal(a.resultRevision, 0);
  assert.equal(b.status, "completed");
  assert.equal(b.unread, true);

  a.finish("same-id", "stopped", true);
  assert.equal(a.acknowledge(1), true);
  assert.equal(b.unread, true);
  assert.equal(b.acknowledgedRevision, 0);
  a.updateRuntime({ busy: false, pendingDialogs: false });
  assert.equal(a.status, "stopped");
  assert.equal(a.unread, false);
  assert.equal(b.status, "completed");
  assert.equal(b.acknowledge(1), true);
  assert.equal(b.unread, false);
});
