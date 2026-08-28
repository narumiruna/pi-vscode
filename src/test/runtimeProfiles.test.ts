import assert from "node:assert/strict";
import test from "node:test";
import { getRuntimeProfile, normalizeMode } from "../runtimeProfiles";

test("Ask and Plan profiles are file-system read-only and include the VS Code bridge", () => {
  for (const mode of ["ask", "plan"] as const) {
    const tools = getRuntimeProfile(mode).tools;
    assert.deepEqual(tools, [
      "read",
      "grep",
      "find",
      "ls",
      "vscode_context",
      "vscode_open_file",
      "vscode_notify",
    ]);
    assert.equal(tools.includes("bash"), false);
    assert.equal(tools.includes("edit"), false);
    assert.equal(tools.includes("write"), false);
  }
});

test("Edit excludes shell execution and Agent enables the complete coding toolset", () => {
  assert.equal(getRuntimeProfile("edit").tools.includes("bash"), false);
  assert.deepEqual(getRuntimeProfile("agent").tools, [
    "read",
    "bash",
    "edit",
    "write",
    "grep",
    "find",
    "ls",
    "vscode_context",
    "vscode_open_file",
    "vscode_notify",
  ]);
});

test("normalizeMode falls back to Ask for invalid persisted values", () => {
  assert.equal(normalizeMode("agent"), "agent");
  assert.equal(normalizeMode("unexpected"), "ask");
});
