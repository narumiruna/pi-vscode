# Native Extension Dialog Validation

This record describes the feature worktree at handoff. Completed integrated checks and current limits are recorded in [Native parity validation](NATIVE_PARITY_VALIDATION.md). Counts and pending items below are historical, not current integration status.

## Contract

The native multiline editor is for non-secret text only. VS Code can retain untitled text in hot-exit backups. Per-use confirmation precedes document creation. Save is not Submit. Cleanup uses the stable tab-close API; choose Don't Save to discard dirty text. Cancelling that close leaves an inactive document. No backup-deletion guarantee is made.

The implementation uses public RPC extension UI records from Pi 1.3.0 as its reference. It adds no Pi import, runtime dependency, protocol probe, or minimum-version change. A runtime that does not emit editor requests has no new interaction. Unsupported UI methods remain ignored.

## Local evidence

Checks run on Linux with Node.js 26.8.2 and the locked dependencies:

| Command | Result |
| --- | --- |
| `npm test` | Passed: 51 files, 442 tests passed, 3 skipped. Includes host/browser compilation and bundled asset build. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed with no errors; 497 warnings and 19 informational diagnostics. No automatic fixes in this check. |
| `npm run test:rich-content` | Passed: existing renderer/CSP/lifecycle checks and 72 interface layout cases across four themes. This is browser regression evidence, not proof of native editor behavior. |
| `xvfb-run -a npm run test:native-ui -- 1.106.0 editor` | Passed against the cached minimum VS Code build with disposable workspace/profile and deterministic Pi RPC fixture. No provider call. |
| `git diff --check` | Passed. |

Unit fixtures cover bounded prefill/results/requests, duplicate IDs, one response, failed writes, Stop cancellation, exact text, empty values, active-document guards, per-use privacy decline, overlapping permissions, timeout/open races, delayed timer callbacks, trust, disposal, origin replacement and disconnect. Select validation rejects malformed or oversized permission lists without showing a partial list. Untimed permission modals keep the complete message and fail closed. Timed confirmations default to Block and require full read-only review before explicit Allow.

The native fixture proves LF and CRLF prefill/results, leading/trailing whitespace, tabs, empty submission, Unicode line/paragraph separators, full edited revision, keyboard Submit/Cancel, privacy decline, close/discard, local timeout, arbitrary-document action rejection, and process exit/reconnect. VS Code's unusual-line-terminators prompt is explicitly answered Ignore; text is not stripped. The native RPC fixture uses LF-only JSONL framing so Unicode separators cannot end records.

The same native run proves complete Unicode/multiline timed-confirmation review, unchanged content after API edit and native typing attempts, unrelated-document approval rejection, explicit keyboard approval, and timeout cleanup. VS Code can return `true` from `TextEditor.edit` for the content-provider document without changing its text; the fixture checks actual text, not that return value alone.

## Checks still required after integration

- Run the full native Extension Host and UI suites on minimum/current VS Code, including the combined sidebar changes.
- Run the separate Restricted Mode launch. This branch has deterministic host trust guards but did not run that native launch.
- Run alias and packaged variants where required by the combined changes. This branch does not change canonical workspace path handling or packaged Pi resources.
- Windows, macOS, remote hosts, screen readers, and live-provider behavior were not checked.
- Actual hot-exit backup retention/deletion was not tested. The accepted contract allows retention and requires explicit close/discard; it does not promise a secret store.

No plan is marked complete or removed by this evidence record.
