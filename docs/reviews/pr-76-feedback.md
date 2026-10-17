# PR #76 Feedback Ledger

## Target and evidence

- Pull request: https://github.com/narumiruna/pi-vscode/pull/76
- Reviewed head: `e356b3a1500c4a94d1370a4ac8ec7a19127da499`.
- Reviewed base and merge base: `a58127a469a8013bf2b5ecd4817e11c1daac7f3c`.
- The checkout belongs to `narumiruna/pi-vscode` and uses the PR head branch.
- The PR description, commit, complete comparison, instructions, and successful CI checks are unchanged from the implementation review. That evidence is reused.
- All review, inline-comment, issue-comment, and review-thread pages were read. There is one inline thread. There are no further pages.

## Review ledger

| Item | Evidence and scope | Severity | Outcome |
| --- | --- | --- | --- |
| [Foreground cleanup warning](https://github.com/narumiruna/pi-vscode/pull/76#discussion_r4303223079) | `PiRpcClient.finishChild()` emits cleanup warnings during `stop()`. `PiRuntimeManager.stopClient()` disposes its subscription before it calls `stop()`. Both conversation deletion paths call this method. The startup refresh-failure path has the same order. The PR adds conservative Windows cleanup warnings and promises that they reach the user. The foreground caller drops those warnings. | Major (P1). The user can start replacement work without seeing cleanup uncertainty. | Already addressed by this change. A warning-only subscription stays active until stop settles. Both deletion paths and startup cleanup use it. Five regression cases verify delivery, ordering, original startup errors, and subscription release. Old-client state events remain detached. |
| [General review concern](https://github.com/narumiruna/pi-vscode/pull/76#pullrequestreview-5558512458) | The review reports no code defect. It requests closer review of Windows and concurrency behavior. Native Windows fixtures and Windows CI already passed. The full code comparison and relevant lifecycle consumers were reviewed. Native Windows Extension Host, remote, and live-provider checks were not run. | Discussion; no defect severity. | Already addressed as a discussion response. The code and lifecycle consumers were reviewed. Existing Windows launch evidence is retained; new runtime tests cover foreground event flow. No new code defect was supplied. Automated validation is not human approval. Native Windows Extension Host, remote, and live-provider checks remain unverified. |
| Review receipt and summary comments | They point to the inline finding and review status. They contain no separate defect, question, or required code change. | None. | Already addressed by tracking the underlying thread. Do not post duplicate replies to generated summary comments. |

## Validation

Environment: WSL Linux, Node.js 22.23.3. The VS Code mock host uses the real `PiRuntimeManager` and deterministic client events. No installed Pi process or live provider was used.

- Before the fix, four focused cases failed because the cleanup warning was absent: Trash deletion, permanent deletion, stop failure, and startup refresh failure.
- After the fix, all five regression cases pass. The added fifth case checks an exit during startup. It verifies that the original startup error is not replaced by a disposed-subscription error.
- `npm run compile` and the focused cleanup/deletion/workflow-host suite: passed, 25 tests across three files.
- `npm test`: passed, 417 tests, three Windows-only tests skipped, 50 files passed.
- The documented Biome 2.5.13 check: exit 0. Existing repository warnings remain.
- `npm run package`: passed and repeated the passing full suite. The inspected 139-file VSIX contains the updated `out/piRuntime.js`. No binary artifact is committed.
- Isolated Linux Extension Host checks passed on VS Code 1.106.0 and 1.142.0 under Xvfb.
- Windows CI now includes the runtime cleanup and deletion suites. The published check result is recorded in the thread reply.
- Browser, remote, native Windows Extension Host, and live-provider checks were not repeated for this host event-flow fix. Prior full-Windows platform failures remain documented in the PR.

The subscription forwards only `runtime_warning` events with `warningCode: "cleanup-unverified"`. It is released in `finally`, including a rejected stop. Intentional shutdown still detaches old state events before stopping the process. No trust, permission, read-only, session identity, or deletion confirmation check was removed.

## Publication and thread state

The PR was open when the ledger was completed. The fix uses its existing branch. The GitHub thread records the published commit, response, and Resolve action. The thread must remain open until validation passes and the fix is pushed. No item is deferred and no clarification is required. The saved local changes remain in the existing stash.
