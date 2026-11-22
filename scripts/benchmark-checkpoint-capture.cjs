// Usage after npm run compile: node scripts/benchmark-checkpoint-capture.cjs <baseline commit>.
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Module = require("node:module");
const { setTimeout: wait } = require("node:timers/promises");
const { transformSync } = require("esbuild");
const repository = path.resolve(__dirname, "..");
const commit = process.argv[2];
assert.match(commit ?? "", /^[a-f0-9]{7,40}$/);
const samplesPerCell = 24;
const fromRepo = (name) => require(path.join(repository, "out", name));
const mock = fromRepo("test/vscodeMock.js").installVscodeMock();
const { WorkspaceChangeTracker } = fromRepo("changeTracker.js");
const { PiRpcClient } = fromRepo("piRpcClient.js");
const { checkpointCaptureWorker } = fromRepo("checkpointCaptureHost.js");
const baselineModule = new Module(path.join(repository, "out", "changeTracker-baseline.js"), module);
baselineModule.filename = baselineModule.id;
const baselineSource = execFileSync("git", ["show", `${commit}:src/changeTracker.ts`], { cwd: repository, encoding: "utf8" });
baselineModule._compile(transformSync(baselineSource, {
  loader: "ts", format: "cjs", target: "es2022",
}).code, baselineModule.filename);
const { WorkspaceChangeTracker: Baseline } = baselineModule.exports;

async function measure(client, capture) {
  let largestDelay = 0;
  let tick = false;
  let previousTick = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    largestDelay = Math.max(largestDelay, now - previousTick);
    previousTick = now;
    tick = true;
  }, 1);
  const start = performance.now();
  let dispatch;
  const originalWrite = client.writeRecord;
  client.writeRecord = function (record) {
    originalWrite.call(this, record);
    if (record.type === "prompt") dispatch = performance.now();
  };
  try {
    const captured = await capture();
    const finished = performance.now();
    clearInterval(timer);
    const settled = new Promise((resolve) => {
      const subscription = client.onEvent((event) => {
        if (event.type === "agent_settled") { subscription.dispose(); resolve(); }
      });
    });
    await client.prompt("Offline checkpoint feasibility sample.");
    await settled;
    assert.ok(dispatch);
    // Count the tail of a non-yielding capture even if the probe has not fired yet.
    if (!tick || previousTick < finished) largestDelay = Math.max(largestDelay, finished - previousTick);
    return { captured, captureMs: finished - start, timerMs: largestDelay, dispatchMs: dispatch - start };
  } finally {
    client.writeRecord = originalWrite;
    clearInterval(timer);
  }
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];
const summary = (rows) => Object.fromEntries(["timerMs", "captureMs", "dispatchMs"].map((key) => {
  const values = rows.map((item) => item[key]);
  return [key, { median: percentile(values, 0.5), p95: percentile(values, 0.95) }];
}));
const fields = ({ files, exclusions, expectedBytes }) => ({ files: [...files], exclusions, expectedBytes });

(async () => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-worker-feasibility-")));
  const fixture = path.join(base, "fixture");
  let client;
  const original = new Baseline();
  const tracker = new WorkspaceChangeTracker();
  const candidate = async (root) => {
    const checkpoint = await tracker.prepareRequest(root, "fixture", new AbortController().signal);
    checkpoint.commit(false);
    return tracker.current;
  };
  try {
    await fs.mkdir(fixture);
    await fs.writeFile(path.join(fixture, "response.txt"), "Offline response.");
    const results = [];
    for (const [dirs, perDir] of [[5, 20], [20, 490]]) {
      const files = dirs * perDir;
      const root = path.join(base, `workspace-${files}`);
      await fs.mkdir(root);
      const content = "export const value = 42;\n".repeat(40);
      await Promise.all(Array.from({ length: dirs }, async (_, n) => {
        const dir = path.join(root, `dir-${n}`);
        await fs.mkdir(dir);
        for (let i = 0; i < perDir; ++i) await fs.writeFile(path.join(dir, `${i}.ts`), content);
      }));
      client = new PiRpcClient({
        executablePath: process.execPath,
        executableArgs: [path.join(repository, "scripts/fixtures/native-pi.cjs")],
        cwd: root,
        env: { PI_VSCODE_UI_FIXTURE: fixture },
      });
      await client.start();
      await client.getState();
      const baseline = () => {
        original.startRequest(root, "fixture");
        return original.current;
      };
      const cells = {};
      for (const mode of ["cold", "warm"]) {
        if (mode === "warm") await candidate(root);
        const sampleBaseline = () => measure(client, baseline);
        const sampleWorker = async () => {
          try {
            return await measure(client, () => candidate(root));
          } finally {
            if (mode === "cold") await checkpointCaptureWorker.close();
          }
        };
        const rows = { baseline: [], worker: [] };
        for (let i = -2; i < samplesPerCell; ++i) {
          const oldFirst = i % 2 === 0;
          const first = await (oldFirst ? sampleBaseline() : sampleWorker());
          const second = await (oldFirst ? sampleWorker() : sampleBaseline());
          const [old, worker] = oldFirst ? [first, second] : [second, first];
          assert.equal(old.captured.files.size, files);
          assert.deepEqual(fields(worker.captured), fields(old.captured));
          if (i >= 0) {
            const { captured: _old, ...oldTimes } = old;
            const { captured: _worker, ...workerTimes } = worker;
            rows.baseline.push(oldTimes);
            rows.worker.push(workerTimes);
          }
          await wait(3);
        }
        const old = summary(rows.baseline);
        const worker = summary(rows.worker);
        const maxDispatchRegression = Math.max(15, old.dispatchMs.median * 0.1);
        const dispatchRegression = worker.dispatchMs.median - old.dispatchMs.median;
        cells[mode] = { baseline: old, worker, maxDispatchRegression, dispatchRegression,
          dispatchPass: dispatchRegression <= maxDispatchRegression,
          timerP95Reduction: 1 - worker.timerMs.p95 / old.timerMs.p95,
        };
        await checkpointCaptureWorker.close();
      }
      const lines = (await fs.readFile(path.join(fixture, "prompts.jsonl"), "utf8")).trim().split("\n");
      assert.equal(lines.length, (samplesPerCell + 2) * 4 * (results.length + 1));
      results.push({ files, cells });
      await client.stop();
      client = undefined;
    }
    const pass = results.every(({ cells }) => cells.cold.dispatchPass && cells.warm.dispatchPass)
      && results[1].cells.warm.timerP95Reduction >= 0.5;
    console.log(JSON.stringify({ node: process.version, samplesPerCell, results, pass }, null, 2));
    if (!pass) process.exitCode = 1;
  } finally {
    await checkpointCaptureWorker.close();
    await client?.stop();
    tracker.dispose();
    original.dispose();
    mock.restore();
    await fs.rm(base, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
