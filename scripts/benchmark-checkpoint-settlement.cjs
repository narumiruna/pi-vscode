// Offline paired comparison. Run: node scripts/benchmark-checkpoint-settlement.cjs 5fef13b [prototype source directory]
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { setTimeout: wait } = require("node:timers/promises");
const { transformSync } = require("esbuild");

const repository = path.resolve(__dirname, "..");
const commit = process.argv[2] ?? "5fef13b";
const prototype = process.argv[3] && path.resolve(process.argv[3]);
const samples = Number(process.env.CHECKPOINT_BENCH_SAMPLES ?? 24);
assert.match(commit, /^[a-f0-9]{7,40}$/);
assert.ok(Number.isInteger(samples) && samples > 0);
const controlledPaths = new Set(["changeTracker", "checkpointCapture", "checkpointCaptureHost", "checkpointWorker"]);
const primaryFiles = 9800;
const before = "// checkpoint fixture\n".repeat(40);
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1];

// Isolated transpilation. Do not write to the shared extension build directory.
function stage(dir, baseline) {
  fs.mkdirSync(dir);
  fs.mkdirSync(path.join(dir, "test"));
  fs.symlinkSync(path.join(repository, "node_modules"), path.join(dir, "node_modules"), "junction");
  const entries = fs.readdirSync(path.join(repository, "src")).filter((name) => name.endsWith(".ts"));
  for (const file of [...entries, "test/vscodeMock.ts"]) {
    const name = file.slice(0, -3);
    const text = !controlledPaths.has(name) || (!baseline && !prototype)
      ? fs.readFileSync(path.join(repository, "src", file), "utf8")
      : baseline
        ? execFileSync("git", ["show", `${commit}:src/${file}`], { cwd: repository, encoding: "utf8" })
        : fs.readFileSync(path.join(prototype, file), "utf8");
    fs.writeFileSync(path.join(dir, `${name}.js`), transformSync(text, { loader: "ts", format: "cjs", target: "es2022" }).code);
  }
}

function fixture(root, count, large) {
  fs.mkdirSync(root);
  const contents = new Map();
  for (let i = 0; i < count; i++) {
    const dir = `${String(i % 20).padStart(2, "0")}`;
    if (i < 20) fs.mkdirSync(path.join(root, dir));
    const file = `${dir}/${i}.ts`;
    const text = i < large ? `// ${"é".repeat(950_000)}` : large ? before.slice(0, 200) : before;
    fs.writeFileSync(path.join(root, file), text);
    contents.set(file, text);
  }
  return contents;
}

function resultOf(tracker, changes) {
  const record = tracker.latest;
  assert.ok(record);
  return {
    changes: changes.map(({ id: _id, uri: _uri, ...change }) => change),
    files: record.files,
    exclusions: record.exclusions,
    status: record.status,
  };
}

async function measure(trackers) {
  let gap = 0;
  let last = performance.now();
  const timer = setInterval(() => {
    const now = performance.now();
    gap = Math.max(gap, now - last);
    last = now;
  }, 1);
  const start = performance.now();
  try {
    const results = await Promise.all(trackers.map(async (tracker) => {
      const changes = await tracker.finishRequest();
      return { tracker, changes };
    }));
    const end = performance.now();
    return {
      timer: Math.max(gap, end - last),
      elapsed: end - start,
      result: results.map(({ tracker, changes }) => resultOf(tracker, changes)),
    };
  } finally {
    clearInterval(timer);
  }
}

const summary = (rows) => Object.fromEntries(["timer", "elapsed"].map((key) => {
  const values = rows.map((row) => row[key]);
  return [key, { median: percentile(values, 0.5), p95: percentile(values, 0.95) }];
}));

async function main() {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-settlement-bench-")));
  const directories = [path.join(base, "baseline"), path.join(base, "candidate")];
  const pools = [];
  let mock;
  try {
    stage(directories[0], true);
    stage(directories[1], false);
    mock = require(path.join(directories[0], "test/vscodeMock.js")).installVscodeMock();
    const types = directories.map((dir) => require(path.join(dir, "changeTracker.js")).WorkspaceChangeTracker);
    for (const dir of directories) pools.push(require(path.join(dir, "checkpointCaptureHost.js")).checkpointCaptureWorker);
    const root = path.join(base, "workspace");
    const largeRoot = path.join(base, "workspace-large");
    const secondRoot = path.join(base, "workspace-other");
    const smallRoot = path.join(base, "workspace-small");
    const normal = fixture(root, primaryFiles, 0);
    const large = fixture(largeRoot, primaryFiles, 9);
    fixture(secondRoot, primaryFiles, 0);
    fixture(smallRoot, 100, 0);
    const cases = [
      { name: "unchanged/warm", roots: [root] },
      { name: "unchanged/cold", roots: [root], cold: true },
      { name: "mixed/warm", roots: [root], writes: 250, contents: normal },
      { name: "large/warm", roots: [largeRoot], writes: 9, contents: large },
      { name: "concurrent/warm", roots: [root, secondRoot] },
      { name: "small/warm", roots: [smallRoot] },
      { name: "small/cold", roots: [smallRoot], cold: true },
    ];
    const header = { baseline: execFileSync("git", ["rev-parse", commit], { cwd: repository, encoding: "utf8" }).trim(),
      node: process.version, os: `${os.type()} ${os.release()} ${os.arch()}`, cpus: os.availableParallelism(), cpu: os.cpus()[0].model,
      fixtureDevice: fs.statfsSync(base).type, primaryFiles, samples };
    console.log(JSON.stringify(header));
    const results = [];
    for (const spec of cases) {
      if (process.env.CHECKPOINT_BENCH_FILTER && !spec.name.includes(process.env.CHECKPOINT_BENCH_FILTER)) continue;
      const written = [...(spec.contents ?? [])].slice(0, spec.writes ?? 0);
      const trackers = types.map((Tracker) => spec.roots.map(() => new Tracker()));
      const rows = [[], []];
      try {
        for (let i = -2; i < samples; i++) {
          const observed = [];
          // Capture same before snapshots; writes then remain in place for both timed runs.
          for (const set of trackers) {
            for (let session = 0; session < set.length; session++) await set[session].startRequest(spec.roots[session], `fixture-${session}`);
          }
          for (const [j, [file, text]] of written.entries()) {
            const after = `${text.slice(0, -5)}fixed`;
            fs.writeFileSync(path.join(spec.roots[0], file), after);
            if (j % 3 !== 2) for (const set of trackers) set[0].captureToolEvent({ type: "tool_execution_start", toolName: "write", args: { path: file, content: j % 3 === 0 ? after : "does not match" } });
          }
          if (spec.cold) for (const pool of pools) await pool.close();
          for (const side of i % 2 === 0 ? [0, 1] : [1, 0]) {
            await wait(3);
            const { result, ...metrics } = await measure(trackers[side]);
            observed[side] = result;
            if (i >= 0) rows[side].push(metrics);
          }
          assert.deepEqual(observed[1], observed[0]);
          for (const [file, text] of written) fs.writeFileSync(path.join(spec.roots[0], file), text);
        }
      } finally {
        for (const set of trackers) for (const tracker of set) tracker.dispose();
      }
      const [baseline, candidate] = rows.map(summary);
      const timerP95Reduction = 1 - candidate.timer.p95 / baseline.timer.p95;
      const maxMedianRegression = Math.max(15, baseline.elapsed.median * 0.1);
      const medianRegression = candidate.elapsed.median - baseline.elapsed.median;
      const medianPass = medianRegression <= maxMedianRegression;
      const timerPass = timerP95Reduction >= 0.5;
      const result = { name: spec.name, baseline, candidate, timerP95Reduction, maxMedianRegression, medianRegression, medianPass, timerPass };
      results.push(result);
      console.log(JSON.stringify(result));
    }
    const gate = results.length !== 0 && results.every((result) => result.medianPass && (result.name.startsWith("small/") || result.timerPass));
    console.log(JSON.stringify({ gate }));
    if (!gate) process.exitCode = 1;
  } finally {
    for (const pool of pools) await pool.close();
    mock?.restore();
    fs.rmSync(base, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
