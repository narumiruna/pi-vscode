# Pi Settings Review Ledger

Target: https://github.com/narumiruna/pi-vscode/pull/70
Reviewed commit: `92911ffb22946be3e10eb36e48711d8c95b023ad`.

The full original diff, description, commit, checks, submitted review, inline comments, and conversation were checked. The diff and repository rules are unchanged from the implementation review. All REST pages were fetched. Both review threads and their comment pages report `hasNextPage: false`. The review receipt and summary contain no further feedback items.

| Item | Evidence and scope | Severity | Outcome |
| --- | --- | --- | --- |
| [Automatic save retry](https://github.com/narumiruna/pi-vscode/pull/70#discussion_r4302860347) | `src/webview/settings.mts` keeps drafts after failed results. Save buttons exclude checkboxes and enum controls. A user cannot submit the retained value again without changing it or discarding the draft. This breaks failure recovery in the new Settings page. | P2: a recoverable configuration write error prevents direct retry. | Already addressed. Fixed in `3f7704c` and published in [PR #72](https://github.com/narumiruna/pi-vscode/pull/72). Browser retry and stale-row checks pass. |
| [Full queue response](https://github.com/narumiruna/pi-vscode/pull/70#discussion_r4302860349) | `src/settingsPanel.ts` returns without a result when 16 operations are queued. The browser has already set `pending` and disables that row. There are 22 row/scope pairs, so slow writes can reach this bound through valid UI actions. This breaks bounded write handling in the new Settings page. | P2: a rejected write can leave a row disabled until the document is recreated. | Already addressed. Fixed in `3f7704c` and published in [PR #72](https://github.com/narumiruna/pi-vscode/pull/72). Queue rejection, no-write, and recovery checks pass. |

No feedback item is deferred or needs clarification. Both fixes are within the original Settings goal. The existing stale-write, trust, message-size, process, and CSP checks remain in place.

## Fix Evidence

- Automatic controls show Retry save when they have a retained draft and no pending request. Tests retry an enum after an unrelated revision change. They retry a checkbox after read-only and busy errors. Each retry sends the same value and target with a new request ID. A changed value in the same row still blocks a stale retry.
- A full host queue returns a bounded error result for save/reset request IDs. It does not enqueue the rejected write or echo its value. A test holds one write, fills the other 15 slots, and checks both rejected actions. It then releases the write and checks queue recovery. Invalid IDs and unrelated action names do not produce results.

## Validation

Validation ran on Linux with Node.js 26.8.2 after `npm ci`. No live provider was used.

| Check | Result |
| --- | --- |
| Focused settings unit tests | Passed: 2 tests, including queue capacity, immediate error results, no rejected writes, and later recovery. |
| `npm run package` | Passed. Includes compile and the full unit suite: 47 files, 388 tests. |
| `npm run test:settings` | Passed, including checkbox/enum retries, busy errors, unchanged retry values, and stale-row rejection. |
| `npm run test:rich-content` | Passed existing renderer and lifecycle checks. |
| Documented Biome check on `src resources` | Exit 0. Reports 458 warnings and 17 informational diagnostics. |
| Native Extension Host | Passed on VS Code 1.106.0 and stable 1.142.0. |
| Native packaged UI | Passed on VS Code 1.106.0 with disposable profiles and fixture Pi responses. |
| VSIX inspection | Settings assets are present. Source and test directories are excluded. SHA-256: `8a9b1196ac7ba1028ec327586f5d8fbb28df24eb0d5deb1b091ac04f94c3e501`. The archive is not committed. |

The earlier full stable UI Quick Pick failure is unchanged and documented in `docs/reviews/2026-10-17_pi-settings-validation.md`. That extra check was not repeated. Remote, Windows, and macOS checks were not run. No release was published.
