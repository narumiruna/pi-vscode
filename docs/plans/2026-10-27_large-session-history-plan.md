# Large session history implementation plan

## Goal

Resolve [issue #126](https://github.com/narumiruna/pi-vscode/issues/126) by accepting persistent RPC frames up to 64 MiB, reporting larger frames safely, and preserving existing sessions.
The user approved this scope and requested a plan document, implementation, and pull request.
Issue metadata changes and direct issue closure are not authorized by this plan.

## Evidence

The complete issue is open with no labels, comments, or linked timeline entries at investigation time.
The investigation used clean commit `0e58f3c`, Node.js 26.11.1, Linux x64 under WSL2, and bundled Pi 1.3.0.
A synthetic valid session contained 856 messages, 2,400,120 Base64 image characters, and an exact 5,297,452-byte `get_messages` response.
Raw bundled RPC returned all messages and remained running.
The extension rejected the same response at 5,242,880 bytes and stopped Pi on two restore attempts.
Each attempt also produced repeated protocol errors during asynchronous cleanup.
No model or network requests occurred.
The original session and Windows environment were unavailable, so the exact reported native UI scenario was not attempted.

Baseline `npm test` passed 103 files with 1,632 passing tests and 3 skipped tests.
The focused RPC/history/diagnostic checks passed 91 tests in 7 files.
All temporary investigation files were removed before approval.

## Scope

Change the persistent RPC frame boundary, terminal framing-error handling, safe size diagnostics, focused regression tests, and affected documentation.
Preserve the bundled Pi version, VS Code 1.140 minimum, public RPC commands, session identity, idle ownership, trust checks, and retained transcript limits.
Do not change bridge frames, one-shot output, attachments, transfer limits, renderer behavior, or normal stop behavior.
Do not add settings, private pagination, automatic request replay, or protocol-error fresh-session fallback.
History loads after startup, so widening missing-session recovery does not fix the demonstrated failure.

## Plan

- [x] Recheck the clean working tree, verify the matching repository, create `narumi/fix/large-session-history`, and install locked dependencies with `npm ci`.
- [x] Add regression tests for the reproduced response, subsequent RPC usability, exact 64 MiB boundaries, fragmented input, UTF-8, CRLF, EOF, terminal input handling, size-only diagnostics, and retained restore references.
  Before production changes, focused checks reported 8 failures and 27 passes in 4 files, including rejection of the exact reported-size response and continued failed-decoder input handling.
  After implementation, the expanded focused suite passed 145 tests in 11 files; final verification below will include subsequent test additions.
- [x] Raise only the persistent RPC frame cap to 64 MiB and stop accepting decoder input after the first fatal size failure.
  Keep cleanup bounded and release retained oversized input.
- [x] Carry a locally generated size-error classification into allowlisted Output records and a fixed Sidebar notice.
  Do not copy frame data, error prose, paths, or conversation content into diagnostics.
- [x] Update `README.md`, `docs/FEATURE_MATRIX.md`, `docs/USER_GUIDE.md`, `docs/SECURITY.md`, and current limit statements in `docs/COMPOSER_UX.md`.
  Preserve historical validation claims as dated evidence and add a patch changeset without version changes.
- [x] Run focused checks, `npm test`, and the documented Biome check.
  Repeat an offline actual bundled-Pi restore, verify all 856 messages, subsequent RPC usability, and unchanged session identity/file bytes across reconnect.
  The full suite passed 104 files with 1,640 passing tests and 3 skipped tests; Biome passed without errors.
  Linux native VS Code 1.140.0 and isolated packaging/extracted-runtime smoke also passed.
- [ ] Review the final diff, commit only intended paths with the Husky check enabled, push the fix branch, and open a pull request.

## Completion checklist

- [x] New behavior tests fail without the fix and pass with it.
- [x] Frames at 64 MiB succeed and larger frames fail without partial history or continued buffering.
- [x] RPC size errors produce one local fatal notification and safe size-specific diagnostics.
- [x] The reported-size synthetic bundled-Pi session restores without replacement or replay.
  Two isolated restores returned all 856 messages and the same session ID/path, kept subsequent RPC usable, retained identical file digests, and made no model or network requests.
  The fixture includes persisted thinking-level metadata so normal Pi startup does not append missing settings.
- [x] Required unit/build and formatting checks pass.
- [x] Documentation and the changeset match implemented limits.
- [x] The final diff contains no unrelated changes, generated assets, or binary files.
- [ ] The requested pull request is open and its URL is reported.

## Verification evidence

- The initial regression run against unchanged production code failed 8 tests and passed 27 tests in 4 files.
- The expanded focused suite passed 145 tests in 11 files before the final Sidebar integration assertion.
- A separate failing Sidebar test showed that startup replaced the size notice with generic refresh guidance.
  Startup now preserves the typed size-specific notice; the final full suite covers this path.
- `npm test` passed 104 files with 1,640 passing tests and 3 skipped tests.
- The documented Biome 2.5.13 check passed 222 files with 1,045 warnings and 24 informational diagnostics, without errors.
- `xvfb-run -a npm run test:native -- 1.140.0` passed on Linux x64 with a disposable profile and fixture responses.
  The tested VS Code binary reports Electron 43.7.3 and Node.js 24.21.0.
  This is local Linux evidence, not Remote WSL or the original Windows UI scenario.
- `npm run package` passed in an isolated checkout, including the full suite and extracted bundled-runtime smoke.
  ZIP inspection found the compiled `rpcFrame.js` and its RPC/logging/Sidebar consumers.
  The disposable 34,512,908-byte VSIX had SHA-256 `8b0ed113e8b98705106f52ad065ec4d740fc81163f501104c63db9d4994b129e`.
  The existing repository `pi.vsix` was not changed, and disposable package files were removed.
- `npm ci` reported seven dependency advisories, as it did during baseline setup.
  Dependency versions and the lockfile are unchanged.
- Read-only review found no actionable defects.
  Final diff review confirmed intended source, regression, documentation, plan, and changeset paths only.

## What looks good

Actual bundled-runtime evidence isolates the transport failure without a live provider.
The implementation uses the existing public protocol and preserves session identity and bounded transcript presentation.
Locally typed errors separate size diagnostics from untrusted runtime records without copying frame contents.

## What looks bad

The larger cap increases possible memory use for all persistent RPC responses and events, not only history.
Full history still crosses the transport and JSON parsing remains synchronous.
Responses above 64 MiB remain unavailable.

## External handoff

Native Windows/macOS UI, native large-history UI, browser fixtures, Remote SSH/WSL/container deployment, and live-provider behavior remain unverified.
The renderer and styles are unchanged, so browser fixtures were not required for this host-only change.
The reporter or a platform maintainer can repeat restoration with their original session on Windows 11 and confirm the native UI result.
This implementation must not claim that platform-specific result from local Linux transport tests.

## Verdict

**Incomplete:** The approved implementation and required local verification are complete.
Final commit, branch push, and the requested pull request remain.
