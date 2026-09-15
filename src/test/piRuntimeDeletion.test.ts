import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installVscodeMock } from "./vscodeMock";

test("Trash classification is narrow and permanent deletion stays bound to the original session", async () => {
  const vscode = installVscodeMock();
  const root = mkdtempSync(path.join(os.tmpdir(), "picode-delete-target-"));
  try {
    const { isTrashUnavailableError, PiRuntimeManager, runtimeSessionIdentityChanged } = require("../piRuntime") as typeof import("../piRuntime");
    const originalIdentity = { sessionFile: "/sessions/original.jsonl", sessionId: "original" };
    assert.equal(runtimeSessionIdentityChanged(originalIdentity, originalIdentity), false);
    assert.equal(runtimeSessionIdentityChanged(originalIdentity, { sessionFile: "/sessions/replacement.jsonl", sessionId: "replacement" }), true);
    assert.equal(runtimeSessionIdentityChanged(originalIdentity, { sessionFile: "/sessions/original.jsonl", sessionId: "replacement" }), true);
    assert.equal(runtimeSessionIdentityChanged(originalIdentity, {}), false, "a failed restart is not evidence of a replacement session");
    assert.equal(isTrashUnavailableError({ code: "Unavailable", message: "Trash unavailable for /remote/session.jsonl" }), true);
    assert.equal(isTrashUnavailableError({ code: "Unavailable", message: "Remote file system is temporarily unavailable" }), false);
    assert.equal(isTrashUnavailableError(new Error("File system provider does not support Trash")), true);
    assert.equal(isTrashUnavailableError(new Error("EACCES: permission denied, /secret/session.jsonl")), false);

    const original = path.join(root, "original.jsonl");
    writeFileSync(original, `${JSON.stringify({ type: "session", cwd: process.cwd() })}\n`);
    const deletes: Array<{ path: string; useTrash: boolean }> = [];
    vscode.workspace.fs = { delete: async (uri: { fsPath: string }, options: { useTrash: boolean }) => { deletes.push({ path: uri.fsPath, useTrash: options.useTrash }); rmSync(uri.fsPath); } };
    const runtime = new PiRuntimeManager({ environmentVariableCollection: { clear() {} } } as any);
    (runtime as any).state = { connected: true, busy: false, sessionFile: path.join(root, "replacement.jsonl"), availableModels: [], availableThinkingLevels: [], commands: [] };
    await runtime.deleteSessionPermanently(original);
    assert.deepEqual(deletes, [{ path: original, useTrash: false }]);
    assert.equal(runtime.currentState.sessionFile, path.join(root, "replacement.jsonl"));
    runtime.dispose();
  } finally { rmSync(root, { recursive: true, force: true }); vscode.restore(); }
});

test("runtime binds permanent deletion to the original Trash-unavailable session", async () => {
  const vscode = installVscodeMock();
  try {
    const { PiRuntimeManager, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    const runtime = new PiRuntimeManager({ environmentVariableCollection: { clear() {} } } as any);
    const calls: Array<{ useTrash: boolean; sessionFile?: string }> = [];
    (runtime as any).deleteSessionFile = async (useTrash: boolean) => {
      calls.push({ useTrash });
      throw new SessionTrashUnavailableError("/original/session.jsonl", { cause: { code: "Unavailable", message: "remote Trash unsupported /long/internal/path" } });
    };
    (runtime as any).deleteSessionPermanently = async (sessionFile: string) => { calls.push({ useTrash: false, sessionFile }); };
    const error = await runtime.deleteSession().then(() => undefined, value => value);
    assert.ok(error instanceof SessionTrashUnavailableError);
    await runtime.deleteSessionPermanently(error.sessionFile);
    assert.deepEqual(calls, [{ useTrash: true }, { useTrash: false, sessionFile: "/original/session.jsonl" }]);
    runtime.dispose();
  } finally { vscode.restore(); }
});

test("unsupported Trash keeps the conversation when permanent deletion is cancelled", async () => {
  const vscode = installVscodeMock();
  try {
    const { deleteConversationWithTrashFallback, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    let permanentCalls = 0;
    const outcome = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { throw new SessionTrashUnavailableError("/original/session.jsonl"); },
      confirmPermanent: async error => { assert.equal(error.sessionFile, "/original/session.jsonl"); return false; },
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
      moveToTrash: async () => { calls.push("trash"); throw new SessionTrashUnavailableError("/original/session.jsonl"); },
      confirmPermanent: async error => { calls.push(`confirm:${error.sessionFile}`); return true; },
      deletePermanently: async error => { calls.push(`permanent:${error.sessionFile}`); },
    });
    assert.deepEqual(calls, ["trash", "confirm:/original/session.jsonl", "permanent:/original/session.jsonl"]);
    assert.deepEqual(outcome, { status: "deleted", permanently: true });
  } finally { vscode.restore(); }
});

test("permanent and ordinary deletion failures preserve explicit failure outcomes", async () => {
  const vscode = installVscodeMock();
  try {
    const { deleteConversationWithTrashFallback, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    const permanentError = new Error("remote permanent failure /long/internal/session/path");
    const permanent = await deleteConversationWithTrashFallback({
      moveToTrash: async () => { throw new SessionTrashUnavailableError("/original/session.jsonl"); },
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
