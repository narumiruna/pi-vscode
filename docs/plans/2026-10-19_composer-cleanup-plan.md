# Composer cleanup plan

## Goal

Make the Pi composer as visually quiet as the supplied Codex reference.
In a connected, idle conversation with no attachments, warnings, or extension widgets, show only the input box and its action row at the bottom.
Do not reduce font sizes to fit more information.

Implementation is authorized by the user's end-to-end execution request.
Work is on `narumi/feat/composer-cleanup`, based on `origin/main` at `108ff4b`.
The supplied plan was the only pre-existing untracked file; preserve it until completion criteria pass.

## Context

- Pi reference: https://sharex.narumi.dev/2026/10/19/znw83F4a2402GdNm.png
- Codex reference: https://sharex.narumi.dev/2026/10/19/Fy5vUE5d90d95sDW.png
- `src/sidebarHtml.ts` owns composer markup, model/thinking controls, submission hints, extension UI rendering, and runtime status.
- `src/sidebar.ts` owns native model/thinking pickers and the More action picker.
- `src/composerDraftHtml.ts` creates the persistent draft-recovery disclosure and its controls.
- Existing browser and native fixtures expect the current footer, separate thinking selector, and visible empty-draft hint.
  They must change with the interface.
- Keep VS Code 1.106 compatibility and the existing Node Extension Host/browser boundary.
  No new dependency is required.

## Design

1. Use one composer box with a text area and one action row.
   - Put an attachment icon on the left; put one model/thinking button and Send/Stop on the right.
   - Show the active model and thinking level in the combined button when space permits.
     Keep the full values in its accessible name and tooltip.
   - Open a native picker with Change Model and Change Thinking Level actions.
     Reuse the existing host operations; do not change both values implicitly.
   - Keep Next and After this visible only when the current request accepts queued input.
     Keep Stop available during cancellable work.
2. Remove the persistent empty-draft hint, file-completion instructions, Submission help row, Ready indicator, and context-usage footer.
   - Keep the neutral empty-draft explanation in the disabled Send tooltip and accessible description.
   - Keep relevant submission blockers visible.
     Announce changes without moving focus.
3. Put Submission help, Text draft recovery, Session details, Context usage, and Extension status behind More → Conversation details.
   - Use one bounded, scrollable details dialog with readable text, keyboard access, Close/Escape, and focus return.
   - Keep draft Enable/Restore/Discard/Disable controls and their existing consent, revision, and session checks.
   - Show a short, session-bound recovery notice only when retained text is available.
     Opening details must not restore or submit text.
   - Keep extension widgets at their requested above/below-editor positions.
     Move status entries only; retain plain-text rendering and lifecycle clearing.
   - Keep read-only details reachable during work or disconnect.
     This must not enable unavailable host mutations.
4. Show one foreground progress line at the conversation tail, not a second bottom footer.
   Keep reconnect, retry, and history-recovery actions visible when required, including in the Sessions view.
5. Keep blocking errors and security warnings visible.
   Allow dismissal only for non-blocking notices; do not hide cleanup uncertainty or permission requirements.
   Use consistent spacing and control heights instead of extra separator lines.

## Non-Goals

- No transcript typography, welcome-screen, or header redesign.
- No new permission mode, configuration flag, storage schema, provider call, or automatic draft replay.
- No change to attachment inspection, queue semantics, direct-shell approval, Preview/Apply, or stale-content checks in `docs/SECURITY.md`.
- No extension installation, release publication, or live-model validation.

## Plan

- [x] Confirm this design with the user before implementation; record any accepted changes in this plan.
  Evidence: the user explicitly authorized this plan, implementation, commit, push, and pull request.
  No design changes are approved.
  Automated checks and diff review have passed; human visual acceptance remains pending.
- [x] Add target-state assertions to `src/test/sidebarHtml.test.ts`, `scripts/interface-fixture.mjs`, and `scripts/test-thinking-picker.mjs`; cover the idle surface, compact action row, long model names, and keyboard access.
  Acceptance: the assertions distinguish the proposed layout from the existing footer.
- [x] Combine model/thinking controls in `src/sidebarHtml.ts` and `src/sidebar.ts`; preserve available-level handling, operation locks, and origin checks after asynchronous choices.
  Acceptance: host and browser tests cover model changes, thinking changes, cancellation, unavailable levels, and stale-session rejection without submission or draft loss.
- [x] Move low-frequency controls into Conversation details and update `src/composerDraftHtml.ts`; retain accessible submission instructions without a visible idle hint.
  Acceptance: tests cover More routing, dialog close/focus behavior, explicit retention consent, manual recovery, session changes, and no automatic send.
- [x] Consolidate status rendering in `src/sidebarHtml.ts`; move extension status entries into details while preserving widget placement and sanitization.
  Acceptance: fixtures cover idle, working, disconnected, queueable, submission-blocked, retry, history-recovery, extension-reset, and cleanup-warning states without duplicate progress lines.
- [x] Update affected browser and native fixtures for the new controls.
  Inspect `scripts/interface-fixture.mjs`, `scripts/discovery-wrap-fixture.mjs`, `scripts/draft-fixture.mjs`, `scripts/extension-ui-fixture.mjs`, `scripts/composer-navigation-fixture.mjs`, and native draft/session/authentication fixtures.
  Acceptance: assertions use the new user paths and do not depend on a visible Ready footer.
- [x] Update `README.md`, `docs/FEATURE_MATRIX.md`, and a patch `.changeset/*.md` entry.
  Acceptance: documented control locations match the interface and validation claims match actual runs.

## Completion Checklist

- [x] `npm test` passes; this includes host/browser TypeScript compilation and renderer asset builds.
- [x] `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` passes.
- [x] `npm run test:rich-content` and `npm run test:thinking-picker` pass with local Playwright Chromium.
  Include narrow panels, short windows, light/dark/high-contrast themes, and keyboard-only dialog use in the affected fixtures.
- [x] `xvfb-run -a npm run test:native-ui -- 1.106.0` and the same command with `stable` pass against disposable profiles and fixture Pi responses.
  Record any unavailable check as open until it passes or the user explicitly accepts the gap.
- [ ] User review accepts before/after captures of idle, working, warning, and narrow-panel states.
  Pending user acceptance: `/tmp/pi-composer-review/{before,after}-{idle,working,warning,narrow}.png`.
  Temporary captures are not committed.
- [x] Report browser, native, remote, platform, and live-provider checks separately.
  Do not claim remote or Windows/macOS validation from local Linux/browser fixtures.
- [x] Review the final diff for unchanged security boundaries and unintended paths.
  Evidence: main and independent read-only review found no remaining code defects; two stale README locations were corrected.
  Delete this plan only after every task and completion check is satisfied or its validation gap is explicitly accepted and recorded.

## Verification evidence

All checks used locked dependencies on Linux with Node.js 26.8.2.
Compile-based commands ran sequentially.

- **`npm test`**
  - **Result:** 84 files passed; 1,256 tests passed, 3 skipped.
    Rerun during packaging and the enabled pre-commit hook.

- **Documented Biome 2.5.13 check**
  - **Result:** Passed; 752 warnings and 24 informational diagnostics remain visible.

- **`npm run test:rich-content`**
  - **Result:** Passed; 768 interface and 224 extension-widget layouts, four themes, keyboard details/focus, manual draft recovery, capture and lifecycle safety.

- **`npm run test:thinking-picker`**
  - **Result:** Passed; 864 combined-control layouts and native-chooser message routing.

- **`npm run test:settings`**
  - **Result:** Passed; controls, scopes, drafts, keyboard, themes, CSP and teardown.

- **Full Linux native UI, 1.106.0 and stable 1.142.0**
  - **Result:** Both passed, including actual native pickers, 200% zoom, queue controls, dialog focus, actual reload, desktop draft Restore/Disable and existing Preview/Apply/Undo checks.

- **Isolated native Extension Host, both versions**
  - **Result:** Both passed; trust/bridge, semantic context, diff/edit/Undo and fixture-only shell checks.

- **`npm run package` and archive inspection**
  - **Result:** Passed; changed compiled sidebar modules are present.
    No installation or binary commit.
    Previous local VSIX restored after validation; validated artifact is `/tmp/pi-composer-validated.vsix`.

- **Diff review**
  - **Result:** Correctness, security, lifecycle, compatibility, regressions and scope reviewed.
    Native 159 × 344 clipping and deferred dialog-close focus races were corrected and regression-tested.

GitHub CI passed Compile and test and Windows process launch.
Remote, Windows/macOS UI, screen-reader/audio, packaged-install and live-provider checks were not run for this change.
Historical evidence is not claimed as current validation.
The unchanged lockfile has indirect `qs` (moderate) and `shell-quote` (critical) audit findings; no dependency update is included.

Human visual acceptance is the only open plan criterion.
Draft pull request: https://github.com/narumiruna/pi-vscode/pull/92.
Implementation commit: `b49a473`.
The working tree was clean after the implementation commit; changes were pushed to `origin/narumi/feat/composer-cleanup`.
Keep this plan for visual review; do not declare the full plan complete.
