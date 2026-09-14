import assert from "node:assert/strict";
import {
  ConversationRequestGate,
  ConversationRequestLifecycle,
  ConversationResponseCapture,
  ConversationSideEffectTracker,
  ExclusiveOperationGate,
  conversationRequestBehavior,
  requestMayHaveProducedSideEffects,
  shouldTrackConversationChanges,
} from "../conversationController";

test("exclusive operation gates reject overlap and release idempotently", () => {
  const gate = new ConversationRequestGate();
  const release = gate.acquire();

  assert.equal(gate.isPending, true);
  assert.throws(() => gate.acquire(), /Pi is already working/);

  release();
  release();
  assert.equal(gate.isPending, false);
  assert.doesNotThrow(() => gate.acquire()());

  const backgroundGate = new ExclusiveOperationGate("A background agent is already starting.");
  const releaseBackground = backgroundGate.acquire();
  assert.throws(() => backgroundGate.acquire(), /background agent is already starting/);
  releaseBackground();
  assert.equal(backgroundGate.isPending, false);
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

test("change checkpoints cover every request except explicit read-only workflows", () => {
  assert.equal(shouldTrackConversationChanges(undefined), true);
  assert.equal(shouldTrackConversationChanges("read-only"), false);
});

test("any tool makes a default Pi request non-retryable after possible side effects", () => {
  for (const tool of ["bash", "edit", "write", "read", "custom_extension_tool"]) {
    assert.equal(requestMayHaveProducedSideEffects(undefined, [tool]), true);
  }
  assert.equal(requestMayHaveProducedSideEffects(undefined, []), false);
  assert.equal(requestMayHaveProducedSideEffects("read-only", ["bash"]), false);

  const lifecycle = new ConversationRequestLifecycle();
  const tracker = new ConversationSideEffectTracker(lifecycle);
  lifecycle.begin();
  tracker.record(undefined, "read");
  assert.equal(lifecycle.canRetry, false);
  tracker.record(undefined, "custom_extension_tool");
  assert.equal(tracker.mayHaveSideEffects, true);
  tracker.reset();
  assert.equal(tracker.mayHaveSideEffects, false);
});
