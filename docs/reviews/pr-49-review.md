# PR #49 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/49#pullrequestreview-5536276466

Reviewed commit: `5d5631d77250aa298d3382a19fa0a0872ee084ee`.
The PR is merged. Both items need fixes on a new branch from current `origin/main`.
The repository has no `AGENTS.md` instructions. The review has two inline items.
All review, inline comment, and conversation pages were read. The thread API reports no further pages.
The full diff, description, commit, and checks were read. The original head has no check runs or commit statuses.
The review body and conversation summary have no further technical requests.

## R1: PAT stored before dependency installation

- Comment: https://github.com/narumiruna/pi-vscode/pull/49#discussion_r4285444849
- Severity: P1. A dependency lifecycle script can read a repository write credential.
- Outcome: Actionable at review time. Fixed and locally validated in this follow-up.
- Evidence: PR #49 replaces `persist-credentials: false` with `token: ${{ secrets.PAT_TOKEN }}` in `version`. `npm ci` follows checkout. The checkout v4 documentation states that credentials are stored in local Git configuration by default.
- Scope: The PR introduces the credential exposure while adding automatic Version PRs.
- Fix: Use the default read-only checkout token and set `persist-credentials: false`. Keep the PAT in the Changesets step only within this job. The release job still needs its own PAT for release creation.
- Compatibility evidence: Changesets action v1 writes its own Git credentials from `GITHUB_TOKEN` in `src/index.ts`. It does not need checkout to store credentials.
- Validation: The credential regression test fails on `origin/main` and passes with the fix. All 354 tests pass.

## R2: Pending version-bump run can be replaced

- Comment: https://github.com/narumiruna/pi-vscode/pull/49#discussion_r4285444853
- Severity: P1. An ordinary sequence of pushes can skip a release.
- Outcome: Actionable at review time. Fixed and locally validated in this follow-up.
- Evidence: The new push trigger compares `package.json` with `github.event.before`. With one active run, a pending version-bump run, and a later unchanged-version push, the default queue replaces the pending run. The later run sees equal versions and returns `release=false`.
- Scope: The PR adds both the per-push trigger and the adjacent-push version gate.
- Fix: Set `queue: max` and retain `cancel-in-progress: false` for the workflow concurrency group.
- Limit: GitHub permits up to 100 pending runs with `queue: max`. Additional runs are canceled. This fix does not claim an unlimited queue.
- Validation: The queue regression test fails on `origin/main` and passes with the fix. All 354 tests pass. `actionlint` v1.7.11 rejects the documented `queue` key. All other lint checks pass with only that exact diagnostic excluded. `git diff --check` passes.

## V1: Dependency audit notices

- Outcome: Valid but out of scope — deferred.
- Evidence: `npm ci` and `npm audit --json` report `qs@6.15.3` (moderate) and `shell-quote@1.10.0` (critical advisory rating). Both versions are present in the parent of PR #49. The PR does not change `package-lock.json`.
- Scope: No new dependency defect or new use of the affected APIs was found in this PR. The new credential exposure is addressed separately in R1.
- Severity: Project impact is unverified. There is no evidence of active exploitation, an outage, or data loss that meets P0 criteria. An advisory rating alone does not establish project severity.
- Follow-up: Use a separate dependency-update PR. No issue or PR was created for this item.

## Sources

- https://github.com/actions/checkout/blob/v4/README.md
- https://github.com/changesets/action/blob/v1/src/index.ts
- https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency

## Publication

The follow-up PR and original review-thread replies record publication and API resolution status.
Both review items are fixed. V1 is deferred. No review item needs clarification.
Live GitHub Actions and Marketplace publication are not part of local validation.
