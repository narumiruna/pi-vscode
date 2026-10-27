# Composer Behavior and Validation

## Compatibility and boundaries

These controls use the existing workspace Extension Host and sidebar webview.
VS Code 1.140.0 is the minimum supported version.
No public command ID, Pi process argument, permission policy, Preview/Apply rule, session-file format, CSP, or dependency changes are required.

Host validation remains authoritative.
Visible status, local search and native picker groups do not grant permission to execute a request.
Validation uses disposable profiles and deterministic Pi responses, without live model calls, authentication or uploads.

## Primary status

One primary status area stays inside `#composer`, after above-editor extension widgets and immediately before `.composer-box`.
It is outside the transcript and workflow scrollers and has the same parent and location in Sessions and conversations.
It uses normal composer layout, not an overlay or viewport-fixed element.

Idle reserves one text line without Ready text, a dot, or recovery buttons.
Changing from idle to single-line progress does not move the composer box.
Long actionable text and recovery controls can wrap and increase the area's height at narrow widths or higher zoom; instructions are not clipped and controls do not overlap.

| Priority | Condition | Primary display |
| --- | --- | --- |
| 1 | Disconnected, failed request, or history recovery required | Problem text and applicable recovery controls. |
| 2 | Submission blocked for a non-neutral reason | Blocker text and next action, using the order below. |
| 3 | Local operation pending or foreground work active | Image loading, message acceptance, background startup, thinking, tool execution, compaction, retry, or cancellation progress. |
| 4 | Non-Ready operation result | Completion or stopped-result text until the host replaces it. |
| 5 | Normal idle operation | Empty reserved area. |

One presentation selector supplies the visible message; submission eligibility and its description remain separate.
Empty input is neutral.
Its disabled-send explanation remains accessible and in the tooltip, but never becomes a visible hint or replaces active progress.

The primary `#status` is the single polite, atomic live region.
Its text changes only when the selected message changes.
The separate nonlive `#composer-status` supplies the current submission explanation through `aria-describedby` for the input, Send, and After this.
It has no separate visible row and does not duplicate live announcements.
Disabled-button titles remain available.

Status updates do not steal focus, force a conversation scroll, restore automatic following, or mark New output.
If a shorter status expands the viewport near the tail, the browser can clamp the reading offset to the new valid range; that layout change preserves paused following and the New output indicator.
A later user scroll to the bottom restores following.
Recovery controls remain keyboard-accessible.
Before a focused recovery control becomes hidden or disabled, focus returns to the input.
Theme tokens, visible focus, plain-text rendering, CSP, and sanitization remain unchanged.

## Submission blocker order

The first applicable row supplies disabled-button titles and the accessible submission description.
Non-neutral blockers enter primary-status priority 2, below problems and above progress; empty input supplies only the accessible description and tooltip.

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

Stop is separate from submission.
The composer has an attachment icon on the left and one model/thinking button with submission controls on the right.
Long model labels truncate visually, not in accessible names or tooltips.
The button opens a native Change Model / Change Thinking Level picker; each operation changes only the selected value.

More → Conversation details contains Submission help, file-completion instructions, Text draft recovery, Session details, context usage, and extension status.
The bounded dialog supports Close/Escape and returns focus to More.
Read-only details remain reachable during work or disconnect without authorizing mutation actions.
Extension widgets retain their requested editor placement and inert plain-text rendering.

Stop stays in the composer actions.
Reconnect, Retry, and Refresh history stay in the primary status area with unchanged host-derived availability checks.
Applicable recovery controls remain reachable even when another message has priority; unavailable actions are not enabled and retry is never automatic.

Blocking errors and process-cleanup warnings retain the separate non-dismissible notice surface and Show Output action.
Primary-status selection cannot suppress these safety notices.
Foreground tool output stays in the conversation flow; background task and proposal cards stay in the workflow area.
History notices, retained-draft controls, Pi extension status in Conversation details, and requested above/below-editor widget placements are unchanged.

## Latest-output navigation

| State or event | Behavior |
| --- | --- |
| At the bottom, no overflow, empty conversation, or Sessions layer | Hide Jump to latest. |
| Manual reading above the bottom | Keep the reading position and show Jump to latest. |
| Transcript text/thinking/attachment descriptors change while reading | Show a bounded New output label, not a per-token counter or announcement. |
| Only runtime/tool status changes | Do not mark new transcript output. |
| Activate Jump to latest | Return to the bottom and follow output, then return focus to the composer, without changing the draft or making a request. |
| Browse earlier history | Pause following; explicit latest navigation restores the current tail before following. |
| Session changes | Reset the output indicator and navigation state. |
| Word wrap or asynchronous layout | Preserve manual reading; do not force smooth scrolling. |

## Text draft ownership and storage

Retention is off until the user accepts a native non-secret storage notice.
The fixed contract is implemented behind that explicit consent: 50,000 UTF-16 code units per draft, 20 records, 250,000 aggregate code units and seven-day recovery expiry.
Cleanup occurs at the next activation/access/write, not while VS Code is closed.
Oversized text keeps the last retained record, which can be older than the input.

Only allowlisted text/owner/timestamp records enter `pi.sidebar.drafts.v1` in workspaceState.
The feature does not enable Settings Sync.
VS Code controls the storage location and backups.
Checked Linux desktop versions 1.106.0 and 1.142.0 store the active envelope in the local profile's `User/workspaceStorage/<workspace-id>/state.vscdb`, under the `ItemTable` key `narumi.narumi-pi`.
The checked VS Code Server web clients store it in client-browser IndexedDB workspace storage, even though a separate remote Node Extension Host processes it.
The remote server's active storage rows did not contain the retained envelope.
Draft updates still pass through that remote host and VS Code's connection; they are not model/provider requests.
These checks cover a loopback web-remote workspace, not Remote SSH, WSL, containers or cross-machine deployments.
Other layouts remain unverified and the consent notice says so.

No attachment, pin, image, extension-dialog value or queue recovery payload enters this key.
Removal does not securely erase backups or SQLite free pages.
Storage failures can leave older disk bytes and are reported.

Recovery controls are under More → Conversation details → Text draft recovery.
A short Retained text available · Review notice appears only for available retained text in the current scope.
It does not open the dialog or insert text automatically.
Scope transitions hide an old notice until the new binding is known.

| Transition | Ownership and recovery rule |
| --- | --- |
| Initial/recreated view | Separate Sessions ownership and a fresh random view binding; see [Ownership details](#ownership-details). |
| Sessions/detail navigation | Bounded flush and cross-context protection; see [Ownership details](#ownership-details). |
| Pi assigns or saves a session | Session-file path hashing, independent of temporary ID or saved header; see [Ownership details](#ownership-details). |
| Session switch/import/fork/clone | Resulting-session binding without silent text reassignment; see [Ownership details](#ownership-details). |
| Accepted send/queue/background startup | Clear only the captured originating binding, revision and text, including More-menu background/worktree launches. |
| Sessions-level accepted creation | A separate, one-use accepted-send token permits the exact originating clear across the expected session creation, not arbitrary later navigation. |
| Accepted local `/reload` or `/compact` | Exact pending-origin matching with newer-text protection; see [Ownership details](#ownership-details). |
| Rejected submission or cancelled/failed transition | Keep input; invalidate the pending accepted-send token. |
| View disposal/reload | Invalidate old bindings; debounced updates may be lost and retained text requires Restore. |
| Explicit Restore | Empty, unchanged input and text insertion only; see [Ownership details](#ownership-details). |
| Discard | Remove the owned retained record, not current input. |
| Session deletion | Remove that session's draft only after verified deletion. |
| Disable and discard all | Remove only the versioned draft key and invalidate bindings/consent in flight. |

### Ownership details

- Initial/recreated views start with separate Sessions ownership and a fresh random view binding.
  Do not insert retained text automatically.
- Sessions/detail navigation flushes bounded old-context text.
  Preserve unsent input and block cross-context sending until explicit clearing; do not assume a flush reached disk.
- When Pi assigns or saves a session, hash the assigned session-file path, not its temporary ID.
  A saved header does not change that path's owner.
- Session switch/import/fork/clone rebinds to the resulting session.
  Preserve newer or unretained text; never assign it silently to the new context.
- An accepted local `/reload` or `/compact` releases the handoff on an exact pending origin match when its binding is still current, even without a session change or another draft-state reply.
  Newer revisions/text remain protected.
- Explicit Restore requires empty, unchanged input and inserts text only.
  No prompt, shell, queue, attachment capture or automatic replay occurs.

Other VS Code windows and external storage writers are not serialized by this extension's in-process write queue.

## Native session actions

Existing actions remain; Word wrap and Conversation details are local conversation-display actions.
Model/Thinking mutations require an idle connected runtime and a current picker origin.
Read-only details remain available when disconnected.
Recent Sessions is not equivalent to choosing an arbitrary JSONL file.
Return Pi from Terminal remains available for held ownership recovery.

| Group | Available actions |
| --- | --- |
| Session management | Resume; Rename; Compact; Tree/Fork/Clone; Export; Import; Share; Open in Terminal; Return Pi from Terminal. |
| Conversation display | Word wrap, with the current On/Off state; Conversation details. |
| Review and repair | Checkpoints; Review Changes; Show Findings; Diagnostics; Staged Review; Failed-Test Repair; Debug Context. |
| Background work | Background Agent; Worktree Agent. |
| Pi configuration | Model; Thinking; Commands and Skills; Reload; Restart; Compatibility; Sign In; Sign Out. |

The existing routes below retain their guarded handlers.
Word wrap sends one fixed display message to the originating view without submitting a request or changing configuration.
“Palette” means the existing command remains available; no new public command is added.

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
| Word wrap | More… → Conversation display; fixed `toggleCodeWrapping` message | Current view/session origin; picker cancellation and stale selections perform no toggle. |
| Conversation details | More… → Conversation display; fixed `showConversationDetails` message | Read-only opening only; does not restore drafts, submit input, or change configuration. |
| Checkpoints | `selectCheckpoint()`; More only | No foreground request; captured coverage and guarded restore. |
| Review Changes | `pi.reviewChanges`; palette | Trusted Git snapshot and confirmation; read-only review. |
| Show Findings | `pi.showReviewFindings`; palette / Problems | Captured findings with original freshness checks. |
| Diagnostics | `pi.fixWorkspaceDiagnostics`; palette | Selected inspected snapshots; read-only proposal and Preview/Apply. |
| Staged Review | `pi.reviewStagedChanges`; palette | Trusted index snapshot, confirmation and read-only review. |
| Failed-Test Repair | `pi.repairFailedTest`; palette | Approved command or selected log; inspected evidence and preview. |
| Debug Context | `pi.askDebugContext`; palette | Supported paused Node debugger; capture approval and read-only question. |
| Background Agent | `runBackground(text, false, revision)` | Bounded non-shell draft; start lock, modal approval and workspace capacity. |
| Worktree Agent | `runBackground(text, true, revision)` | Background guards plus isolated Git worktree checks. |
| Model | `pickModel()`; combined composer settings picker | Catalog/runtime selection; idle connected runtime and current session/client/view are required after selection. |
| Thinking | `pickThinkingLevel()`; combined composer settings picker | Available levels and current session/client are rechecked after selection; zero or one level cannot cause an implicit change. |
| Commands and Skills | `pickPiCommand()`; slash completion | Discovered non-reserved command; inserts a draft, not execution. |
| Reload | `reloadResources()`; palette / `/reload` | No attachments or foreground work; canonical owner and packaged-policy checks. |
| Restart | `restartSessionProcess()`; palette | Current-policy modal, session/ownership checks and no replay. |
| Compatibility | `pi.extensionUiCompatibility`; palette | Information only; any optional handoff retains runtime guards. |
| Sign In | `pi.signInProvider`; palette | Cold trusted workspace, owned operation, store/host/provider approval. |
| Sign Out | `pi.signOutProvider`; palette | Same private-helper and approval boundaries; no automatic model change. |

Labels and descriptions are searchable.
VS Code can hide separator labels while filtering.
Separators and unknown selections never dispatch.
Session/client lifecycle changes invalidate an open picker.
Each action retains its original host guards and confirmations; no generic idle gate blocks terminal recovery.

## Search and rendering limits

Public Pi `get_messages` returns the full active branch, not a paginated response.
Every navigation reacquires it while idle under the 64 MiB persistent RPC single-line bound, increased from 5 MiB.
LF framing, decoded UTF-8 byte counting and CRLF handling are unchanged; larger complete lines and unterminated fragments are rejected.
Full-response decoding and synchronous JSON parsing can still increase memory use and pause the Extension Host.
Locally typed frame-too-large errors produce a safe allowlisted Output category and a fixed Sidebar notice, without raw frame, error or path data.
The first fatal decoder failure stops decoding and releases retained input; the client ignores later stdout while bounded cleanup completes.
History synchronization failures preserve existing session references and files, without automatic new-session fallback or request replay.
Bridge frames remain limited to 1 MiB and one-shot Pi output to 5 MiB; attachment and session import/export limits are unchanged.
Conversion retains at most 100 displayable messages and 250,000 shared text/thinking characters; earlier windows replace rather than accumulate, and do not overwrite the persisted latest-window cache.
A long message's omitted text is labelled but cannot be paged independently.

The header places Find text, Earlier history and Latest history after New/Delete and before More.
These three controls are hidden in Sessions.
Find text opens a collapsed search surface with its scope description.
When history is absent or unavailable and not loading, the expanded bar also shows: `Full history is not loaded. Search covers current text only.`
The field's accessible description includes the scope and the visible note; the note has no separate live region.
Availability updates remove the note without changing the query, focus or results.
Close and Escape hide it and collapse its space immediately, then return focus to the trigger.

With search closed, absent or unavailable history alone produces no history controls row, padding or border, including in an empty conversation.
Loading, earlier-window position and truncation keep their conditional feedback outside search.
Actual synchronization and restoration errors keep the existing composer status, non-dismissible notice, diagnostic action and host-guarded recovery controls.
`available: false` is not a missing-file or corruption diagnosis.
Latest history is disabled when already latest or when navigation is unavailable.

Find text is literal and case-sensitive, with 256 query characters and at most 1,000 ranges over 250,000 rendered text characters.
It includes answer/shell text and code/diagram source, but excludes thinking, tool details, images and SVG labels.
CSS Highlight ranges do not alter source or copied code.
Unsupported highlights leave text navigation available.
A session change clears the search selection.
Streaming preserves a still-valid selected match without jumping to it.

Requests from earlier history acquire the request gate before awaiting a latest-window restore.
Both prompt and direct-shell paths reject changed session or history generations before dispatch.
This prevents a delayed history response from moving a request into another session.

More… → Conversation display → Word wrap is a view-local display choice, off by default and not saved.
It applies to transcript code/source fallbacks only.
Shell cards, extension widgets, editor files, source text and copy text are unchanged.
Message headings have locally generated unique IDs and accessible role/number labels; unchanged headings retain identity and focus.

## Large-history validation

Validation on 2026-10-27 used Linux x64 under WSL2 and Node.js 26.11.1.
The regression first failed against the 5 MiB implementation, then restored the exact 5,297,452-byte, 856-message image-bearing history twice through bundled Pi 1.3.0.
Both restores kept session identity and file digests unchanged, left subsequent RPC usable, and made no model or network requests.
`npm test` passed 104 files with 1,640 passing tests and three skipped tests; the documented Biome check passed with warnings and informational diagnostics.
A Linux native Extension Host check on VS Code 1.140.0 and isolated `npm run package` with extracted-runtime smoke also passed.
The specific large-history flow was checked through offline RPC, not native UI.
Windows/macOS, remote, browser fixture and live-provider checks were not run for this fix.
The dated validation entries below retain the limits and behavior tested at that time.

## Fixed-status validation scope

The behavior above describes the fixed composer status contract.
The Header controls follow-up and Composer cleanup validation sections below predate this change: they checked conversation-tail progress, runtime movement between views, and the former visible submission row.
Their passing results do not validate the fixed-status layout or its announcements.

Required deterministic unit and browser coverage includes the permanent composer parent, Sessions parity, reserved idle line and unchanged idle-to-single-line geometry, simultaneous problem/blocker/progress/result states, neutral empty input, unchanged recovery availability, long text and button wrapping, four themes, narrow/short layouts, focus, unchanged scroll/following/New output state, and a single DOM live announcement surface.
Native fixtures must check placement, submission descriptions, recovery controls, Stop, and focus in the actual VS Code webview with fixture Pi responses.

Fixed-status validation passed on Linux on 2026-10-19:

| Check | Result |
| --- | --- |
| `npm test` | 84 files, 1,261 tests passed and 3 skipped; includes 76 sidebar HTML tests. |
| Documented Biome check | Passed with warnings and informational diagnostics; no errors. |
| `npm run test:rich-content` | Passed: 768 interface layouts, 224 extension-widget layouts, 4 fixed-status idle/progress geometry cases and 16 long-status/recovery/theme/zoom cases; see [Fixed-status coverage details](#fixed-status-coverage-details). |
| Linux native UI | Full suites passed on VS Code 1.106.0 and stable 1.142.0 with disposable profiles and fixture Pi responses; see [Fixed-status coverage details](#fixed-status-coverage-details). |
| Linux native Extension Host | Trusted-workspace suites passed on VS Code 1.106.0 and stable 1.142.0, including activation, bridge, cancellation and edit/Undo checks. |
| Linux native annotations | The isolated `annotations` fixture passed on VS Code 1.106.0 after its idle wait was updated for empty primary status. |

### Fixed-status coverage details

- The rich-content run includes priority, focus, single DOM live region, old-output reading, near-tail clamp and user-scroll recovery.
- The native UI runs include fixed placement in both views, submission descriptions, recovery controls, Stop, focus, draft recovery and native 200% zoom geometry.

No live model or provider was used.
DOM live-region assertions are not real screen-reader evidence.
Real screen-reader, remote, Windows/macOS UI, workspace-alias and packaged-install checks were not rerun for this relocation.
Earlier Orca and remote results do not establish coverage for the new status area.
The screen-reader fixture's idle wait was updated, but its speech checks were not run.

## Header controls follow-up (2026-10-19; before fixed status)

The header/control relocation passed 916 unit tests (3 skipped), the rich-content browser suite and the full Linux native UI suite on VS Code 1.106.0.
Browser header checks cover four themes, short/long titles, widths 200/240/280/340/600/960 and the 169 CSS-pixel viewport found at native 200% zoom: 56 layouts.
Tests cover disclosure/focus, literal search, conditional feedback, unavailable history, menu state/cancellation/stale views, display-only wrapping, copying and reading-position preservation.
Native checks use the real Word wrap Quick Pick and guarded history actions with fixture Pi responses, not a live model.
Remote, other-platform and screen-reader checks were not rerun for this relocation.

## Composer cleanup validation (2026-10-19; before fixed status)

The quiet composer passed `npm test`: 84 files, 1,256 tests passed and 3 skipped.
The rich-content suite passed 768 interface layouts, 224 extension-widget layouts, details keyboard/focus and draft ownership checks.
The combined model/thinking picker passed 864 layouts.
Tests include four themes and the 159 × 344 CSS-pixel viewport observed at native 200% zoom.
The settings browser suite also passed.

The documented Biome 2.5.13 check passed with 752 warnings and 24 informational diagnostics, not zero diagnostics.
Full Linux native UI and isolated Extension Host checks passed on VS Code 1.106.0 and stable 1.142.0 with disposable profiles and fixture Pi responses.
Native coverage includes the actual combined settings picker, busy-state Conversation details, session-ID copying, queue actions, Stop/recovery, 200% zoom, actual window reload, and explicit draft Restore/Disable.
Native geometry checks use the real webview; keyboard activation avoids Electron CDP mouse-coordinate errors at native zoom.

`npm run package` passed and archive inspection confirmed the changed compiled sidebar modules.
The VSIX was not installed.
GitHub CI passed Compile and test and Windows process launch.
No remote, Windows/macOS UI, screen-reader, audible-output, or live-provider checks were run for this cleanup.
Human visual acceptance is pending; the saved implementation plan remains open for that check.
The unchanged dependency lockfile reports existing indirect `qs` (moderate) and `shell-quote` (critical) audit findings; dependency updates are outside this UI change.

## Earlier validation evidence

Execution date: 2026-10-18.
Runtime: Node.js 26.8.2 with locked dependencies installed using `npm ci`.
Compile-based checks run sequentially to avoid shared generated-asset conflicts.
The final native, remote and assistive-technology runners used that compiled output.

| Check | Result |
| --- | --- |
| `npm test` (also rerun by packaging and Husky) | 81 files passed; 773 tests passed, 3 skipped; see [Earlier coverage details](#earlier-coverage-details). |
| Rich-content browser suite | Passed: 72 interface layouts, 24 discovery/wrap layouts, 144 extension-widget layouts; four themes; blockers, latest navigation, search, draft recovery, completion, shell, thinking, CSP and lifecycle checks; see [Earlier coverage details](#earlier-coverage-details). |
| Thinking-picker browser suite | Passed: 64 layout cases. |
| Documented Biome 2.5.13 check over `src resources` | Passed with 686 warnings and 24 informational diagnostics; no errors; warnings are not hidden or claimed fixed. |
| Isolated native Extension Host | Passed on Linux, VS Code 1.106.0 and stable 1.142.0; existing trust/bridge/edit/Undo boundaries remain covered. |
| Full native UI suite | Passed on both versions: status/focus/latest navigation, headings/wrap, grouped picker/filter/keyboard cancellation, earlier/latest search, actual reload and explicit draft Restore/Disable; see [Earlier coverage details](#earlier-coverage-details). |
| Desktop storage inspection | Both versions: the exact draft envelope appeared in the disposable profile's SQLite active extension row; see [Earlier coverage details](#earlier-coverage-details). |
| Real web-remote storage | Both VS Code Server versions: separate remote Node Extension Host, token-authenticated loopback server, actual client IndexedDB draft envelope, no marker in server active storage rows, actual reload/Restore, and exact owned-key absence after Disable; no model calls. |
| Real Orca / AT-SPI | Orca 50.2, AT-SPI 2.60.4, Python 3.14.4 / GI 3.56.2 on Linux x64 WSL2; see [Earlier coverage details](#earlier-coverage-details). |
| Validation-runner lifecycle | Remote SIGTERM exits 143 with owned server/browser processes and temporary directory removed; see [Earlier coverage details](#earlier-coverage-details). |
| Offline public history contract | Pi 1.3.0: complete 205-message response; oversized response rejected by unchanged 5 MiB bound; zero model calls. |
| Fixed-size search measurement | 100-message window, 250,000-character fixture, 1,000 highlights; see [Earlier coverage details](#earlier-coverage-details). |
| `npm run package` and archive inspection | Passed; 169-file VSIX contains the five compiled runtime helper modules; no binary is committed and package installation was not performed. |
| Diff review | Correctness, security, lifecycle, compatibility, regressions and scope reviewed; see [Earlier coverage details](#earlier-coverage-details). |

### Earlier coverage details

- Unit checks include history pre-submission races, all 26 More routes, draft lifecycle/storage failures and delayed local-command acceptance/rejection.
- Rich-content draft cases include 12 same-binding local-command acceptances, 3 stale acknowledgements and 5 delayed-handoff retention checks.
- In the full native UI suite, Sessions `/reload` and `/compact` release accepted handoffs without a new session or model prompt.
- Desktop storage inspection confirmed that Disable removed the owned key.
  Reload left input empty until explicit Restore.
- Real Orca checks passed four times per VS Code version after the fix, ten steps each.
  Real X11 structural navigation and actual Orca focus/speech logs verified Pi 4 → You 3 → Pi 2 → You 3, keyboard return to the composer, and initial/changed/restored file hints.
- An injected browser-close rejection still cleans the remote server and files.
  An empty retained draft key correctly fails the exact-key assertion.
  Orca interruption also leaves no owned live process groups.
- The final fixed-size browser run measured 35 ms limit render/search and 195 ms for 20 streaming updates, including automation.
  These are observations, not performance guarantees.
- Diff review led to fixes for history-before-gate session migration, unretained draft deletion, More-route late clearing, local-command handoff/debounce and decorative-heading focus defects, with regression evidence.

### Reproduce the additional checks

After compilation:

```bash
node scripts/test-remote-drafts.mjs /path/to/vscode-server-web/bin/code-server
node scripts/test-screen-reader.mjs /path/to/orca-prefix 1.106.0
node scripts/test-screen-reader.mjs /path/to/orca-prefix stable
```

The remote runner inspects actual serialized client database rows, not a mock `workspaceState`.
Its absence check uses the previously observed database/store/key and requires the own `pi.sidebar.drafts.v1` property to be absent.
It does not infer removal merely from missing marker text.
The server and browser use disposable homes/profiles, with provider traffic blocked.
The supplied VS Code Server license terms are accepted explicitly by the runner.

The screen-reader runner needs the Linux x64 dependencies listed in [Real screen-reader check](DEVELOPMENT.md#real-screen-reader-check).
Validation used extracted Orca/GTK/AT-SPI bindings under a temporary prefix; no system installation was changed.
The Python entry wrapper only bounds and line-buffers diagnostic output.
It does not replace Orca speech or navigation.
X11 key chords hold modifiers through letter release.
Each structural-navigation check requires Orca's actual focus target to be the expected heading, not only a DOM accessible name or an announcement containing heading text.
Diagnostic logs are bounded to 12 MiB.

Speech Dispatcher was unavailable.
These are genuine Orca-generated speech-text utterances, not audible-output or human-usability results.
Message role and heading level are spoken; message numbers can occur in article context and are not guaranteed in each utterance.

Plans 03 and 04 now have their required remote-placement and actual screen-reader evidence.
Per-workspace native consent remains mandatory before retention; no unverified topology is silently treated as verified.
All seven implementation plans are complete and retired after the Git/PR handoff.
This document retains their behavior and validation evidence.

Other unverified paths: Remote SSH/WSL/container or cross-machine deployments, non-Linux UI and screen readers, audible output/human usability, packaged native installation and live providers.
No live model, provider authorization, upload, release tag, package publication or release workflow dispatch was used.
`npm ci` reported two audit vulnerabilities (one moderate, one critical) in the unchanged lockfile; dependency remediation is outside this UX change.

### Earlier failures and corrections

An initial integrated browser run found short-panel clipping, and native fixtures exposed an incorrect assumption that filtered native separators remain visible.
The layout was corrected; the fixture verifies real unfiltered keyboard group navigation and filtered actions.
A later repeat found an intermittent wrap-reading-position failure: focus could place the reading heading below visible code, and a gutter caret could select an unrelated anchor.
Wrapping now retains the focused reading target across consecutive toggles and uses caret offsets only inside the visible code anchor.
The corrected discovery/wrap fixture passed ten consecutive runs.

Follow-up validation exposed test-harness errors: concurrent compile wrappers conflicted on generated assets; native local-command checks needed a settled composer scope and the real Reload Resources approval; IndexedDB used out-of-line keys; and reload could detach an old frame during discovery.
The runners now handle these cases.
Orca's X11 driver also needed modifier release ordering to preserve Shift+H direction.
These failed attempts are not counted as successful checks.
An optional formatting check also reports pre-existing style errors in `scripts/test-native-ui.mjs`, confirmed against its committed version; no broad unrelated reformat was applied.
The required `src resources` Biome check and the new-runner checks pass.

Actual Orca then found a product defect: CSS-generated decorative π content became a parentless accessibility section.
The first heading could be spoken, but subsequent heading navigation failed.
A real `aria-hidden` span now keeps that decoration outside the navigation target while preserving its visible style.
Both versions passed four times each after the fix; the final two passes per version also used the strengthened actual-focus assertion.

The local-command regression first failed with Send still blocked after acceptance.
After release was corrected, a delayed-acceptance browser test exposed a second defect: a newer draft's debounce could expire while the handoff blocked writes.
Accepted and rejected handoffs now restart retention without relaxing revision, binding or ownership guards.
Both failures were reproduced before the fixes; unit and browser regressions now pass.
The full package/unit/browser, native Host/UI, remote and real Orca checks above were rerun successfully.
