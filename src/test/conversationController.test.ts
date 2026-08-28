import assert from "node:assert/strict";
import test from "node:test";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  ConversationResponseCapture,
  conversationRequestBehavior,
  shouldTrackConversationChanges,
} from "../conversationController";

test("conversation request gate rejects overlap and releases idempotently", () => {
  const gate = new ConversationRequestGate();
  const release = gate.acquire();

  assert.equal(gate.isPending, true);
  assert.throws(() => gate.acquire(), /Pi is already working/);

  release();
  release();
  assert.equal(gate.isPending, false);
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

test("assistant capture follows request events across compaction without history indices", () => {
  const capture = new ConversationResponseCapture();
  capture.accept({ type: "message_end", message: { role: "user", content: "new request" } });
  capture.accept({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "first" }, { type: "text", text: "response" }] },
  });
  capture.accept({ type: "compaction_start" });
  capture.accept({ type: "compaction_end" });

  assert.equal(capture.response, "first\nresponse");

  capture.accept({ type: "message_end", message: { role: "assistant", content: "final response" } });
  assert.equal(capture.response, "final response");
  assert.equal(new ConversationResponseCapture().response, undefined);
});

test("request lifecycle preserves cancellation until the next request and records completion", () => {
  const lifecycle = new ConversationRequestLifecycle();

  lifecycle.begin();
  assert.doesNotThrow(() => lifecycle.throwIfCancelled());
  lifecycle.cancel();
  assert.equal(lifecycle.wasCancelled, true);
  assert.equal(lifecycle.executionCompleted, false);
  assert.throws(() => lifecycle.throwIfCancelled(), /Pi request was cancelled/);

  lifecycle.begin();
  assert.equal(lifecycle.wasCancelled, false);
  assert.doesNotThrow(() => lifecycle.throwIfCancelled());
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
