import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const workflow = readFileSync(".github/workflows/publish.yml", "utf8");

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
