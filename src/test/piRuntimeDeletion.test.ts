import assert from "node:assert/strict";
import { installVscodeMock } from "./vscodeMock";

test("Trash-unavailable classification is narrow and does not treat ordinary deletion failures as unsupported", () => {
  const vscode = installVscodeMock();
  try {
    const { isTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    assert.equal(isTrashUnavailableError({ code: "Unavailable", message: "Trash unavailable for /remote/session.jsonl" }), true);
    assert.equal(isTrashUnavailableError({ code: "Unavailable", message: "Remote file system is temporarily unavailable" }), false);
    assert.equal(isTrashUnavailableError(new Error("File system provider does not support Trash")), true);
    assert.equal(isTrashUnavailableError(new Error("EACCES: permission denied, /secret/session.jsonl")), false);
  } finally { vscode.restore(); }
});

test("runtime uses Trash first, wraps only unsupported providers, and exposes an explicit permanent path", async () => {
  const vscode = installVscodeMock();
  try {
    const { PiRuntimeManager, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    const runtime = new PiRuntimeManager({ environmentVariableCollection: { clear() {} } } as any);
    const calls: boolean[] = [];
    (runtime as any).deleteSessionFile = async (useTrash: boolean) => {
      calls.push(useTrash);
      if (useTrash) throw { code: "Unavailable", message: "remote Trash unsupported /long/internal/path" };
    };
    await assert.rejects(runtime.deleteSession(), SessionTrashUnavailableError);
    await runtime.deleteSessionPermanently();
    assert.deepEqual(calls, [true, false]);
    runtime.dispose();
  } finally { vscode.restore(); }
});

test("unsupported Trash keeps the conversation when permanent deletion is cancelled", async () => {
  const vscode = installVscodeMock();
  try {
    const { deleteConversationWithTrashFallback, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    let permanentCalls = 0;
    const outcome = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { throw new SessionTrashUnavailableError(); },
      confirmPermanent: async () => false,
      deletePermanently: async () => { permanentCalls += 1; },
    });
    assert.deepEqual(outcome, { status: "kept" });
    assert.equal(permanentCalls, 0);
  } finally { vscode.restore(); }
});

test("unsupported Trash requires separate confirmation before successful permanent deletion", async () => {
  const vscode = installVscodeMock();
  try {
    const { deleteConversationWithTrashFallback, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    const calls: string[] = [];
    const outcome = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { calls.push("trash"); throw new SessionTrashUnavailableError(); },
      confirmPermanent: async () => { calls.push("confirm"); return true; },
      deletePermanently: async () => { calls.push("permanent"); },
    });
    assert.deepEqual(calls, ["trash", "confirm", "permanent"]);
    assert.deepEqual(outcome, { status: "deleted", permanently: true });
  } finally { vscode.restore(); }
});

test("permanent and ordinary deletion failures preserve explicit failure outcomes", async () => {
  const vscode = installVscodeMock();
  try {
    const { deleteConversationWithTrashFallback, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    const permanentError = new Error("remote permanent failure /long/internal/session/path");
    const permanent = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { throw new SessionTrashUnavailableError(); },
      confirmPermanent: async () => true,
      deletePermanently: async () => { throw permanentError; },
    });
    assert.equal(permanent.status, "failed");
    if (permanent.status === "failed") assert.deepEqual({ error: permanent.error, permanently: permanent.permanently }, { error: permanentError, permanently: true });

    const ordinaryError = new Error("permission denied /long/internal/session/path");
    const ordinary = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { throw ordinaryError; },
      confirmPermanent: async () => { assert.fail("ordinary failures must not offer permanent deletion"); },
      deletePermanently: async () => { assert.fail("ordinary failures must not delete permanently"); },
    });
    assert.equal(ordinary.status, "failed");
    if (ordinary.status === "failed") assert.deepEqual({ error: ordinary.error, permanently: ordinary.permanently }, { error: ordinaryError, permanently: false });
  } finally { vscode.restore(); }
});
