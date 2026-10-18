# 04. Improve Feature Discovery and Message Navigation

## Status

Implemented and locally verified. **Blocked:** an actual screen-reader pass or explicit user acceptance of that validation gap is pending. Browser accessibility assertions and native heading/focus checks do not close that item. Draft PR: https://github.com/narumiruna/pi-vscode/pull/84.

## Goal

Explain existing file-completion actions before use and make transcript messages navigable with assistive technology.

## Context

- Recommended implementation order: **4 of 7**; original finding 7. Coordinate composer layout with plan 01.
- `src/composerFileCompletionHtml.ts` and `src/composerFileToken.ts` support both snapshot attachment and path-only insertion.
- Initial composer help in `src/sidebarHtml.ts` does not explain this distinction.
- `renderMessages()` uses articles with plain role divs; messages lack accessible heading-based navigation.
- Existing snapshot capture, inspection and explicit Send boundaries must remain unchanged.

## Plan

- [x] Add a concise, accessible hint explaining that `@` attaches a file snapshot, while a visible path suggestion can be inserted with Tab without attaching contents. Acceptance: the hint is available before typing and does not imply Enter has the same behavior in both modes.
- [x] Show the hint only where file completion is supported, or explain why it is unavailable. Acceptance: shell/slash input, untrusted/virtual workspaces and workspace mismatches do not advertise an actionable completion path.
- [x] Give message articles consistent-level headings and unique accessible labels using role plus an accessible message number. Acceptance: visual role labels remain compact, heading IDs are locally generated, and shell output stays inert.
- [x] Preserve heading/focus identity during streaming and history replacement where message identity is unchanged. Acceptance: no duplicate IDs, per-token focus changes, or repeated full-response announcements occur; collapsed Thinking remains independently accessible.
- [x] Add unit tests and browser fixtures in `src/test/sidebarDiscoveryWrap.test.ts` and `scripts/discovery-wrap-fixture.mjs`. Existing completion fixtures retain path insertion, capture and failure coverage. Acceptance: initial help, path insertion, attachment capture, failure, keyboard order and accessible names are checked at narrow widths.
- [x] Update `README.md`, `docs/FEATURE_MATRIX.md` and a patch changeset. Acceptance: examples distinguish path insertion, snapshot capture and provider transmission.

## Completion Checklist

- [x] Run `npm test`, `npm run test:rich-content` and the documented Biome check; record results.
- [x] Verify heading navigation and completion keyboard behavior in fixture-driven native UI on VS Code 1.106.0 and stable.
- [ ] Perform a screen-reader pass for heading navigation and changed hints; record the screen reader/platform, or obtain explicit acceptance of that validation gap.
- [x] Confirm hints do not capture files, start Pi or send a model request; existing capture/security guards still pass.
- [x] Report automated, native and assistive-technology evidence separately. No live model is required.

## Focused implementation evidence

- `npx tsc -p ./ --pretty false` passed after concurrent draft changes resolved their compile errors.
- Focused Vitest: `sidebarDiscoveryWrap` and `composerFileCompletion` passed (20 tests).
- Standalone Chromium fixture passed: capability-aware hints, three labelled message headings, heading node/focus retention during streaming and structural replacement, keyboard toggle, and 24 themed layouts.
- Focused Biome check passed for `src/sidebarFileCompletion.ts` and `src/test/sidebarDiscoveryWrap.test.ts`.
- The worker's initial 59/60 `sidebarHtml` run exposed an old image-blocker text assertion. Integration updated it; the full final suite now passes.
- Integration completed shared documentation, runner registration, full checks and native validation as recorded below.
- The worker-only phase did not run native VS Code. Final integration passed local Linux native checks on both versions; no remote host, non-Linux platform, live provider or actual screen reader was tested. Screen-reader heading navigation and hint announcements remain an explicit validation gap.

## Integrated evidence and handoff

- `docs/COMPOSER_UX.md` records behavior tables, ownership transitions, all 26 native actions, fixed bounds, failure-case review and separate validation results.
- Final local checks: `npm test` / packaging passed (80 files; 765 passed, 3 skipped); rich-content browser suite passed; Biome passed with warnings; 64 thinking-picker cases passed.
- Local Linux native Host and full UI fixtures passed on VS Code 1.106.0 and stable 1.142.0. New UI fixtures cover status/focus, latest navigation, headings/wrap, picker groups, bounded search and actual draft reload recovery.
- Public history contract passed offline against Pi 1.3.0; no model call, upload or live authentication was used.
- Remote, Windows/macOS and actual screen-reader behavior are not claimed. Plans 03/04 retain their explicit external acceptance items until verified or accepted by the user.
- [x] Complete the authorized Git/PR handoff and record the pull request before retiring this plan. Draft PR: https://github.com/narumiruna/pi-vscode/pull/84; branch `narumi/feat/composer-experience`.

