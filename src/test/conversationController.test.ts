import assert from "node:assert/strict";
import test from "node:test";
import { ConversationRequestGate } from "../conversationController";

test("conversation request gate rejects overlap and releases idempotently", () => {
  const gate = new ConversationRequestGate();
  const release = gate.acquire();

  assert.throws(() => gate.acquire(), /Pi is already working/);

  release();
  release();
  assert.doesNotThrow(() => gate.acquire()());
});
