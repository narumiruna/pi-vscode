import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { PiRpcClient } from "../piRpcClient";
import { PiRuntimeManager } from "../piRuntime";
import { listRecentPiSessions } from "../sessionHistory";

/** Native host registration/trust and realistic saved JSONL through fixture RPC only. */
export async function verifyNativeSessionSwitch(root: vscode.Uri): Promise<string> {
  await vscode.extensions.getExtension("narumi.narumi-pi")?.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of ["pi.switchSession", "pi.previousSession", "pi.nextSession"]) {
    assert.ok(commands.includes(command), `Missing native session command ${command}`);
  }
  if (!vscode.workspace.isTrusted) {
    const runtime = new PiRuntimeManager({
      extensionUri: vscode.Uri.file(path.resolve(__dirname, "../..")),
      workspaceState: { get: () => undefined, update: async () => {} },
      environmentVariableCollection: { clear() {} },
    } as unknown as vscode.ExtensionContext);
    try {
      for (const command of ["pi.switchSession", "pi.previousSession", "pi.nextSession"]) {
        await assert.rejects(Promise.resolve(vscode.commands.executeCommand(command)), /trusted/);
      }
      await assert.rejects(runtime.switchSession(vscode.Uri.joinPath(root, "saved-session.jsonl").fsPath), /trusted/);
      assert.equal(runtime.currentState.connected, false);
      assert.equal(runtime.currentState.sessionId, undefined);
      return "three command registrations; all handlers and runtime reject Restricted Mode before process launch";
    } finally {
      runtime.dispose();
    }
  }
  const directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-native-session-switch-")));
  const cwd = await realpath(root.fsPath);
  const files = [
    path.join(directory, "a.jsonl"),
    path.join(directory, "b.jsonl"),
    path.join(directory, "c.jsonl"),
  ] as const;
  const client = new PiRpcClient({
    executablePath: process.execPath,
    executableArgs: [path.resolve(__dirname, "../../scripts/fixtures/native-pi.cjs"), "--session", files[0]],
    cwd,
    env: { ELECTRON_RUN_AS_NODE: "1", PI_VSCODE_UI_FIXTURE: directory },
  });
  try {
    for (const [index, file] of files.entries()) {
      const stamp = "2026-10-22T00:00:00.000Z";
      const entries = [
        { type: "session", version: 3, id: `native-switch-${index}`, cwd, timestamp: stamp },
        {
          type: "message",
          id: `message-${index}`,
          parentId: null,
          timestamp: stamp,
          message: { role: "user", content: [{ type: "text", text: `Saved session ${index}` }], timestamp: 1 },
        },
      ];
      await writeFile(file, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    }
    const summaries = await listRecentPiSessions(files[0], cwd);
    assert.ok(summaries);
    assert.equal(summaries.length, 3);
    assert.deepEqual(new Set(summaries.map((session) => session.path)), new Set(files));
    await client.start();
    for (const index of [1, 2, 0] as const) {
      assert.deepEqual(await client.switchSession(files[index]), { cancelled: false });
      const state = await client.getState();
      assert.equal(state.sessionFile, files[index]);
      assert.equal(state.sessionId, `native-switch-${index}`);
      assert.deepEqual(await client.getMessages(), [
        { role: "user", content: [{ type: "text", text: `Saved session ${index}` }], timestamp: 1 },
      ]);
    }
    const dispatched = (await readFile(path.join(directory, "switches.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sessionId: string });
    assert.deepEqual(
      dispatched.map((item) => item.sessionId),
      ["native-switch-1", "native-switch-2", "native-switch-0"],
    );
    return "three registrations; three saved same-cwd sessions discovered; switch_session/get_state/get_messages verified";
  } finally {
    await client.stop();
    await rm(directory, { recursive: true, force: true });
  }
}
