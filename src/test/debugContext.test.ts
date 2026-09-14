import assert from "node:assert/strict";
import { captureDebug, DebugPauseTracker, supportedDebugAdapter } from "../debugContext";

test("debug capture uses only bounded stack/scopes/local variables, omitting lazy and environment containers", async () => {
  const tracker = new DebugPauseTracker(); tracker.observe("s", { type: "event", event: "stopped" });
  const generation = tracker.token("s");
  const calls: string[] = [];
  const snapshot = await captureDebug({ sessionId: "s", frameId: 1, threadId: 1, assertCurrent: () => tracker.assert("s", generation), request: async command => {
    calls.push(command);
    if (command === "stackTrace") return { stackFrames: Array.from({ length: 100 }, (_, index) => ({ id: index + 1, name: "frame", line: 1, source: { path: "/repo/a.js" } })), totalFrames: 100 };
    if (command === "scopes") return { scopes: [{ name: "Local", variablesReference: 1, expensive: false }] };
    return { variables: [{ name: "lazy", value: "unsafe", presentationHint: { lazy: true } }, { name: "env", value: "secret" }, ...Array.from({ length: 100 }, (_, index) => ({ name: `v${index}`, value: "x".repeat(3000), variablesReference: 1 }))] };
  } });
  assert.deepEqual(calls, ["stackTrace", "scopes", "variables"]);
  assert.ok(snapshot.frames.length <= 20); assert.ok(snapshot.variables.length <= 50);
  assert.ok(snapshot.variables.every(variable => variable.value.length <= 1000 && variable.name !== "lazy" && variable.name !== "env"));
  assert.ok(JSON.stringify(snapshot).length <= 20_000);
  assert.equal(supportedDebugAdapter("pwa-node"), true); assert.equal(supportedDebugAdapter("unknown"), false);
});

test("debug responses become invalid after continue/step/termination or changed frame; timeout and malformed responses fail", async () => {
  const tracker = new DebugPauseTracker();
  assert.throws(() => tracker.token("s"), /not.*paused/);
  for (const message of [{ type: "event", event: "continued" }, { type: "request", command: "next" }, { type: "request", command: "restart" }, { type: "event", event: "terminated" }]) {
    tracker.change("s", true); const generation = tracker.token("s");
    await assert.rejects(captureDebug({ sessionId: "s", frameId: 1, threadId: 1, assertCurrent: () => tracker.assert("s", generation), request: async () => { tracker.observe("s", message); return { stackFrames: [] }; } }), /paused|changed/);
  }
  const options = { sessionId: "s", frameId: 1, threadId: 1, assertCurrent: () => {} };
  await assert.rejects(captureDebug({ ...options, request: async () => new Promise(() => {}), timeoutMs: 10 }), /deadline/);
  await assert.rejects(captureDebug({ ...options, request: async () => ({ stackFrames: [{ id: 1, name: {}, line: -1 }] }) }), /Malformed/);
  const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
  await assert.rejects(captureDebug({ ...options, request: async () => cyclic }), /unavailable/);
});
