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
- Outcome: Already addressed in `b7ad885`. The reply is published and the thread is verified resolved.

## Review update at `b7ad885`

The checkout, description, commits, instructions and checks are unchanged. The next submitted review adds R2 and R3. All REST pages and GraphQL thread/comment pages were read. There are no other new feedback items.

## R2: Accept compaction before history refresh

Source: https://github.com/narumiruna/pi-vscode/pull/46#discussion_r4285152767

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. A successful compaction can leave the command in the composer and show a rejection. Manual resubmission can cause another provider request and remove more context.
- Evidence: `sendCompactCommand` clears the composer only after `compact` returns. `compact` awaits `syncMessagesFromPi` after runtime compaction. A history error reaches `handleMessage`, which sends `sendRejected`.
- Scope: the PR adds the `/compact` composer path. Correct acceptance is required for that goal.
- Outcome: Already addressed by this update. An acceptance callback clears only the submitted composer revision after runtime compaction and before history refresh. A history failure shows a separate warning and offers Refresh history or Reconnect. It does not reject the accepted command. A failed runtime compaction still retains the draft and reports rejection.
- Validation: the new compaction test fails against `b7ad885`. It passes after the fix for both `send` and `sendNewSession`, acceptance order, revision guards, history-only recovery, and runtime compaction failure.

## R3: Finish tracking for handled commands

Source: https://github.com/narumiruna/pi-vscode/pull/46#discussion_r4285152774

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. A completed command can lose its checkpoint on the next request or receive a false process-exit checkpoint later.
- Evidence: `beforeSubmit` starts tracking for a default composer request. The handled success path has no `agent_settled` event and does not call `finishRequest`. `process_exit` uses the remaining flag to finish the old request. `ChangeTracker.finishRequest` clears its active request and stores the checkpoint.
- Scope: the PR adds completion without an agent run. It must finish the existing request tracker at that boundary.
- Outcome: Already addressed by this update. A handled response finishes the active tracker with `completed` and clears the tracking flag before history refresh.
- Validation: the expanded tracker test fails against `b7ad885`. It passes after the fix. It proves exact-once completion before history refresh, no extra completion on later process exit, and completion when history refresh fails.

## Validation for R2 and R3

- `npm test`: 350 tests pass across 43 files.
- Focused Biome checks: zero errors, 40 warnings and two infos.
- `git diff --check`: passes.
- `/tmp/pi-pr46-r23.vsix`: packaging passes. Inspection finds 65 files and both fix markers in `out/sidebar.js`. Source, tests, docs and `node_modules` are excluded. The existing ignored `pi.vsix` is unchanged.
- Native UI, remote host and live-provider behavior were not tested.

No deferred items or missing decisions.
