import assert from "node:assert/strict";
import {
  type DiagnosticRepairSnapshot,
  diagnosticIdentity,
  parseDiagnosticReplacements,
  serializeDiagnosticRepair,
} from "../workspaceDiagnostics";

const diagnostic = {
  severity: 0,
  message: "Wrong value",
  source: "ts",
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
};
const snapshot: DiagnosticRepairSnapshot = {
  files: [
    { path: "a.ts", version: 1, content: "a\n" },
    { path: "b.ts", version: 2, content: "b\n" },
  ],
  diagnostics: [{ ...diagnostic, path: "a.ts", id: diagnosticIdentity("a.ts", diagnostic) }],
};

test("diagnostic snapshots have deterministic identities and bounded path/file/count payloads", () => {
  assert.equal(diagnosticIdentity("a.ts", diagnostic), diagnosticIdentity("a.ts", { ...diagnostic }));
  assert.notEqual(diagnosticIdentity("b.ts", diagnostic), diagnosticIdentity("a.ts", diagnostic));
  assert.deepEqual(JSON.parse(serializeDiagnosticRepair(snapshot)), snapshot);
  for (const invalid of [
    { ...snapshot, files: [] },
    { ...snapshot, files: [...snapshot.files, snapshot.files[0]!] },
    { ...snapshot, files: [{ ...snapshot.files[0]!, content: "x".repeat(100_001) }] },
    { ...snapshot, files: [{ ...snapshot.files[0]!, path: "../a" }] },
    { ...snapshot, diagnostics: [] },
    { ...snapshot, diagnostics: Array(101).fill(snapshot.diagnostics[0]) },
    { ...snapshot, files: Array.from({ length: 21 }, (_, index) => ({ path: `f${index}`, version: 1, content: "x" })) },
  ])
    assert.throws(() => serializeDiagnosticRepair(invalid));
  assert.doesNotThrow(() =>
    serializeDiagnosticRepair({ ...snapshot, files: [{ ...snapshot.files[0]!, content: "x".repeat(100_000) }] }),
  );
});

test("diagnostic snapshot accepts exact count/file/aggregate bounds and rejects one extra character", () => {
  const files = Array.from({ length: 20 }, (_, index) => ({
    path: index ? `f${index}.ts` : "a.ts",
    version: 1,
    content: "",
  }));
  const diagnostics = Array.from({ length: 100 }, (_, index) => ({ ...snapshot.diagnostics[0]!, id: String(index) }));
  assert.doesNotThrow(() => serializeDiagnosticRepair({ files, diagnostics }));
  const bounded = { files: files.slice(0, 4), diagnostics: snapshot.diagnostics };
  for (const file of bounded.files.slice(0, 3)) file.content = "x".repeat(100_000);
  bounded.files[3]!.content = "x".repeat(400_000 - JSON.stringify(bounded).length);
  assert.equal(serializeDiagnosticRepair(bounded).length, 400_000);
  bounded.files[3]!.content += "x";
  assert.throws(() => serializeDiagnosticRepair(bounded), /400,000/);
});

test("multi-file replacements accept selected partial files but reject invented/duplicate/deletion/oversized/unchanged responses", () => {
  assert.deepEqual(parseDiagnosticReplacements('{"files":[{"path":"b.ts","content":"B"}]}', snapshot), [
    { path: "b.ts", content: "B" },
  ]);
  for (const value of [
    "invalid",
    "{}",
    '{"files":[]}',
    JSON.stringify({ files: [{ path: "a.ts", content: "a\n" }] }),
    JSON.stringify({ files: [{ path: "unknown", content: "x" }] }),
    JSON.stringify({
      files: [
        { path: "a.ts", content: "A" },
        { path: "a.ts", content: "A" },
      ],
    }),
    JSON.stringify({ files: [{ path: "a.ts", delete: true }] }),
    JSON.stringify({ files: [{ path: "a.ts", content: "x".repeat(100_001) }] }),
    JSON.stringify({ files: [{ path: "a.ts", content: "A", rename: "b" }] }),
    JSON.stringify({ files: [{ content: "missing path" }] }),
    JSON.stringify({ files: [{ path: "a.ts", content: "binary\u0000data" }] }),
    "x".repeat(400_001),
  ])
    assert.throws(() => parseDiagnosticReplacements(value, snapshot));
});
