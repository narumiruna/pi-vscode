# 03. Recover Unsent Session Drafts

## Status

Implemented and locally verified. **Blocked:** remote storage placement has not been verified, and the user's explicit acceptance of that limitation is pending. Runtime consent protects all persistent text writes; the privacy/placement acceptance items below remain open. Draft PR: https://github.com/narumiruna/pi-vscode/pull/84.

## Goal

Recover ordinary unsent text after view recreation or window reload without replaying requests or restoring private attachment payloads.

## Context

- Recommended implementation order: **3 of 7**; original finding 3. Independent of plans 01–02, but uses their composer surface if available.
- `src/sidebar.ts` retains hidden webviews and persists bounded transcript messages through `workspaceState`.
- Ordinary composer text in `src/sidebarHtml.ts` has no equivalent persisted recovery path.
- Composer revisions already protect accepted-send clearing and branch/recovered-queue insertion.
- Recovered queue attachments are memory-only under `docs/SECURITY.md`. They must not enter a new draft store.

## Architecture

The Extension Host owns a versioned, workspace-scoped text draft store. The webview sends bounded revision-tagged text updates. Each record belongs to a verified session identity or the separate Sessions-level composer. Persist only text and recovery metadata, never attachments, pins, image bytes, dialog values or queue ledgers.

## Unknowns

Local draft retention is a new privacy contract. Before implementation, obtain approval for the storage scope, retention and user notice. Proposed fixed limits: 50,000 characters per draft, 20 records, 250,000 aggregate characters and seven-day expiry. Do not add settings unless the agreed contract requires them.

## Plan

- [ ] Approve the retention/privacy contract and document where bytes reside in local and remote Extension Hosts. Acceptance: explicit approval or a revised contract is recorded before persistent writes are implemented.
- [x] Trace session creation, unsaved-to-saved identity changes, switch/import/fork/clone, deletion, restart, view disposal and send acknowledgements. Acceptance: a transition table defines draft ownership, clearing and identity migration without cross-session insertion.
- [x] Implement a small validated store and host protocol in `src/`, using `workspaceState` without Settings Sync. Acceptance: malformed/oversized/expired records are rejected or evicted deterministically; writes are serialized so stale updates cannot restore cleared text.
- [x] Send text updates with revision/session binding and bounded write frequency. Acceptance: stale messages from an old view/session cannot overwrite current text; an acknowledged send clears only its captured revision; rejected sends retain it.
- [x] Offer explicit Restore/Discard for retained text after initialization. Acceptance: recovery never sends, queues, executes shell syntax or overwrites newer input; missing attachments are stated clearly and are not silently reconstructed.
- [x] Add store, mocked-host and browser tests for reload, switching, deletion, empty/Unicode/IME drafts, limits, failed writes, stale replies and accepted-send races. Acceptance: tests prove no attachment/dialog/queue payload enters storage and recovery needs an explicit action.
- [x] Add deterministic native reload recovery coverage; update `README.md`, `docs/FEATURE_MATRIX.md`, `docs/SECURITY.md` and a patch changeset. Acceptance: retention and loss boundaries are explicit.

## Implementation Evidence

Runtime persistence is opt-in. The native modal records consent in the versioned envelope only after **Enable Draft Recovery** is accepted for the current view/binding. Decline, disposal, replacement and Disable invalidate pending approval. Fixed limits are 50,000 UTF-16 code units per draft, 20 records, 250,000 aggregate code units and seven days. Expired records are removed on the next activation/access/write, not while VS Code is closed. This implementation authorization does not close the remote-placement/approval acceptance item above.

`src/sessionDraftStore.ts` stores only `{ version: 1, consent: true, records: [{ owner, text, updated }] }` under `pi.sidebar.drafts.v1`. Session paths are SHA-256 ownership keys, not copied into records. The Sessions composer uses `sessions`. Writes are serialized and synchronous mutations coalesce; a failed snapshot reports a fixed warning without replaying obsolete data. Failure can leave earlier disk bytes, including a failed removal. There is no secure-erasure or multi-window atomicity claim.

| Transition | Draft ownership and clearing |
| --- | --- |
| Initial/recreated view | Starts in the Sessions scope. Offer retained text; never insert or send it automatically. A new random binding invalidates old messages. |
| Sessions → session | Flush old text and bind the runtime's assigned path. Do not assume persistence succeeded: preserve unsent text and block cross-context sending until explicit clear. |
| New session from Sessions Send | Capture the originating Sessions binding through the async request. An accepted send removes only that captured revision; later session/composer text is independent. |
| Unsaved → saved header | Keep ownership by the runtime-assigned file path; a changing temporary Pi ID needs no migration. No file identity means no persistence. |
| Switch/import/fork/clone | A changed assigned path creates a new binding, without copying the old draft into the new owner. An uncaptured transition keeps nonempty text but blocks saving/sending until the user clears it. |
| New input during handoff | Never replace it with a binding reply. Keep it, warn and block saving/sending until explicit clear. |
| Restart/reconnect/same-path resource operation | Keep the path owner; do not replay or transfer requests. |
| Accepted Send/queue/background/shell | Async request-local capture, including More-menu background/worktree starts, binds acknowledgement to its original view/owner/revision/text. Newer revisions or record writers cannot be cleared. A one-use Sessions creation token permits only its exact accepted origin clear. |
| Rejected/cancelled/unacknowledged Send | Keep text; no acceptance removal. |
| Confirmed session deletion | Remove only the captured deleted session's draft. Failed/cancelled deletion keeps it. Old bindings and bounded deletion tombstones reject late updates. |
| Restore | Host returns bounded text only after an explicit action. Browser requires exact binding/revision, empty composer and no composition/submission/attachment recovery lock. The record stays protected until the inserted revision is acknowledged. |
| Discard | Remove the retained record without replacing current input. New input can then be saved. |
| Disable and discard all | Remove only the owned draft key, invalidate old binding and pending consent, and keep current browser input. |
| Oversized/IME input | Oversized input retains the last saved text and shows its loss boundary. Composition is not persisted before composition end. |

Checks run by the draft worker:

- Host TypeScript: `./node_modules/.bin/tsc --pretty false` passed.
- Focused Vitest: `./node_modules/.bin/vitest run out/test/sessionDraftStore.test.js out/test/sessionDraftController.test.js`: 12 passed.
- Local Playwright Chromium: exported `assertComposerDraftRecovery` passed consent, Unicode/IME, oversize, explicit/stale Restore, handoff race, old acknowledgement, discard and zero automatic requests.
- `scripts/draft-native-fixture.mjs` exports `assertNativeDraftRecovery` for the native runner. It requires a real window-reload callback; it has not been run by this worker.
- Final integrated checks supersede the worker-only native limitation: actual reload/Restore/Disable passed on local Linux VS Code 1.106.0 and 1.142.0. Remote placement, other platforms and live-provider checks remain unverified. No live model was used.

## Rollback / Recovery

Use a new versioned key, not the transcript key. Reverting the feature must not change Pi session files or accepted requests. Provide a user-visible discard action that removes owned draft records; document removal of that exact key if rollback leaves retained text. Never delete unrelated workspace state or imply that removal securely erases backups.

## Completion Checklist

- [ ] Resolve the privacy contract and all identity transitions; record approval and final fixed bounds.
- [x] Run `npm test`, `npm run test:rich-content` and the documented Biome check; record results.
- [x] Run `xvfb-run -a npm run test:native-ui -- 1.106.0` and `stable` with recovery fixtures; verify actual window reload, not only hide/show.
- [ ] Verify remote storage placement in a disposable remote workspace, or obtain explicit acceptance of the unverified remote limitation before closing this plan.
- [x] Review storage contents, retention, cleanup and no-replay behavior; report native/browser/remote/platform evidence separately. No live model is required.

## Integrated evidence and handoff

- `docs/COMPOSER_UX.md` records behavior tables, ownership transitions, all 26 native actions, fixed bounds, failure-case review and separate validation results.
- Final local checks: `npm test` / packaging passed (80 files; 765 passed, 3 skipped); rich-content browser suite passed; Biome passed with warnings; 64 thinking-picker cases passed.
- Local Linux native Host and full UI fixtures passed on VS Code 1.106.0 and stable 1.142.0. New UI fixtures cover status/focus, latest navigation, headings/wrap, picker groups, bounded search and actual draft reload recovery.
- Public history contract passed offline against Pi 1.3.0; no model call, upload or live authentication was used.
- Remote, Windows/macOS and actual screen-reader behavior are not claimed. Plans 03/04 retain their explicit external acceptance items until verified or accepted by the user.
- [x] Complete the authorized Git/PR handoff and record the pull request before retiring this plan. Draft PR: https://github.com/narumiruna/pi-vscode/pull/84; branch `narumi/feat/composer-experience`.
