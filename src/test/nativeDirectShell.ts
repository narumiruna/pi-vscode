import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { PiRpcClient } from "../piRpcClient";
import { PiRuntimeManager } from "../piRuntime";

/** Isolated Extension Host checks. No model, real Pi profile, or arbitrary command. */
export async function verifyNativeDirectShell(): Promise<string> {
  if (!vscode.workspace.isTrusted) {
    const runtime = new PiRuntimeManager({
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../..")),
      workspaceState: { get: () => undefined, update: async () => {} },
      environmentVariableCollection: { clear() {} },
    } as unknown as vscode.ExtensionContext);
    try {
      await assert.rejects(runtime.executeBash("fixture:hello", false), /trusted/);
      return "Restricted Mode rejects shell before process launch";
    } finally {
      runtime.dispose();
    }
  }
  const root = await mkdtemp(path.join(tmpdir(), "pi-native-shell-"));
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: [path.resolve(__dirname, "../../scripts/fixtures/direct-shell.cjs")],
    cwd: root,
    env: { ELECTRON_RUN_AS_NODE: "1" },
  });
  try {
    await client.start();
    const output: string[] = [];
    const result = await client.bash("fixture:hello", false, (update) => output.push(update.output));
    assert.equal(result.output, "hello\n");
    assert.equal(result.exitCode, 7);
    assert.ok(output.every((value) => !value.includes("DO_NOT_RENDER")));
    await client.bash("fixture:hello", true, () => {});
    assert.equal((await client.getMessages()).length, 2);
    return "fixture-only subprocess, correlated/final output, exit code and retained excluded history";
  } finally {
    await client.stop();
    await rm(root, { recursive: true, force: true });
  }
}
