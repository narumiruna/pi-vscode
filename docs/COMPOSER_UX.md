# Composer Behavior and Validation

## Compatibility and boundaries

These controls use the existing workspace Extension Host and sidebar webview. VS Code 1.106.0 remains the minimum version. No public command ID, Pi process argument, permission policy, Preview/Apply rule, session-file format, CSP, or dependency changes are required.

Host validation remains authoritative. Visible status, local search and native picker groups do not grant permission to execute a request. Validation uses disposable profiles and deterministic Pi responses, without live model calls, authentication or uploads.

## Submission status priority

The first applicable row supplies both the visible status and disabled-button titles. The input and both submission actions reference this status through `aria-describedby`. A polite live region changes only when its text changes. Empty input is a neutral state, not an error.

| Priority | Condition | User action |
| --- | --- | --- |
| 1 | Disconnected | Use Reconnect. |
| 2 | Draft context is changing or kept text has uncertain ownership | Wait, or verify the session and explicitly clear kept text. |
| 3 | File attachment capture | Wait for capture to finish. |
| 4 | Queue-draft attachment restoration | Wait for restoration to finish. |
| 5 | Message acceptance pending | Wait for Pi to accept the message. |
| 6 | Background startup pending | Wait for startup to finish. |
| 7 | Pasted image loading | Wait for loading to finish. |
| 8 | New-session submission while Pi is working | Wait or use Stop. |
| 9 | Locked/non-queueable active request | Wait or use Stop. |
| 10 | Direct shell with attachments, a queue, or the Sessions composer | Use an idle session without attachments. |
| 11 | Queued slash command or full ten-message queue | Wait for settlement or a queued message to start. |
| 12 | Images with a model that does not support them | Choose a suitable model or remove images. |
| 13 | Empty text without attachments | Enter a message or attach context. |
| None | Submission available | No blocker status; titles explain Send, Next or After this. |

Stop is separate from submission. Short-panel styles bound hints and preserve input/action space. Submission help and text-draft details use bounded disclosures rather than moving the primary controls offscreen.

## Latest-output navigation

| State or event | Behavior |
| --- | --- |
| At the bottom, no overflow, empty conversation, or Sessions layer | Hide Jump to latest. |
| Manual reading above the bottom | Keep the reading position and show Jump to latest. |
| Transcript text/thinking/attachment descriptors change while reading | Show a bounded New output label, not a per-token counter or announcement. |
| Only runtime/tool status changes | Do not mark new transcript output. |
| Activate Jump to latest | Return to the bottom and follow output; focus returns to the composer. No draft change or request occurs. |
| Browse earlier history | Pause following; explicit latest navigation restores the current tail before following. |
| Session changes | Reset the output indicator and navigation state. |
| Wrap code or asynchronous layout | Preserve manual reading; do not force smooth scrolling. |

## Text draft ownership and storage

Retention is off until the user accepts a native non-secret storage notice. The fixed contract is implemented behind that explicit consent: 50,000 UTF-16 code units per draft, 20 records, 250,000 aggregate code units and seven-day recovery expiry. Cleanup occurs at the next activation/access/write, not while VS Code is closed. Oversized text keeps the last retained record, which can be older than the input.

Only allowlisted text/owner/timestamp records enter `pi.sidebar.drafts.v1` in workspaceState. The feature does not enable Settings Sync. VS Code controls the storage location and backups. Checked Linux desktop versions 1.106.0 and 1.142.0 store the active envelope in the local profile's `User/workspaceStorage/<workspace-id>/state.vscdb`, under the `ItemTable` key `narumi.narumi-pi`. The checked VS Code Server web clients store it in client-browser IndexedDB workspace storage, even though a separate remote Node Extension Host processes it. The remote server's active storage rows did not contain the retained envelope. Draft updates still pass through that remote host and VS Code's connection; they are not model/provider requests. These checks cover a loopback web-remote workspace, not Remote SSH, WSL, containers or cross-machine deployments. Other layouts remain unverified and the consent notice says so.

No attachment, pin, image, extension-dialog value or queue recovery payload enters this key. Removal does not securely erase backups or SQLite free pages. Storage failures can leave older disk bytes and are reported.

| Transition | Ownership and recovery rule |
| --- | --- |
| Initial/recreated view | Start with separate Sessions ownership and a fresh random view binding. Do not insert retained text automatically. |
| Sessions/detail navigation | Flush bounded old-context text. Preserve unsent input and block cross-context sending until explicit clearing; do not assume a flush reached disk. |
| Pi assigns or saves a session | Hash the assigned session-file path, not its temporary ID. A saved header does not change that path's owner. |
| Session switch/import/fork/clone | Rebind to the resulting session. Preserve newer or unretained text; never assign it silently to the new context. |
| Accepted send/queue/background startup | Clear only the captured originating binding, revision and text. More-menu background/worktree launches retain the same protection. |
| Sessions-level accepted creation | A separate, one-use accepted-send token permits the exact originating clear across the expected session creation, not arbitrary later navigation. |
| Accepted local `/reload` or `/compact` | An exact pending origin match releases the handoff when its binding is still current, even without a session change or another draft-state reply. Newer revisions/text remain protected. |
| Rejected submission or cancelled/failed transition | Keep input; invalidate the pending accepted-send token. |
| View disposal/reload | Invalidate old bindings. Debounced updates may be lost; retained text requires Restore. |
| Explicit Restore | Require empty, unchanged input; insert text only. No prompt, shell, queue, attachment capture or automatic replay occurs. |
| Discard | Remove the owned retained record, not current input. |
| Session deletion | Remove that session's draft only after verified deletion. |
| Disable and discard all | Remove only the versioned draft key and invalidate bindings/consent in flight. |

Other VS Code windows and external storage writers are not serialized by this extension's in-process write queue.

## Native session actions

All 26 actions remain. Model/Thinking controls are not equally available when disconnected, and recent Sessions is not equivalent to choosing an arbitrary JSONL file. Return Pi from Terminal must remain available for held ownership recovery.

| Group | Existing actions retained |
| --- | --- |
| Session management | Resume; Rename; Compact; Tree/Fork/Clone; Export; Import; Share; Open in Terminal; Return Pi from Terminal. |
| Review and repair | Checkpoints; Review Changes; Show Findings; Diagnostics; Staged Review; Failed-Test Repair; Debug Context. |
| Background work | Background Agent; Worktree Agent. |
| Pi configuration | Model; Thinking; Commands/Skills; Reload; Restart; Compatibility; Sign In; Sign Out. |

The route map below uses the original guarded handlers. “Palette” means the existing command remains available; no new public command is added.

| Action | Existing handler / alternate entry | Required state or approval |
| --- | --- | --- |
| Resume | `resumeSession()`; recent Sessions is a bounded alternative only | No foreground request; validated same-workspace session file. |
| Rename | `nameSession()`; More only | Native name input; cancel performs no rename. |
| Compact | `compact()`; `/compact` | Idle owned session; existing runtime checks. |
| Tree/Fork/Clone | `browseSessionTree()`; palette | Trusted idle matching session; revision-safe branch draft. |
| Export | `exportSession()`; palette | Owned saved matching snapshot; exclusive local output. |
| Import | `pi.importSession`; palette | Validated source and guarded retained-copy activation. |
| Share | `pi.shareSession`; palette | Inspected saved snapshot and separate upload approval. |
| Open in Terminal | `openInTerminal()`; compatibility handoff | Trusted canonical ownership transfer and cleanup confirmation. |
| Return from Terminal | `returnFromTerminal()`; palette | Held terminal/recovery ownership and explicit inspection confirmation. |
| Checkpoints | `selectCheckpoint()`; More only | No foreground request; captured coverage and guarded restore. |
| Review Changes | `pi.reviewChanges`; palette | Trusted Git snapshot and confirmation; read-only review. |
| Show Findings | `pi.showReviewFindings`; palette / Problems | Captured findings with original freshness checks. |
| Diagnostics | `pi.fixWorkspaceDiagnostics`; palette | Selected inspected snapshots; read-only proposal and Preview/Apply. |
| Staged Review | `pi.reviewStagedChanges`; palette | Trusted index snapshot, confirmation and read-only review. |
| Failed-Test Repair | `pi.repairFailedTest`; palette | Approved command or selected log; inspected evidence and preview. |
| Debug Context | `pi.askDebugContext`; palette | Supported paused Node debugger; capture approval and read-only question. |
| Background Agent | `runBackground(text, false, revision)` | Bounded non-shell draft; start lock, modal approval and workspace capacity. |
| Worktree Agent | `runBackground(text, true, revision)` | Background guards plus isolated Git worktree checks. |
| Model | `pickModel()`; keyboard composer button | Existing catalog/runtime selection; composer alternative is disabled while disconnected. |
| Thinking | `pickThinkingLevel()`; composer select | Existing supported levels/runtime checks; composer availability differs. |
| Commands/Skills | `pickPiCommand()`; slash completion | Discovered non-reserved command; inserts a draft, not execution. |
| Reload | `reloadResources()`; palette / `/reload` | No attachments or foreground work; canonical owner and packaged-policy checks. |
| Restart | `restartSessionProcess()`; palette | Current-policy modal, session/ownership checks and no replay. |
| Compatibility | `pi.extensionUiCompatibility`; palette | Information only; any optional handoff retains runtime guards. |
| Sign In | `pi.signInProvider`; palette | Cold trusted workspace, owned operation, store/host/provider approval. |
| Sign Out | `pi.signOutProvider`; palette | Same private-helper and approval boundaries; no automatic model change. |

Labels and descriptions are searchable. VS Code can hide separator labels while filtering. Separators and unknown selections never dispatch. Session/client lifecycle changes invalidate an open picker. Each action retains its original host guards and confirmations; no generic idle gate blocks terminal recovery.

## Search and rendering limits

Public Pi `get_messages` returns the full active branch, not a paginated response. Every navigation reacquires it while idle under the unchanged 5 MiB RPC bound. Conversion retains at most 100 displayable messages and 250,000 shared text/thinking characters; earlier windows replace rather than accumulate, and do not overwrite the persisted latest-window cache. A long message's omitted text is labelled but cannot be paged independently.

Find text is literal and case-sensitive, with 256 query characters and at most 1,000 ranges over 250,000 rendered text characters. It includes answer/shell text and code/diagram source, but excludes thinking, tool details, images and SVG labels. CSS Highlight ranges do not alter source or copied code. Unsupported highlights leave text navigation available. A session change clears the search selection. Streaming preserves a still-valid selected match without jumping to it.

Requests from earlier history acquire the request gate before awaiting a latest-window restore. Both prompt and direct-shell paths reject changed session or history generations before dispatch. This prevents a delayed history response from moving a request into another session.

Wrap code is an in-view display choice, off by default. It applies to transcript code/source fallbacks only. Shell cards, extension widgets, editor files, source text and copy text are unchanged. Message headings have locally generated unique IDs and accessible role/number labels; unchanged headings retain identity and focus.

## Validation evidence

Execution date: 2026-10-18. Runtime: Node.js 26.8.2 with locked dependencies installed using `npm ci`. Compile-based checks run sequentially to avoid shared generated-asset conflicts. The final native, remote and assistive-technology runners used that compiled output.

| Check | Result |
| --- | --- |
| `npm test` (also rerun by packaging and Husky) | 81 files passed; 773 tests passed, 3 skipped. Includes history pre-submission races, all 26 More routes, draft lifecycle/storage failures and delayed local-command acceptance/rejection. |
| Rich-content browser suite | Passed: 72 interface layouts, 24 discovery/wrap layouts, 144 extension-widget layouts; four themes; blockers, latest navigation, search, draft recovery, completion, shell, thinking, CSP and lifecycle checks. Draft cases include 12 same-binding local-command acceptances, 3 stale acknowledgements and 5 delayed-handoff retention checks. |
| Thinking-picker browser suite | Passed: 64 layout cases. |
| Documented Biome 2.5.13 check over `src resources` | Passed with 686 warnings and 24 informational diagnostics; no errors. Warnings are not hidden or claimed fixed. |
| Isolated native Extension Host | Passed on Linux, VS Code 1.106.0 and stable 1.142.0; existing trust/bridge/edit/Undo boundaries remain covered. |
| Full native UI suite | Passed on both versions: status/focus/latest navigation, headings/wrap, grouped picker/filter/keyboard cancellation, earlier/latest search, actual reload and explicit draft Restore/Disable. Sessions `/reload` and `/compact` release accepted handoffs without a new session or model prompt. |
| Desktop storage inspection | Both versions: the exact draft envelope appeared in the disposable profile's SQLite active extension row. Disable removed the owned key. Reload left input empty until explicit Restore. |
| Real web-remote storage | Both VS Code Server versions: separate remote Node Extension Host, token-authenticated loopback server, actual client IndexedDB draft envelope, no marker in server active storage rows, actual reload/Restore, and exact owned-key absence after Disable. No model calls. |
| Real Orca / AT-SPI | Orca 50.2, AT-SPI 2.60.4, Python 3.14.4 / GI 3.56.2 on Linux x64 WSL2. Four post-fix passes per VS Code version, ten steps each. Real X11 structural navigation and actual Orca focus/speech logs verified Pi 4 → You 3 → Pi 2 → You 3, keyboard return to the composer, and initial/changed/restored file hints. |
| Validation-runner lifecycle | Remote SIGTERM exits 143 with owned server/browser processes and temporary directory removed. Injected browser-close rejection still cleans the server and files. An empty retained draft key correctly fails the exact-key assertion. Orca interruption also leaves no owned live process groups. |
| Offline public history contract | Pi 1.3.0: complete 205-message response; oversized response rejected by unchanged 5 MiB bound; zero model calls. |
| Fixed-size search measurement | 100-message window, 250,000-character fixture, 1,000 highlights. Final browser run: 35 ms limit render/search and 195 ms for 20 streaming updates, including automation. Observations, not performance guarantees. |
| `npm run package` and archive inspection | Passed; 169-file VSIX contains the five compiled runtime helper modules. No binary is committed. Package installation was not performed. |
| Diff review | Correctness, security, lifecycle, compatibility, regressions and scope reviewed. History-before-gate session migration, unretained draft deletion, More-route late clearing, local-command handoff/debounce and decorative-heading focus defects were fixed with regression evidence. |

### Reproduce the additional checks

After compilation:

```bash
node scripts/test-remote-drafts.mjs /path/to/vscode-server-web/bin/code-server
node scripts/test-screen-reader.mjs /path/to/orca-prefix 1.106.0
node scripts/test-screen-reader.mjs /path/to/orca-prefix stable
```

The remote runner inspects actual serialized client database rows, not a mock `workspaceState`. Its absence check uses the previously observed database/store/key and requires the own `pi.sidebar.drafts.v1` property to be absent. It does not infer removal merely from missing marker text. The server and browser use disposable homes/profiles, with provider traffic blocked. The supplied VS Code Server license terms are accepted explicitly by the runner.

The screen-reader runner needs the Linux x64 dependencies listed in the README. Validation used extracted Orca/GTK/AT-SPI bindings under a temporary prefix; no system installation was changed. The Python entry wrapper only bounds and line-buffers diagnostic output. It does not replace Orca speech or navigation. X11 key chords hold modifiers through letter release. Each structural-navigation check requires Orca's actual focus target to be the expected heading, not only a DOM accessible name or an announcement containing heading text. Diagnostic logs are bounded to 12 MiB.

Speech Dispatcher was unavailable. These are genuine Orca-generated speech-text utterances, not audible-output or human-usability results. Message role and heading level are spoken; message numbers can occur in article context and are not guaranteed in each utterance.

Plans 03 and 04 now have their required remote-placement and actual screen-reader evidence. Per-workspace native consent remains mandatory before retention; no unverified topology is silently treated as verified. The seven implementation plans can be retired after the Git/PR handoff.

Other unverified paths: Remote SSH/WSL/container or cross-machine deployments, non-Linux UI and screen readers, audible output/human usability, packaged native installation and live providers. No live model, provider authorization, upload, release tag, package publication or release workflow dispatch was used. `npm ci` reported two audit vulnerabilities (one moderate, one critical) in the unchanged lockfile; dependency remediation is outside this UX change.

### Earlier failures and corrections

An initial integrated browser run found short-panel clipping, and native fixtures exposed an incorrect assumption that filtered native separators remain visible. The layout was corrected; the fixture verifies real unfiltered keyboard group navigation and filtered actions. A later repeat found an intermittent wrap-reading-position failure: focus could place the reading heading below visible code, and a gutter caret could select an unrelated anchor. Wrapping now retains the focused reading target across consecutive toggles and uses caret offsets only inside the visible code anchor. The corrected discovery/wrap fixture passed ten consecutive runs.

Follow-up validation exposed test-harness errors: concurrent compile wrappers conflicted on generated assets; native local-command checks needed a settled composer scope and the real Reload Resources approval; IndexedDB used out-of-line keys; and reload could detach an old frame during discovery. The runners now handle these cases. Orca's X11 driver also needed modifier release ordering to preserve Shift+H direction. These failed attempts are not counted as successful checks. An optional formatting check also reports pre-existing style errors in `scripts/test-native-ui.mjs`, confirmed against its committed version; no broad unrelated reformat was applied. The required `src resources` Biome check and the new-runner checks pass.

Actual Orca then found a product defect: CSS-generated decorative π content became a parentless accessibility section. The first heading could be spoken, but subsequent heading navigation failed. A real `aria-hidden` span now keeps that decoration outside the navigation target while preserving its visible style. Both versions passed four times each after the fix; the final two passes per version also used the strengthened actual-focus assertion.

The local-command regression first failed with Send still blocked after acceptance. After release was corrected, a delayed-acceptance browser test exposed a second defect: a newer draft's debounce could expire while the handoff blocked writes. Accepted and rejected handoffs now restart retention without relaxing revision, binding or ownership guards. Both failures were reproduced before the fixes; unit and browser regressions now pass. The full package/unit/browser, native Host/UI, remote and real Orca checks above were rerun successfully.
