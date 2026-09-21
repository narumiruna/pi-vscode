import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import { diagnosticDiskText } from "../diagnosticEncoding";
import { readWorkspaceFile } from "../workspaceFiles";
import { diagnosticEncodingFixtures, unsupportedDiagnosticEncodings } from "./diagnosticEncodingFixtures";

/** Real editor decoding/configuration versus the diagnostic verifier in a disposable workspace. */
export async function verifyDiagnosticEncodings(root: vscode.Uri): Promise<number> {
  const canonicalRoot = await realpath(root.fsPath);
  const configuration = vscode.workspace.getConfiguration("files", root);
  const originalEncoding = configuration.inspect<string>("encoding")?.workspaceValue;
  try {
    for (const { encoding, hex, text } of diagnosticEncodingFixtures) {
      await configuration.update("encoding", encoding, vscode.ConfigurationTarget.Workspace);
      const name = `diagnostic-${encoding}.txt`;
      const uri = vscode.Uri.joinPath(root, name);
      await writeFile(uri.fsPath, Buffer.from(hex, "hex"));
      const configured = vscode.workspace.getConfiguration("files", uri).get<string>("encoding", "utf8");
      assert.equal(configured, encoding);
      const document = await vscode.workspace.openTextDocument(uri);
      assert.equal(document.isDirty, false, encoding);
      assert.equal(document.getText(), text, `VS Code decoded ${encoding}`);
      const bytes = await readWorkspaceFile(canonicalRoot, name, 400_003);
      assert.ok(bytes);
      assert.equal(
        diagnosticDiskText(bytes, configured, document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n"),
        document.getText(),
        `Safely captured ${encoding} matches the native editor`,
      );
    }
    for (const encoding of unsupportedDiagnosticEncodings) {
      assert.throws(() => diagnosticDiskText(Buffer.from("unchanged\n"), encoding, "\n"), /Cannot verify/);
    }
    return diagnosticEncodingFixtures.length;
  } finally {
    await configuration.update("encoding", originalEncoding, vscode.ConfigurationTarget.Workspace);
  }
}
