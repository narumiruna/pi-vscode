import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  assistantTextAfter,
  conversationRequestBehavior,
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

test("request origins preserve retry drafts and clear only newly accepted composer input", () => {
  assert.deepEqual(conversationRequestBehavior("composer"), {
    retryable: true,
    clearComposerOnAccepted: true,
  });
  assert.deepEqual(conversationRequestBehavior("retry"), {
    retryable: true,
    clearComposerOnAccepted: false,
  });
  assert.deepEqual(conversationRequestBehavior("editor"), {
    retryable: false,
    clearComposerOnAccepted: false,
  });
});

test("assistant lookup is scoped to messages after the request boundary", () => {
  const messages = [
    { role: "assistant", content: "old replacement" },
    { role: "user", content: "new request" },
    { role: "assistant", content: [{ type: "text", text: "new" }, { type: "text", text: "response" }] },
  ];

  assert.equal(assistantTextAfter(messages, 1), "new\nresponse");
  assert.throws(() => assistantTextAfter(messages.slice(0, 2), 1), /for this request/);
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
