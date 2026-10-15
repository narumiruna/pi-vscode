# PR #47 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/47#pullrequestreview-5535909912
Reviewed head: `0246d61c791225cfee65eb1bb12d10c1ad61e356`.
Merged commit and follow-up base: `4684b6eda85618cb267f319ce8d46842b335aedb`.
Goal: combine release and Marketplace publication. The complete diff also includes slash-command support from `c59c9d4`.

## Evidence

The checkout remote is `git@github.com:narumiruna/pi-vscode.git`. No repository `AGENTS.md` or contribution instruction file applies. Read the description, all three commits, complete diff, checks, review, inline comments, conversation and review threads. REST lists were paginated. GraphQL has no further thread or comment pages. There are two feedback items and no separate question. The reviewed head has no check runs or commit statuses.

PR #46 remains open and contains fixes in `b7ad885` and `c3aadb3`. Neither is in `origin/main`. This follow-up reuses their source and regression tests. It does not change PR #46 or its review ledger. The follow-up branch starts at the latest fetched `origin/main`, not the merged head branch.

The extension requires VS Code 1.106.0 and uses the Node workspace host. Host placement, API requirements and trust behavior stay unchanged.

## R1: Handled commands must succeed

Source: https://github.com/narumiruna/pi-vscode/pull/47#discussion_r4285178249

- Initial outcome: Actionable and not yet addressed on main.
- Severity: P1. A command can execute and then offer Retry, which can repeat side effects.
- Evidence: the PR adds a runtime branch that returns `undefined` for `handled`. `runRequest` rejects that value before completing the lifecycle and clearing Retry. The caller expects an assistant response.
- Scope: introduced by the slash-command changes included in this PR. Supported command execution must succeed without an assistant response.
- Fix: preserve a distinct handled result. Complete the lifecycle and change tracking before reading history. Disable Retry and skip assistant callbacks for handled commands. Keep the missing-response error for ordinary requests.
- Related failure paths: state refresh errors must not undo command completion. Return the handled result, clear busy state and emit a warning. The included `/compact` route clears the accepted composer revision before history refresh. A refresh failure offers history recovery, not repeated compaction. An actual compaction failure still retains the draft.
- Validation: three regression tests fail against the merged production code. With the fixes, all 350 tests across 43 files pass. Assertions cover no agent settlement, state refresh failure, history refresh failure, completed tracking, no response callback, Ready state, disabled Retry, released request gate, both compaction send routes, and ordinary missing-response errors.
- Outcome: implemented and validated. Publish this fix in a new follow-up PR before resolving the thread.

## R2: Add a feature changeset

Source: https://github.com/narumiruna/pi-vscode/pull/47#discussion_r4285178261

- Initial outcome: Actionable and not yet addressed.
- Severity: P1 release blocker for this feature alone. This is not evidence of an active outage.
- Evidence: only `.changeset/README.md` and `.changeset/config.json` exist on the base. README requires a changeset for each release-worthy PR. The current `publish.yml` exits when versioning produces no new version.
- Contradicting detail: the cited `release.yml` was renamed to `publish.yml` in the final commit. The version guard remains, so this does not invalidate the finding.
- Scope: the PR adds a user-visible feature and promises a versioned, packaged release and Marketplace publication.
- Fix: `.changeset/slash-command-completion.md` records a minor release for `narumi-pi`, including the feature and corrected completion behavior.
- Validation: `changeset status` reports a minor bump. In a disposable directory, `npm run changeset:version` consumes the note and updates the changelog. The workflow's lockfile update produces `0.2.0` in the manifest and both lockfile version fields. Repository versions stay at `0.1.0`.
- Outcome: implemented and validated. Publish the changeset in the follow-up PR before resolving the thread.

## Validation and limits

- `npm run package`: 350 tests pass across 43 files. The resulting `pi.vsix` has 65 entries. ZIP validation passes. Compiled runtime and Sidebar code contain the handled result, state warning, response guards and compaction history recovery. Source, tests, docs, scripts, Changesets, maps and `node_modules` are excluded.
- VSIX SHA-256: `4d97fb06cc7a415ee4eddaa56bd4943ec911bac471bd63c68bb634ebef424e90`.
- Focused Biome checks: zero errors, 42 warnings and two infos. `git diff --check` passes.
- `npm audit --omit=dev`: zero vulnerabilities. The full development audit reports advisories for `qs` and `shell-quote`. The PR and follow-up do not change the dependency manifest or lockfile. No active exploitation or shipped vulnerable dependency is established. Dependency maintenance is outside this review's scope; use a separate dependency PR. No dependency issue or PR was created.
- No native UI, remote host, live-provider, Actions release run or Marketplace publication was performed. No credentials, tags or releases were changed.

No review item is deferred. No clarification or external blocker remains. Publication and platform thread resolution are recorded on the pull requests.
