import assert from "node:assert/strict";
import { InteractiveSessionSlots } from "../interactiveSessionSlots";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

test("interactive runtime capacity is fixed at eight and checks do not consume a slot", () => {
  const slots = new InteractiveSessionSlots();
  assert.equal(slots.capacity, 8);
  assert.equal(slots.count, 0);
  slots.check();
  assert.equal(slots.count, 0);
  const releases = Array.from({ length: slots.capacity }, () => slots.acquire());
  assert.equal(slots.count, 8);
  assert.throws(() => slots.check(), /Close a Pi session|session slot/);
  assert.throws(() => slots.acquire(), /Close a Pi session|session slot/);
  assert.equal(slots.count, 8, "Rejected admission cannot evict a retained runtime");
  for (const release of releases) release();
  assert.equal(slots.count, 0);
});

test("release is idempotent, including after its slot has been reused", () => {
  const slots = new InteractiveSessionSlots();
  const first = slots.acquire();
  first();
  first();
  assert.equal(slots.count, 0);
  const second = slots.acquire();
  first();
  assert.equal(slots.count, 1);
  second();
  second();
  assert.equal(slots.count, 0);
});

test("Sidebar and editor admissions sharing a pool cannot race past the final slot", async () => {
  const slots = new InteractiveSessionSlots();
  const retained = Array.from({ length: 7 }, () => slots.acquire());
  const cleanup = deferred();
  const releaseEditor = slots.acquire();
  const closingEditor = cleanup.promise.then(() => releaseEditor());
  assert.equal(slots.count, 8, "Pending creation or cleanup counts before asynchronous work settles");
  const sidebarAdmission = async () => slots.acquire();
  const attempts = await Promise.allSettled([sidebarAdmission(), sidebarAdmission()]);
  assert.deepEqual(
    attempts.map((attempt) => attempt.status),
    ["rejected", "rejected"],
  );
  assert.equal(slots.count, 8);
  cleanup.resolve();
  await closingEditor;
  const accepted = await sidebarAdmission();
  assert.equal(slots.count, 8);
  releaseEditor();
  assert.equal(slots.count, 8, "Late cleanup cannot release another surface's reused slot");
  accepted();
  for (const release of retained) release();
  assert.equal(slots.count, 0);
});

test("a cleanup-quarantined reservation stays counted without blocking unrelated releases", () => {
  const slots = new InteractiveSessionSlots();
  slots.acquire(); // No verified cleanup: retain the reservation until window reload.
  const verified = Array.from({ length: 7 }, () => slots.acquire());
  assert.throws(() => slots.acquire(), /session slot/);
  for (const release of verified) release();
  assert.equal(slots.count, 1);
  const replacements = Array.from({ length: 7 }, () => slots.acquire());
  assert.throws(() => slots.acquire(), /session slot/);
  for (const release of replacements) release();
  assert.equal(slots.count, 1);
});
