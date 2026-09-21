import assert from "node:assert/strict";
import {
  assertBackgroundTaskCapacity,
  backgroundTaskIdsToEvict,
  countOccupiedBackgroundTaskSlots,
  isBackgroundTaskActive,
  launchBackgroundExecution,
} from "../backgroundAgentLifecycle";

test("background launch waits for prompt acceptance but not task settlement", async () => {
  let acceptPrompt: (() => void) | undefined;
  const promptAcceptance = new Promise<void>((resolve) => {
    acceptPrompt = resolve;
  });
  let notifyDispatched: (() => void) | undefined;
  const dispatched = new Promise<void>((resolve) => {
    notifyDispatched = resolve;
  });
  let launchResolved = false;

  const launch = launchBackgroundExecution(
    async () => {},
    () => {
      notifyDispatched?.();
      return promptAcceptance;
    },
  ).then(() => {
    launchResolved = true;
  });

  await dispatched;
  assert.equal(launchResolved, false);
  acceptPrompt?.();
  await launch;
  assert.equal(launchResolved, true);
});

test("background launch rejects when prompt acceptance fails", async () => {
  const failure = new Error("prompt rejected");
  await assert.rejects(
    launchBackgroundExecution(
      async () => {},
      () => Promise.reject(failure),
    ),
    failure,
  );
});

test("background task capacity and eviction preserve starting and running tasks", () => {
  assert.equal(isBackgroundTaskActive("starting"), true);
  assert.equal(isBackgroundTaskActive("running"), true);
  assert.equal(isBackgroundTaskActive("completed"), false);
  assert.equal(
    countOccupiedBackgroundTaskSlots(
      [
        ["starting", "starting"],
        ["running", "running"],
        ["done", "completed"],
        ["failed-active", "failed"],
      ],
      ["running", "failed-active"],
    ),
    3,
  );
  assert.doesNotThrow(() => assertBackgroundTaskCapacity(19, 20));
  assert.throws(() => assertBackgroundTaskCapacity(20, 20), /At most 20 background agents/);

  const taskIds = ["starting-oldest", "inactive-oldest", "running-newest", "inactive-newest"];
  const protectedTaskIds = new Set(["starting-oldest", "running-newest"]);
  assert.deepEqual(backgroundTaskIdsToEvict(taskIds, protectedTaskIds, 3), ["inactive-oldest"]);
  assert.deepEqual(backgroundTaskIdsToEvict(taskIds, new Set(taskIds), 3), []);
});
