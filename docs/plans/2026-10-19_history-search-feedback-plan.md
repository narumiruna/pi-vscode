# Conversation feedback and Pi tab cleanup

## Goal

Remove the passive history-unavailable banner from the conversation header. Show search limitations inside the expanded search bar. Keep actual errors and recovery actions in the existing composer status and notice areas.

Remove duplicate Pi branding from the native sidebar tab shown in the user screenshot. Prefer the icon alone, with `Pi` retained as its tooltip and accessible name. A text-only tab also meets the request if it is the supported extension-local option.

## Context

- `src/conversationHistoryHtml.ts` places `#history-status` outside `#history-search-bar`. Its `onState()` handler adds the unavailable message whenever history is absent or unavailable, unless history is loading. `syncSurface()` then exposes the parent section even when search is closed.
- `historyAvailable` starts as `false` and is reset during session transitions. It is not a specific error code. Do not use it to claim that a session file is missing or damaged.
- `src/sidebar.ts` already reports history synchronization errors through status, notices, diagnostics, and guarded recovery actions. These paths do not need a second generic banner.
- `src/test/sidebarHtml.test.ts` and `scripts/history-fixture.mjs` currently expect unavailable feedback above the transcript. Both expectations must change.
- `README.md` and `docs/COMPOSER_UX.md` currently describe failure feedback outside search. Update the current behavior contract without rewriting historical validation evidence.

## Display contract

| State | Expected placement and behavior |
| --- | --- |
| Search closed; history absent or unavailable; no other history feedback | Hide the history controls section completely. Leave no empty row, padding, or border. This includes an empty new conversation. |
| Search open; history absent or unavailable; not loading | Show a short note inside the search bar: `Full history is not loaded. Search covers current text only.` Keep the existing scope and exclusion details. |
| Search open; history becomes available | Remove the conditional note immediately. Keep the search field, query, focus, and results. |
| Search closed after the note was visible | Hide the note and collapse its space immediately, without waiting for another host state update. |
| History loading | Keep the existing temporary loading feedback. Do not also show the unavailable note. |
| Browsing an earlier window or displaying truncated text | Keep the existing position and truncation feedback visible even when search is closed. |
| Actual history synchronization or session restoration error | Keep the existing composer status, notice, diagnostic action, and recovery controls. Do not infer a new error from `available: false`. |

## Native Pi tab constraint

The screenshot shows the VS Code-owned sidebar tab, not the welcome mark inside the webview. `package.json` contributes the `pi` view container with both `title: "Pi"` and `icon: "resources/pi.svg"`; `src/test/manifest.test.ts` checks its identity and title. Confirm the supported native presentation options before choosing the change. Do not use an empty or whitespace-only title, remove an accessible name, inject workbench CSS, or silently change shared workbench settings. If the current VS Code API cannot remove one visible element for this tab alone, record that limit and ask the user before proposing a shared display-setting change.

## Non-Goals

- Do not change history synchronization, session restoration, RPC limits, storage, navigation guards, or recovery availability.
- Do not add a setting, dismiss button, new status channel, or automatic retry.
- Do not investigate the original session restoration failure as part of this UI change.
- Do not install, publish, or use a live model for validation.

## Execution status

Search feedback is implemented and verified. The plan is **blocked**, not complete: the native Pi tab has no supported extension-local display-mode option, and user acceptance is pending. No manifest, shared workbench display setting, welcome mark or editor-title icon changed. The user was asked whether the PR may leave the native tab unchanged and deliver the search feedback fix. No answer is recorded.

### Native evidence and limit

- The [VS Code 1.140.0 container schema](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/api/browser/viewsExtensionPoint.ts) requires `id`, `title` and `icon`; it has no display-mode property.
- The [Secondary Sidebar implementation](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/browser/parts/auxiliarybar/auxiliaryBarPart.ts) selects labels or icons for the entire bar. The stable `WebviewView` API does not control that tab's display mode. Removing required fields, using a blank title or changing workbench CSS is not an accepted alternative.
- The native fixture on Linux / VS Code 1.140.0 shows the unchanged default as text-only `Pi`, with accessible name and tooltip `Pi`, no rendered icon, and working `pi.openChat` Sessions navigation without a prompt. This is not an extension-local presentation change and does not prove the user's existing profile has the same layout.
- Native screenshot: `/tmp/pi-native-tab-1.140.0.png`. Full native log: `/tmp/pi-native-tab-1.140.0.log`. The temporary DOM probe and final assertion runs both passed.

### Verification

- Installed locked dependencies with `npm ci` on Node.js 26.8.2. It reported two development-dependency advisories; `npm audit --omit=dev` reported zero vulnerabilities. No dependency files changed.
- Final sequential checks passed: `npm test` (85 files; 1,281 passed, 3 skipped), documented Biome check (no errors; 764 warnings and 24 informational diagnostics), then `npm run test:rich-content`.
- Browser evidence includes 32 feedback layouts across four themes and widths 169/200/280/600; zero-height hidden controls, immediate open/close, Escape/Close focus return, descriptions, availability/loading transitions, retained query/results/focus, no note-triggered host requests, and visible errors/diagnostics/recovery. Existing literal search, navigation guards, earlier-window and truncation checks remain.
- Browser captures: `/tmp/pi-history-vscode-dark-empty.png` and `/tmp/pi-history-vscode-dark-search.png`; matching captures exist for the other three themes. Logs: `/tmp/pi-history-npm-test.log`, `/tmp/pi-history-biome.log`, `/tmp/pi-history-rich-content.log`.
- Separately, `xvfb-run -a npm run test:native-ui -- 1.140.0` passed the full Linux native UI suite, including the added tab assertions and existing history, recovery, lifecycle and editor-dialog fixtures. No live model was used.
- Initial unit attempts found a missing mock attribute type and text walker; both were corrected. Initial Biome found test formatting errors; these were corrected. Final checks above passed. Historical validation sections were not rewritten.
- Complete source/test/documentation diff reviewed for correctness, security, lifecycle safety, compatibility, regressions and scope; an independent review found no code defects. `git diff --check` passed. No host synchronization, RPC, storage, process, trust, permission or recovery guards changed.
- Native-tab, empty-conversation and expanded-search images were shown in the execution conversation. **User visual acceptance is not recorded.** Remote, real screen-reader, Windows/macOS, current-version native and live-provider checks were not run for this change. No extension was installed or package published.

## Plan

- [ ] Confirm the native Pi tab presentation options supported by the minimum VS Code version. Select an extension-local icon-only or text-only representation while retaining its name for accessibility and discovery. Evidence: supported manifest/API behavior and a native fixture or screenshot; if neither option is supported, keep this item blocked pending an accepted alternative.
- [ ] Apply the supported Pi tab presentation change and update relevant manifest/native UI assertions. Keep container/view IDs, command names, the welcome mark, and editor-title icons unchanged. Evidence: the native tab has only one visible brand element, its tooltip and accessible name identify Pi, and opening Sessions still works.
- [x] Update `src/conversationHistoryHtml.ts` to remove generic unavailable feedback from `#history-status` and place the conditional note inside `#history-search-bar`. Use one shared presentation update for open, close, and host state changes. Evidence: the display contract passes without requiring an extra state event after opening or closing search.
- [x] Preserve accessibility in the search bar. Associate its visible scope and conditional note with the search field, avoid duplicate announcements, and keep Escape/Close focus return. Evidence: DOM and keyboard assertions verify descriptions, visibility, and focus.
- [x] Update `src/test/sidebarHtml.test.ts` with closed/open/closed search cases for absent and unavailable history, loading-to-unavailable and unavailable-to-available transitions, empty conversations, and actual failure notices. Retain navigation guard, earlier-window, and truncation assertions. Evidence: regression tests pass and verify that no extra RPC or model request is sent by the note.
- [x] Update `scripts/history-fixture.mjs` with real-browser visibility and layout checks. Verify no header strip when search is closed, immediate open/close behavior without host updates, keyboard focus, and narrow layouts across the existing theme fixtures. Confirm existing error notices and recovery controls remain visible when applicable. Evidence: the rich-content suite passes with the new assertions.
- [x] Update the current behavior descriptions in `README.md`, `docs/FEATURE_MATRIX.md`, and `docs/COMPOSER_UX.md`. Add a patch changeset for `narumi-pi`. Evidence: documentation matches the display contract and does not claim new validation results before checks run.
- [x] Run `npm test`, the documented Biome check, and `npm run test:rich-content` sequentially. `npm test` compiles host and browser code first. Run the relevant native UI fixture for the Pi tab on the minimum supported VS Code version (currently 1.140.0). Record browser and native results separately, including unavailable prerequisites. Do not claim remote, real screen-reader, other-platform, or live-provider coverage.
- [ ] Review the final diff and show the native Pi tab, empty-conversation, and expanded-search states for user acceptance. Evidence: only the intended UI, tests, documentation, and changeset change; the user confirms the placement.

## Completion Checklist

- [ ] The native Pi tab displays one brand element, with its accessible name and navigation preserved; the supported approach has native evidence and user acceptance.
- [x] No shared workbench setting or other extension tab was changed without explicit approval.
- [x] A new empty conversation has no passive history-unavailable strip above its welcome content.
- [x] The conditional note is inside the expanded search bar only, with no stale row after closing it.
- [x] Loading, earlier-window position, and truncation feedback still work outside search when relevant.
- [x] Actual errors, diagnostics, and recovery actions retain their existing placement and host checks.
- [x] Unit tests, browser checks, and the documented formatting/lint check have recorded passing results, or the plan remains open with a stated blocker.
- [ ] Documentation and the patch changeset are complete; user visual acceptance is recorded.
- [ ] After all checks pass, remove this completed plan and report its path. Until then, keep it as the execution checklist.
