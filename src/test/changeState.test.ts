import assert from "node:assert/strict";
import test from "node:test";
import { canSafelyRevert, fileVersion, hasFileChanged } from "../changeState";

test("fileVersion distinguishes missing, created, modified, and unchanged files", () => {
  const missing = fileVersion(undefined);
  const before = fileVersion(Buffer.from("before"));
  const same = fileVersion(Buffer.from("before"));
  const after = fileVersion(Buffer.from("after"));

  assert.equal(hasFileChanged(missing, before), true);
  assert.equal(hasFileChanged(before, missing), true);
  assert.equal(hasFileChanged(before, same), false);
  assert.equal(hasFileChanged(before, after), true);
});

test("safe revert requires the exact recorded post-agent version", () => {
  const recorded = fileVersion(Buffer.from("agent output"));

  assert.equal(canSafelyRevert(recorded, fileVersion(Buffer.from("agent output"))), true);
  assert.equal(canSafelyRevert(recorded, fileVersion(Buffer.from("user changed it"))), false);
  assert.equal(canSafelyRevert(recorded, fileVersion(undefined)), false);
  assert.equal(canSafelyRevert(fileVersion(undefined), fileVersion(undefined)), true);
});
