import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { type CaptureRecord, maxCheckpointFile, scanCheckpoint } from "../checkpointCapture";
import { CheckpointCaptureWorker, captureCheckpoint, checkpointCaptureWorker } from "../checkpointCaptureHost";
import { installVscodeMock, MockUri } from "./vscodeMock";

async function workspace(test: (root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-capture-")));
  try {
    await test(root);
  } finally {
    await checkpointCaptureWorker.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("small listing matches byte order and excludes unsupported or linked files", async () => {
  await workspace(async (root) => {
    const names = ["A.txt", "a-2.txt", "z.txt", "é.txt", "日本語.txt", "💡.txt"];
    for (const name of names) await writeFile(path.join(root, name), name);
    await mkdir(path.join(root, "node_modules"));
    await writeFile(path.join(root, "node_modules", "unseen"), "excluded");
    await writeFile(path.join(root, "binary"), Buffer.from([0, 0xff]));
    await link(path.join(root, "z.txt"), path.join(root, "hardlink"));
    if (process.platform !== "win32") await symlink("A.txt", path.join(root, "symlink"));
    const output: CaptureRecord[] = [];
    await captureCheckpoint(root, new Set(), new AbortController().signal, (record) => output.push(record));
    assert.deepEqual(output, [...scanCheckpoint(root, new Set())].filter(Boolean));
    const captured = output.flatMap((record) => ("path" in record ? [record.path] : []));
    assert.deepEqual(
      captured,
      names.filter((name) => name !== "z.txt"),
    );
  });
});

test("real worker preserves the old byte and entry limits across batches", async () => {
  await workspace(async (root) => {
    for (let i = 0; i < 10_002; i++) await writeFile(path.join(root, String(i).padStart(5, "0")), "x");
    const records: CaptureRecord[] = [];
    const capture = () =>
      captureCheckpoint(root, new Set(), new AbortController().signal, (record) => records.push(record));
    await capture();
    assert.equal(records.filter((record) => "path" in record).length, 10_000);
    assert.deepEqual(records.at(-1), { exclusion: "Request-start enumeration limit" });
    records.length = 0;
    for (let i = 0; i < 11; i++)
      await writeFile(path.join(root, String(i).padStart(5, "0")), "x".repeat(maxCheckpointFile));
    await capture();
    assert.equal(records.filter((record) => "path" in record).length, 10);
    assert.deepEqual(records.at(-1), { exclusion: "Request-start capture overflow" });
  });
}, 20_000);

test("worker exit releases active and queued captures without a fallback scan", async () => {
  const worker = new CheckpointCaptureWorker(() => new Worker("process.exit(1)", { eval: true }));
  const signal = new AbortController().signal;
  try {
    const first = worker.capture("unused", new Set(), signal, () => assert.fail("must not emit"));
    const second = worker.capture("unused", new Set(), signal, () => assert.fail("must not emit"));
    await Promise.all([assert.rejects(first, /worker stopped/), assert.rejects(second, /worker stopped/)]);
  } finally {
    await worker.close();
  }
});

test("a cancelled worker capture discards later batches and admits the next job", async () => {
  await workspace(async (root) => {
    for (let i = 0; i < 620; i++) await writeFile(path.join(root, `${i}.txt`), "x");
    const stop = new AbortController();
    const worker = new CheckpointCaptureWorker();
    let firstRecords = 0;
    let secondRecords = 0;
    try {
      const first = worker.capture(root, new Set(), stop.signal, () => {
        firstRecords++;
        stop.abort();
      });
      const second = worker.capture(root, new Set(), new AbortController().signal, () => secondRecords++);
      await assert.rejects(first, /cancelled/);
      await second;
      assert.ok(firstRecords <= 512);
      assert.equal(secondRecords, 621);
    } finally {
      await worker.close();
    }
  });
});

test("editor changes between capture and commit exclude that file without losing unrelated coverage", async () => {
  const mock = installVscodeMock();
  const { WorkspaceChangeTracker } = require("../changeTracker") as typeof import("../changeTracker");
  try {
    await workspace(async (root) => {
      const tracker = new WorkspaceChangeTracker();
      try {
        for (const name of ["edited", "unaffected"]) await writeFile(path.join(root, name), "before");
        const prepared = await tracker.prepareRequest(root, "fixture", new AbortController().signal);
        mock.workspace.emitTextDocumentChange({
          document: { uri: MockUri.file(path.join(root, "edited")), isDirty: true },
          contentChanges: [{}],
        });
        prepared.commit(false);
        for (const name of ["edited", "unaffected"]) {
          tracker.captureToolEvent({
            type: "tool_execution_start",
            toolName: "write",
            args: { path: name, content: "after" },
          });
          await writeFile(path.join(root, name), "after");
        }
        assert.deepEqual(
          (await tracker.finishRequest())?.map((change) => change.label),
          ["unaffected"],
        );
      } finally {
        tracker.dispose();
      }
    });
  } finally {
    mock.restore();
  }
});
