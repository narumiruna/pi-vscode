/** Native Extension Host fixture checks. No live provider, store, browser, or upload. */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as vscode from "vscode";
import { runIsolatedPi } from "../isolatedPi";
import { assertTransferWorkspace, validateSessionJsonl, writeTransferFile } from "../sessionTransfer";

export async function verifyNativeAuthTransfer(): Promise<void> {
  const commands = await vscode.commands.getCommands(true);
  for (const id of [
    "pi.signInProvider",
    "pi.signOutProvider",
    "pi.importSession",
    "pi.exportSession",
    "pi.shareSession",
  ])
    assert.ok(commands.includes(id), `Missing native command ${id}`);
  const directory = await mkdtemp(path.join(tmpdir(), "pi-native-transfer-"));
  try {
    const invocation = {
      executablePath: path.resolve(__dirname, "../../scripts/fixtures/native-pi.cjs"),
      cwd: directory,
    };
    const helperPath = path.resolve(__dirname, "../../resources/pi-isolated-helper.ts");
    const catalog = await runIsolatedPi(invocation, helperPath, {
      operation: "discover",
      agentDir: path.join(directory, "unused-store"),
    });
    assert.deepEqual(catalog.providers, [{ id: "fixture", methods: ["api_key", "oauth"] }]);
    const result = await runIsolatedPi(
      invocation,
      helperPath,
      {
        operation: "login",
        agentDir: path.join(directory, "unused-store"),
        provider: "fixture",
        method: "api_key",
      },
      {
        prompt: async (prompt) => {
          assert.equal(prompt.kind, "secret");
          const input = vscode.window.createInputBox();
          try {
            input.password = true;
            input.value = "native-fixture-secret";
            assert.equal(input.password, true);
            return input.value;
          } finally {
            input.dispose();
          }
        },
        openUrl: async () => {
          throw new Error("This fixture must not open a browser.");
        },
      },
    );
    assert.equal(result.status, "changed");
    const bytes = Buffer.from(
      `${JSON.stringify({ type: "session", version: 3, id: "native-transfer", cwd: directory, timestamp: "2026-01-01T00:00:00.000Z" })}\n`,
    );
    const destination = path.join(directory, "copy.jsonl");
    await writeTransferFile(destination, bytes);
    await assertTransferWorkspace(validateSessionJsonl(await readFile(destination)), directory);
    await assert.rejects(writeTransferFile(destination, Buffer.from("do not overwrite")), /EEXIST/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
