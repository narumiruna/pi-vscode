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

Retention is off until the user accepts a native non-secret storage notice. The fixed proposed contract is implemented behind that explicit consent: 50,000 UTF-16 code units per draft, 20 records, 250,000 aggregate code units and seven-day recovery expiry. Cleanup occurs at the next activation/access/write, not while VS Code is closed. Oversized text keeps the last retained record, which can be older than the input.

Only allowlisted text/owner/timestamp records enter `pi.sidebar.drafts.v1` in workspaceState. The feature does not enable Settings Sync. VS Code controls the storage location and backups; actual remote placement is unverified. No attachment, pin, image, extension-dialog value or queue recovery payload enters this key. Removal does not securely erase backups. Storage failures can leave older disk bytes and are reported.

| Transition | Ownership and recovery rule |
| --- | --- |
| Initial/recreated view | Start with separate Sessions ownership and a fresh random view binding. Do not insert retained text automatically. |
| Sessions/detail navigation | Flush bounded old-context text. Preserve unsent input and block cross-context sending until explicit clearing; do not assume a flush reached disk. |
| Pi assigns or saves a session | Hash the assigned session-file path, not its temporary ID. A saved header does not change that path's owner. |
| Session switch/import/fork/clone | Rebind to the resulting session. Preserve newer or unretained text; never assign it silently to the new context. |
| Accepted send/queue/background startup | Clear only the captured originating binding, revision and text. More-menu background/worktree launches retain the same protection. |
| Sessions-level accepted creation | A separate, one-use accepted-send token permits the exact originating clear across the expected session creation, not arbitrary later navigation. |
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

Execution date: 2026-10-18. Runtime: Node.js 26.8.2 with locked dependencies installed using `npm ci`.

| Check | Result |
| --- | --- |
| `npm test` (also rerun by packaging) | 80 files passed; 765 tests passed, 3 skipped. Includes history pre-submission races, all 26 More routes, and draft lifecycle/storage failures. |
| `npm run test:rich-content` | Passed: 72 interface layouts, 24 discovery/wrap layouts, 144 extension-widget layouts; four themes; new blocker, navigation, search and draft fixtures; existing completion, shell, thinking, rich-render/CSP/lifecycle checks. |
| `npm run test:thinking-picker` | Passed: 64 browser layout cases. |
| Documented Biome 2.5.13 check over `src resources` | Passed with 686 warnings and 24 informational diagnostics; no errors. Warnings are not hidden or claimed fixed. |
| `xvfb-run -a npm run test:native -- 1.106.0` | Passed isolated local Linux Extension Host checks, including existing trust/bridge/edit/Undo boundaries. |
| `xvfb-run -a npm run test:native -- stable` | Passed on VS Code 1.142.0. |
| `xvfb-run -a npm run test:native-ui -- 1.106.0` | Passed all fixtures, including new status/focus/latest navigation, headings/wrap, native groups/filter/keyboard cancellation, earlier/latest search, and actual reload + explicit draft Restore/Disable. |
| `xvfb-run -a npm run test:native-ui -- stable` | Passed on VS Code 1.142.0 with the same local Linux fixtures. |
| `node scripts/history-fixture.mjs --public-api <Pi dist/cli.js>` | Passed with offline Pi 1.3.0: complete 205-message response; oversized response rejected by unchanged 5 MiB bound; zero model calls. |
| Fixed-size search measurement | 100-message window; 250,000-character fixture; 1,000 highlights. Last browser run: 32 ms limit render/search and 169 ms for 20 streaming updates, including automation overhead. These are observations, not performance guarantees. |
| `npm run package` and local archive inspection | Passed; VSIX contains the five new compiled runtime helper modules. No binary is committed. Package installation was not performed. |
| Diff review | Reviewed correctness, security, lifecycle, compatibility, regressions and scope. Corrected history-before-gate session migration, unretained draft deletion and More-route late-acceptance clearing; regressions cover each. |

Browser accessibility assertions do not establish actual screen-reader behavior. Local native tests do not establish remote, Windows or macOS behavior. A user decision is pending for plan 03's remote storage placement and plan 04's real screen-reader pass; neither plan is declared complete. Draft recovery is opt-in, and its approval notice states the remote limitation.

Other unverified paths: remote workspace execution, Windows/macOS UI, packaged native installation and live providers. No live model, provider authorization, upload, release tag, package publication or release workflow dispatch was used. `npm ci` reported two audit vulnerabilities (one moderate, one critical) in the unchanged lockfile; dependency remediation is outside this UX change.

An initial integrated browser run found short-panel clipping, and native fixtures exposed an incorrect assumption that filtered native separators remain visible. The layout was corrected and the fixture now verifies real unfiltered keyboard group navigation plus filtered actions. All required local checks above were rerun successfully; earlier failures are not represented as passing evidence.
