import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  shouldTrackConversationChanges,
} from "../conversationController";

test("conversation request gate rejects overlap and releases idempotently", () => {
  const gate = new ConversationRequestGate();
  const release = gate.acquire();

  assert.throws(() => gate.acquire(), /Pi is already working/);

  release();
  release();
  assert.doesNotThrow(() => gate.acquire()());
});

test("request lifecycle preserves cancellation until the next request and records completion", () => {
  const lifecycle = new ConversationRequestLifecycle();

  lifecycle.begin();
  lifecycle.cancel();
  assert.equal(lifecycle.wasCancelled, true);
  assert.equal(lifecycle.executionCompleted, false);

  lifecycle.begin();
  assert.equal(lifecycle.wasCancelled, false);
  lifecycle.completeExecution();
  assert.equal(lifecycle.executionCompleted, true);
  assert.equal(lifecycle.canRetry, false);
});

test("change checkpoints are captured only for effective mutating requests", () => {
  assert.equal(shouldTrackConversationChanges(undefined, "edit"), true);
  assert.equal(shouldTrackConversationChanges(undefined, "agent"), true);
  assert.equal(shouldTrackConversationChanges("read-only", "agent"), false);
  assert.equal(shouldTrackConversationChanges(undefined, "ask"), false);
  assert.equal(shouldTrackConversationChanges(undefined, "plan"), false);
});
