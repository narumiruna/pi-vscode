# PR #46 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/46
Reviewed head: `c59c9d4b8f50ffa4decc7694a5712a92ca6df7c1`.
Goal: suggest and run Pi slash commands, including commands that do not start an agent run.

## Evidence

Read the description, sole commit, complete diff, submitted review, inline comment, conversation comment, and all review threads. REST lists were paginated. GraphQL reports no further thread or comment pages. No remote checks are configured at the reviewed head. The conversation summary and review body contain no separate defect or question.

No `AGENTS.md` applies to this checkout. Development commands come from `README.md` and `package.json`. The extension requires VS Code 1.106, uses the Node workspace host, and changes the Sidebar webview. Host placement and API requirements stay unchanged.

## R1: Handled commands must succeed

Source: https://github.com/narumiruna/pi-vscode/pull/46#discussion_r4284949854

- Initial outcome: Actionable and not yet addressed.
- Severity: P1. A supported command can run, show a false failure, and remain available for duplicate execution through Retry.
- Supporting evidence: `PiRuntimeManager.prompt` maps `disposition: "handled"` to `undefined`. `runRequest` rejects `undefined` before completing the lifecycle or clearing `retryRequest`. This path does not require an agent event or tool event.
- Scope: the PR adds this runtime branch to meet its explicit command-completion goal. The defect is introduced by this PR.
- Fix: preserve an explicit handled result. Complete the Sidebar lifecycle, clear Retry, and refresh history without requiring or fabricating an assistant response. Keep the missing-response error for ordinary requests.
- Validation: two regression assertions fail against the reviewed production code. After the fix, `npm test` passes all 349 tests across 43 files. Tests cover acceptance, no agent settlement, no response callback, Ready status, disabled Retry, released request gate, history refresh failure without replay, and the ordinary missing-response error. Focused Biome checks pass with zero errors, 39 warnings and two infos. `git diff --check` passes.
- Package: `/tmp/pi-pr46.vsix` contains 65 files, including the explicit handled result and Sidebar response guards. Source, tests, docs and `node_modules` are excluded. The existing ignored `pi.vsix` is unchanged. No native UI, remote host or live-provider test was run.
- Outcome: implemented and validated. Publication and thread resolution are the remaining handoff actions on PR #46.

No deferred items, missing decisions, or additional findings.
