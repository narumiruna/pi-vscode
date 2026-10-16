import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const workflow = readFileSync(".github/workflows/publish.yml", "utf8");
const detectionStep = workflow.split("      - name: Detect the version bump\n")[1].split("\n      - name:")[0];
const detectionScript = detectionStep.split("        run: |\n")[1].replace(/^ {10}/gm, "");

function detectRelease(previousManifest: string | undefined, beforeOverride?: string, existingTag = false) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-publish-test-"));
  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "Test",
        GIT_AUTHOR_EMAIL: "test@example.com",
        GIT_COMMITTER_NAME: "Test",
        GIT_COMMITTER_EMAIL: "test@example.com",
      },
    }).trim();
  try {
    git("init", "--quiet");
    if (previousManifest !== undefined) {
      writeFileSync(join(cwd, "package.json"), previousManifest);
      git("add", "package.json");
    }
    git("-c", "core.hooksPath=/dev/null", "commit", "--quiet", "--allow-empty", "-m", "baseline");
    const before = beforeOverride ?? git("rev-parse", "HEAD");
    writeFileSync(join(cwd, "package.json"), JSON.stringify({ version: "0.2.0" }));
    writeFileSync(
      join(cwd, "package-lock.json"),
      JSON.stringify({ version: "0.2.0", packages: { "": { version: "0.2.0" } } }),
    );
    mkdirSync(join(cwd, ".changeset"));
    writeFileSync(join(cwd, "CHANGELOG.md"), "# Changelog\n");
    if (existingTag) git("tag", "v0.2.0");
    const output = join(cwd, "outputs");
    writeFileSync(output, "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", detectionScript], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, BEFORE_SHA: before, GITHUB_OUTPUT: output },
    });
    assert.ifError(result.error);
    return { status: result.status, stderr: result.stderr, output: readFileSync(output, "utf8") };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

test("release detection skips publishing when the previous commit has no package manifest", () => {
  const result = detectRelease(undefined, undefined, true);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=false\n");
});

test("release detection skips publishing when the previous revision is unavailable", () => {
  for (const before of ["0".repeat(40), "1".repeat(40)]) {
    const result = detectRelease(undefined, before);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.output, "release=false\n");
  }
});

test("release detection skips unchanged versions", () => {
  const result = detectRelease(JSON.stringify({ version: "0.2.0" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=false\n");
});

test("release detection publishes a validated version bump", () => {
  const result = detectRelease(JSON.stringify({ version: "0.1.0" }));
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.output, "release=true\nversion=0.2.0\ntag=v0.2.0\n");
});

test("release detection rejects an existing release tag", () => {
  const result = detectRelease(JSON.stringify({ version: "0.1.0" }), undefined, true);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Tag v0\.2\.0 already exists/);
  assert.equal(result.output, "");
});

test("release detection still fails for malformed previous manifests", () => {
  const result = detectRelease("invalid JSON");
  assert.equal(result.status, 1);
  assert.equal(result.output, "");
});

test("publish checkout does not keep credentials before dependency installation", () => {
  const checkouts = [...workflow.matchAll(/        uses: actions\/checkout@v4\n([\s\S]*?)(?=\n      - name:)/g)];
  assert.equal(checkouts.length, 3);
  for (const [, checkout] of checkouts) {
    assert.match(checkout, /persist-credentials: false/);
    assert.doesNotMatch(checkout, /secrets\.PAT_TOKEN/);
  }
  const versionJob = workflow.split("\n  version:\n")[1].split("\n  release:\n")[0];
  const stepsBeforeChangesets = versionJob.split("      - name: Create or update the version PR")[0];
  assert.match(stepsBeforeChangesets, /run: npm ci/);
  assert.doesNotMatch(stepsBeforeChangesets, /secrets\.PAT_TOKEN/);
  assert.match(versionJob, /GITHUB_TOKEN: \$\{\{ secrets\.PAT_TOKEN \}\}/);
});

test("publish keeps pending version-bump runs within the GitHub queue limit", () => {
  const concurrency = workflow.split("\nconcurrency:\n")[1].split("\njobs:\n")[0];
  assert.match(concurrency, /^  group: release-vsix$/m);
  assert.match(concurrency, /^  cancel-in-progress: false$/m);
  assert.match(concurrency, /^  queue: max$/m);
});
