import assert from "node:assert/strict";
import {
  assertBackgroundTaskCapacity,
  backgroundTaskIdsToEvict,
  countOccupiedBackgroundTaskSlots,
  isBackgroundTaskActive,
} from "../backgroundAgentLifecycle";

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
