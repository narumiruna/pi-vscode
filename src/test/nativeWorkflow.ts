/** Noninteractive Extension Host smoke entry. Run with @vscode/test-electron, not Vitest. */
import assert from "node:assert/strict";
import { realpath, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import * as vscode from "vscode";
import { addMultiFileEditProposal, registerEditPreviewProvider } from "../editProposalController";
import { EditProposalStore } from "../editProposals";
import { captureGitReview } from "../gitSnapshots";
import { ReviewFindingStore } from "../reviewFindings";
import type { CodeContextResult } from "../semanticContext";
import { queryCodeContext } from "../semanticContext";
import { VscodeBridgeServer } from "../vscodeBridge";
import { vscodeBridgePortEnvironmentKey, vscodeBridgeTokenEnvironmentKey } from "../vscodeBridgeProtocol";

export async function run(): Promise<void> {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root, "Smoke fixture workspace is required");
  if (process.env.PICODE_NATIVE_EXPECT_TRUST !== undefined)
    assert.equal(
      String(vscode.workspace.isTrusted),
      process.env.PICODE_NATIVE_EXPECT_TRUST,
      "Native trust state must match the requested test launch",
    );
  const uri = vscode.Uri.joinPath(root, "source.ts");
  const source = await vscode.workspace.openTextDocument(uri);
  if (!vscode.workspace.isTrusted) {
    await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(1, 0)), /trusted/);
    await evidence({ version: vscode.version, trusted: false, trustGuard: "passed" });
    return;
  }
  await vscode.extensions.getExtension("vscode.typescript-language-features")?.activate();
  await vscode.window.showTextDocument(source);
  let definitions: CodeContextResult | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    definitions = await queryCodeContext("definition", uri, new vscode.Position(1, 0));
    if (definitions.items.length) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(definitions?.items.length, "TypeScript definitions unavailable");
  for (const operation of ["references", "documentSymbols", "callers", "callees"] as const) {
    const result = await queryCodeContext(operation, uri, new vscode.Position(0, 17));
    assert.equal(result.operation, operation);
  }
  const bridge = new VscodeBridgeServer();
  try {
    const environment = await bridge.start();
    const response = await new Promise<{ ok: boolean; result: CodeContextResult }>((resolve, reject) => {
      const socket = net.createConnection({
        host: "127.0.0.1",
        port: Number(environment[vscodeBridgePortEnvironmentKey]),
      });
      let text = "";
      socket.setTimeout(10_000, () => socket.destroy(new Error("Native bridge timed out")));
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(
          `${JSON.stringify({ id: "native", token: environment[vscodeBridgeTokenEnvironmentKey], method: "codeContext", params: { operation: "definition", path: uri.fsPath, line: 2, column: 1 } })}\n`,
        ),
      );
      socket.on("data", (chunk) => {
        text += chunk.toString();
      });
      socket.on("end", () => {
        try {
          resolve(JSON.parse(text));
        } catch (error) {
          reject(error);
        }
      });
    });
    assert.equal(response.ok, true);
    assert.ok(response.result.items.length);
    assert.ok(!JSON.stringify(response.result).includes("return 1"), "Bridge metadata must not contain source text");
  } finally {
    bridge.dispose();
  }
  const cancelled = new vscode.CancellationTokenSource();
  cancelled.cancel();
  await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(1, 0), cancelled.token), /cancelled/);
  cancelled.dispose();
  const staged = await captureGitReview(root.fsPath, { kind: "staged" });
  assert.ok(staged.files.length);
  for (const kind of ["unstaged", "workingTree"] as const) await captureGitReview(root.fsPath, { kind });
  await captureGitReview(root.fsPath, { kind: "branch", baseRef: "refs/heads/base" });
  const store = new ReviewFindingStore();
  const file = staged.files.find((file) => file.after?.length)!;
  const record = store.publish({
    snapshot: staged,
    folder: root,
    result: {
      incomplete: false,
      findings: [
        {
          path: file.path,
          side: "after",
          startLine: 1,
          endLine: 1,
          severity: "warning",
          message: "Native captured finding",
        },
      ],
    },
  });
  const capturedUri = store.uri(record, "after", file.path);
  assert.equal((await vscode.workspace.openTextDocument(capturedUri)).getText(), file.after);
  assert.equal(vscode.languages.getDiagnostics(capturedUri).length, 1);
  await vscode.commands.executeCommand("workbench.actions.view.problems");
  await vscode.window.showTextDocument(capturedUri);
  store.dispose();
  assert.equal(vscode.languages.getDiagnostics(capturedUri).length, 0);

  const context = { subscriptions: [] } as unknown as vscode.ExtensionContext;
  const previews = registerEditPreviewProvider(context);
  const other = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, "other.ts"));
  const originals = [source.getText(), other.getText()];
  const proposals = new EditProposalStore(
    () => {},
    (message) => console.log(message),
  );
  const proposalId = addMultiFileEditProposal(
    previews,
    {
      sendRequest: async () => "",
      addEditProposal: (input) => proposals.add(input),
    },
    {
      root: await realpath(root.fsPath),
      files: [source, other].map((document, index) => ({
        path: index === 0 ? "source.ts" : "other.ts",
        document,
        version: document.version,
        original: originals[index]!,
        replacement: `// reviewed\n${originals[index]}`,
      })),
    },
  );
  await proposals.handleLockedAction(proposalId, "preview", await realpath(root.fsPath));
  await proposals.handleLockedAction(proposalId, "apply", await realpath(root.fsPath));
  assert.equal(proposals.states[0]?.status, "applied");
  assert.equal(source.getText(), `// reviewed\n${originals[0]}`);
  assert.equal(other.getText(), `// reviewed\n${originals[1]}`);
  await vscode.window.showTextDocument(other);
  await vscode.commands.executeCommand("undo");
  assert.equal(source.getText(), originals[0]);
  assert.equal(other.getText(), originals[1]);
  proposals.clear();
  for (const item of context.subscriptions) item.dispose();
  await evidence({
    version: vscode.version,
    trusted: true,
    semanticProviders: "passed",
    bridgeCodeContext: "passed",
    cancellation: "passed",
    platform: process.platform,
    remoteName: vscode.env.remoteName ?? null,
    gitScopes: "passed",
    capturedDiagnostics: "passed",
    nativeDiffAndWorkspaceEdit: "passed",
    nativeUndo: "passed",
  });
}

async function evidence(value: unknown): Promise<void> {
  const destination = process.env.PICODE_NATIVE_EVIDENCE;
  if (destination && path.isAbsolute(destination)) await writeFile(destination, JSON.stringify(value, undefined, 2));
  console.log("PI_NATIVE_EVIDENCE", JSON.stringify(value));
}
