import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
test("captured review Problems documents retain exact sides, replace per scope, bound history and dispose", () => {
  let disposed = false;
  const entries = new Map<string, any[]>();
  vscode.languages.createDiagnosticCollection = () => ({
    set: (uri: any, values: any[]) => entries.set(uri.toString(), values),
    delete: (uri: any) => entries.delete(uri.toString()),
    dispose: () => {
      entries.clear();
      disposed = true;
    },
  });
  const { ReviewFindingStore } = require("../reviewFindings") as typeof import("../reviewFindings");
  const store = new ReviewFindingStore();
  const publish = (root: string, kind = "staged") =>
    store.publish({
      folder: MockUri.file(root),
      sessionId: "s",
      snapshot: {
        repository: { root, gitDir: `${root}/.git`, commonDir: `${root}/.git` },
        revision: { head: null, index: "digest" },
        scope: { kind },
        capturedAt: 1,
        identity: "snapshot",
        diff: "",
        files: [{ path: "renamed.ts", oldPath: "old.ts", before: "old\r\nlast🙂", after: "new\n", status: "R" }],
      },
      result: {
        incomplete: false,
        findings: [
          {
            path: "old.ts",
            side: "before",
            startLine: 1,
            endLine: 2,
            severity: "warning",
            message: "Removed behavior",
          },
          { path: "renamed.ts", side: "after", startLine: 1, endLine: 1, severity: "error", message: "New behavior" },
        ],
      },
    } as any);
  const original = publish("/root");
  const before = store.uri(original, "before", "old.ts");
  const after = store.uri(original, "after", "renamed.ts");
  assert.equal(store.provideTextDocumentContent(before), "old\r\nlast🙂");
  assert.equal(store.provideTextDocumentContent(after), "new\n");
  assert.equal(entries.get(before.toString())?.[0].range.endCharacter, 6);
  assert.equal(entries.get(after.toString())?.[0].severity, 0);
  assert.match(entries.get(before.toString())?.[0].source, /captured Staged/);
  const next = publish("/root");
  assert.equal(store.get(original.id), undefined);
  assert.match(store.provideTextDocumentContent(before), /expired/);
  publish("/root", "unstaged");
  assert.equal(store.latest(true)?.id, next.id);
  for (let index = 0; index < 9; index++) publish(`/root-${index}`);
  assert.equal(store.get(next.id), undefined);
  assert.equal(entries.size, 16);
  store.dispose();
  assert.equal(entries.size, 0);
  assert.equal(disposed, true);
});
