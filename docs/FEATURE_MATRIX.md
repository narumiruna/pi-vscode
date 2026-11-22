# Pi Feature Matrix

This matrix maps the capabilities advertised by the four requested reference extensions to the Pi workflow implemented in this repository.
Vendor-owned hosted services cannot be reproduced by a local extension, so those rows name the external dependency and the available Pi-local alternative.

The minimum supported VS Code version is 1.146.0, with matching `@types/vscode` declarations.
Versions before 1.146.0 are no longer supported.
Validation results for older versions below are historical evidence, not the current compatibility contract.

[Pi terminology](PI_TERMINOLOGY.md) maps core API names to extension-only views and adapters.
Public command IDs, settings, stored keys and protocol fields remain stable.

The fixed primary status contract is current behavior; validation results elsewhere in this matrix predate that relocation unless explicitly stated.
They do not prove fixed placement, reserved idle geometry, or single-region announcements.
Tool output, background/workflow cards, and requested extension-widget placements are unchanged.

Pi and installed extensions own tool and shell permissions.
pi-vscode adds no built-in tool confirmations or extra `!` / `!!` approval in the sidebar or controlled TUI.
Without a permission policy, execution can proceed with no confirmation.
Pi-requested dialogs remain unchanged.
Trust/project-resource approvals, read-only enforcement, Preview/Apply, stale checks and other workflow confirmations remain in place.
Earlier permission-validation results are historical, not evidence for this removal.

The current identifier contract uses `pi.*` settings and commands, Pi/pi internal names and bundled assets, and `PI_VSCODE_*` bridge variables and prompt markers.
Old identifiers and cached state are not migrated.
Persistent Pi session files and exact legacy global bridge cleanup paths are unchanged.

| Reference capability | Pi workflow | Status / evidence |
| --- | --- | --- |
| Bundled default Pi runtime | Exact Pi 1.5.2 production dependency, workspace Extension Host runtime, shared Pi stores, explicit external override and target-specific reset | [Runtime behavior and validation limits](#bundled-default-pi-runtime). |
| Fixed primary composer status | One permanent composer area, with quiet idle space and wrapping actionable text | [Status behavior and checks](#fixed-primary-composer-status). |
| Visible submission blockers | Non-neutral blockers share primary status; neutral empty input uses only a tooltip and accessible description | [Submission descriptions and checks](#visible-submission-blockers). |
| Latest-output navigation | Keyboard-accessible Jump to latest, bounded New output indicator and preserved manual reading | [Reading position and checks](#latest-output-navigation). |
| Panel clipboard and send feedback | Tool input/output Copy uses the VS Code clipboard; mixed text/image paste keeps text; drafts clear only after acceptance | [Clipboard and acceptance checks](#panel-clipboard-and-send-feedback). |
| Operation diagnostics | Shared **Output → Pi** log, explicit **Show Output**, and short results and uncertainty instructions in the Sidebar | [Logging boundaries and evidence](#operation-diagnostics). |
| Text draft recovery | More → Conversation details recovery controls, explicit retention consent, bounded workspace-scoped text storage, session-bound retained-text notice, manual Restore/Discard and Disable/discard-all | [Storage and recovery evidence](#text-draft-recovery). |
| Discoverable file context and accessible messages | Capability-aware snapshot/path instructions in Submission help and the input's accessible description; stable, labelled message headings | [Context and accessibility limits](#discoverable-file-context-and-accessible-messages). |
| Space-filling Sessions list | Recent sessions use the available height above the composer, with internal scrolling and View all search | `sidebarHtml.ts`, `sidebarHtml.test.ts`, `scripts/sessions-layout-fixture.mjs`; offline checks cover entries beyond the former three-row limit, responsive height, scrolling, search, and composer access. |
| Skill titles for saved sessions | Unnamed saved sessions show the `/skill:` command and its arguments instead of expanded skill instructions | `sessionHistory.ts`, `sessionHistory.test.ts` |
| Quick session switching | Sidebar-native Quick Pick, View all and previous/next commands select retained live or validated cold saved sessions during ordinary work; bounded discovery and stable cycling | [Current routing and validation](#concurrent-sidebar-sessions). |
| Concurrent Sidebar requests | One Sidebar over independent retained controllers; A and B can run ordinary requests without stopping each other | [Behavior and current validation](#concurrent-sidebar-sessions). |
| New/resumed Sidebar conversation during work | New Session, Resume Session and the Sessions composer admit a separate runtime rather than replacing A | [Admission and mutation boundaries](#concurrent-sidebar-sessions). |
| Sessions activity | Leading icons for host-owned Idle, Running, Waiting for input, Completed, Failed, and Stopped, separate from cleanup and delivery warnings | [Activity semantics](#concurrent-sidebar-sessions) and [icon legend](USER_GUIDE.md#concurrent-sidebar-sessions). |
| Unread Sidebar results | Per-result revisions clear only after visible latest-following detail renders the exact result, not on selection | [Unread semantics](#concurrent-sidebar-sessions). |
| Concurrent interactive editor sessions | Pi: New Concurrent Session and Pi view-title +; editor panels share the eight additional runtime slots with auxiliary Sidebar entries alongside one Primary | [Concurrency contract and earlier validation](#concurrent-interactive-editor-sessions). |
| Sidebar slash commands | Disconnected local suggestions; session, model, thinking and settings shortcuts; explicit command/skill discovery with typed resource labels and revision-bound insertion | [Slash command behavior and checks](#sidebar-slash-commands). |
| Grouped native session actions | One searchable native Quick Pick with five groups, including Conversation display → Word wrap / Conversation details; existing mutation routes retain host checks | `sidebar.ts`, `sessionActions.test.ts`; separators, description filtering, stale/lifecycle rejection and cancellation retain original host guards and command IDs. |
| Transcript code wrapping | More… → Conversation display → Word wrap shows On/Off, off by default and local to the view | [Display-only behavior](#transcript-code-wrapping). |
| Bounded conversation search/history | Header Find text / Earlier history / Latest history icons; search-only scope and unloaded-history note, no passive unavailable strip, conditional loading/position/truncation feedback and safe literal highlighting | [History bounds](#bounded-conversation-searchhistory). |
| Temporary passage annotations | Primary-only whole-line highlights, literal hovers and read-only native comments; collapsed by default, with an initial-state setting | [Annotation contract and evidence](#temporary-passage-annotations). |
| Theme-aware Pi editor button | The editor-title Open Sessions action uses separate light and dark Pi icons | `package.json`, `resources/pi.svg`, `resources/pi-dark.svg`; manifest tests check theme mappings, explicit colors and matching shapes. |
| Native Pi extension dialogs | Single-line input, explicitly accepted non-secret multiline editor, and full read-only review before timed confirmation | [Dialog boundaries and evidence](#native-pi-extension-dialogs). |
| Approved Pi resource reload and restart | Local `/reload`, Reload Pi Resources, and separately confirmed Restart Pi with current launch policy | [Resource-control evidence](#approved-pi-resource-reload-and-restart). |
| Pi session branches | Bounded tree browser, selected user fork, active-branch clone and no-summary navigation | [Branch behavior and limits](#pi-session-branches). |
| Pi terminal compatibility and ownership | Contextual compatibility help and policy-equivalent terminal handoff | [Ownership and terminal limits](#pi-terminal-compatibility-and-ownership). |
| Windows Pi process launches | Bundled Pi uses the Extension Host runtime; external Pi resolves native executables and standard npm Node shims with the final child PATH and working directory | [Windows launch evidence](#windows-pi-process-launches). |
| Git change review | Confirm immutable staged, unstaged, working-tree, or merge-base-to-HEAD snapshots; navigate findings in Problems | [Git review evidence](#git-change-review). |
| Semantic code context | Attach provider-backed definitions, references, callers, callees and symbols; query metadata through `vscode_code_context` | [Semantic context evidence](#semantic-code-context). |
| Workspace diagnostic repair | Select errors/warnings, inspect full file snapshots, preview selected hunks across files, Apply once | [Diagnostic repair evidence](#workspace-diagnostic-repair). |
| Selective application | Choose deterministic hunks, preview the combined selection, Apply once | [Hunk application evidence](#selective-application). |
| Composer file completion | Local `@` workspace suggestions capture inspectable attachment snapshots; Tab accepts visible path-only suggestions without reading contents | [Completion evidence and limits](#composer-file-completion). |
| Context inspection | Attachment-only text counts, image counts, exact snapshots through Attach → View attachments, explicit edit/redact/refresh, bounded memory-only pins | [Inspection evidence and limits](#context-inspection). |
| Failed-test repair | Explicit process command or supplied failure log, read-only proposal, approved save/rerun | [Test-repair evidence and limits](#failed-test-repair). |
| Request checkpoints | Bounded pre-prompt snapshots, coverage report, preview and guarded restore | [Checkpoint evidence and limits](#request-checkpoints). |
| Direct shell | Explicit idle-session `!command` / `!!command`, no extra pi-vscode approval in the sidebar or controlled TUI, correlated plain-text cards, Stop and a finite deadline | [Shell contract and evidence](#direct-shell). |
| In-flight instructions | Visible Next and After this actions, Enter/platform alternate shortcuts, Submission help, attachment snapshots, pending text, delivery-time transcript entries and recovered drafts | [Queue evidence and limits](#in-flight-instructions). |
| Debug-context questions | Explicit bounded paused Node.js capture, variable selection, inspection/redaction, read-only question | [Debugger evidence and limits](#debug-context-questions). |
| Pi Settings | Pi view title native ⋯ menu: Extension Settings then Pi Configuration, directly in one configuration group; native Settings and singleton Global Pi/Project Pi file editor | [Settings behavior and evidence](#pi-settings). |
| Pi extension status and text widgets | Keyed text-only status in More → Conversation details; above/below-editor widgets retain their placement, separate from host status and controls | [Extension UI evidence and limits](#pi-extension-status-and-text-widgets). |
| Thinking blocks | Collapsed **Thinking** plain-text disclosures during streaming and Pi history refresh, including thinking-only and redacted responses | [Thinking evidence and limits](#thinking-blocks). |
| Rich panel responses | Markdown tables, nested/task lists, quotes, links, strikethrough, highlighted code, KaTeX math, and Mermaid flowchart/sequence SVG | [Renderer evidence and limits](#rich-panel-responses). |
| Codex side-by-side chat panel | Quiet idle composer, attachment and model/thinking controls, fixed primary status, separate Stop and blocking notices | [Panel behavior and evidence](#codex-side-by-side-chat-panel). |
| Codex context from open files and selections | Selection, current file, file picker, diagnostics, terminal text, and image attachments | [Attachment and selection evidence](#codex-context-from-open-files-and-selections). |
| Codex edit and preview changes | Editor actions use the stable Primary Pi Chat session, create proposal cards, generate virtual-document diffs, and require Preview before Apply | Implemented in `src/editorActions.ts` and `src/sidebar.ts`. |
| Codex cloud delegation | Independent background and detached-worktree Pi agents with streamed tracking | Local equivalent implemented; OpenAI-hosted Codex Cloud remains an OpenAI service dependency. |
| Codex cloud task review locally | Inspect actual isolated-task results and explicitly import selected files into the originating worktree | [Task import evidence and limits](#codex-cloud-task-review-locally). |
| GitHub Copilot inline completion | Manual or opt-in automatic VS Code ghost-text completion | Cache hits skip the typing delay; misses read bounded editor context after the delay. |
| GitHub Copilot next edit suggestion | `Pi: Suggest Next Edit` predicts one focused whole-file change and opens a diff preview | Implemented local equivalent; Copilot's proprietary ranking model is a GitHub service dependency. |
| Copilot Chat conversational assistance | Dedicated Pi view plus native `@pi` Chat participant and slash commands | Implemented. |
| Copilot inline chat | `Pi: Inline Edit` targets the selection or current line, routes into persistent Pi Chat, preserves follow-up context, and previews edits | `Ctrl/Cmd+I` runs Quick Fix (`pi.quickFix`), with an Inline Edit fallback only when no relevant diagnostic exists. |
| Copilot Ask/Edit/Plan/Agent modes | Pi-default conversation without extension-defined modes | Deliberately uses Pi's default tools and extension-contributed tools instead of recreating Copilot modes or fixed allowlists. |
| Copilot autonomous multi-step agent | Persistent Pi RPC conversation reads, edits, runs commands, tests, retries, and self-corrects | Implemented using Pi's default coding toolset. |
| Copilot central session management | New, name, resume, compact, export, terminal handoff, foreground, and background sessions | Implemented in the Pi conversation view. |
| Copilot Plan-to-implementation handoff | Plan and build welcome actions create ordinary prompt drafts in the same Pi-default session | No special mode transition or runtime restart is required. |
| Copilot change review and revert | Chronological tool calls, changed-file cards, request history, Source Control, diff, open, and stale/dirty-safe revert | [Tool history and recovery limits](#copilot-change-review-and-revert). |
| Copilot custom instructions | Pi global/project AGENTS.md and Pi system/settings resources | Implemented through normal Pi resource discovery and explicit project trust. |
| Copilot skills and custom agents | Pi skills, prompt templates, extension commands, contributed tools, and background agents | Implemented and discoverable through `/skills`, `/commands`, `/skill:` suggestions, and **Commands and Skills**; tool discovery is not restricted by a fixed allowlist. |
| Native Pi settings | Eight inline common-setting controls at Global Pi/Project Pi scope, with existing native management available through the Command Palette | [Native settings contract](#native-pi-settings). |
| Native runtime settings | Explicit idle foreground steering mode, follow-up mode, auto-compaction and auto-retry setters | [Runtime settings limits](#native-runtime-settings). |
| Native MCP management | Safe configured list with inline enabled/exposure save/reset, native transport/creation controls, separate explicit CLI diagnostic, advanced editor and controlled-terminal auth | [MCP evidence and limits](#native-mcp-management). |
| Native MCP and external tools | Pi's built-in MCP and tools supplied by installed Pi extensions, including third-party MCP bridges | [External-tool boundary](#native-mcp-and-external-tools). |
| Bridge lifecycle safety | New sessions, session replacement and resource reload dispose outgoing subscriptions and cancel pending event-bus requests before API invalidation | [Bridge evidence and limits](#bridge-lifecycle-safety). |
| Claude Code editor awareness | Current file, selection, diagnostics, files, images, and terminal context, plus Pi-callable `vscode_context`, `vscode_code_context` and `vscode_open_file` bridge tools | Implemented through an authenticated loopback bridge and a process-local Pi extension bundled in the VSIX. |
| Claude Code autonomous file/terminal work | Foreground and background sessions use Pi's default edit/write/bash tools | Implemented. |
| Claude Code permission prompts | Pi and installed extensions own permissions; no pi-vscode built-in tool/shell confirmation policy | [Permission boundary](#claude-code-permission-prompts). |
| Claude Code subagents | Multiple independent foreground/background/worktree Pi RPC clients | Implemented local equivalent. |
| Claude Code custom slash commands | Pi extension commands, prompt templates, and skills from `get_commands` | Implemented. |
| Claude Code terminal-style interface | Open the Primary Pi session in an integrated terminal | Implemented. |
| Claude Code subscription/model choice | Pi's provider authentication, subscription OAuth, API keys, model catalog, and thinking levels | Implemented by reusing Pi; provider subscriptions remain provider dependencies. |
| Image-aware chat | Bounded PNG, JPEG, GIF, and WebP RPC image payloads from file selection or Ctrl/Cmd+V paste, with model-capability checks | [Image lifecycle](#image-aware-chat). |
| Provider authentication | Separate native sign-in/sign-out commands; isolated selected Pi helper accepting exactly 1.3.0 or 1.5.2 using public `ModelRuntime`, masked stdin input, explicit host/store approval | [Authentication evidence and limits](#provider-authentication). |
| Session export/import | Existing full-tree HTML renderer, public SDK active-branch JSONL export, validated same-workspace v3-tree import into a retained collision-safe copy | [Session-transfer evidence and limits](#session-exportimport). |
| Reviewed session sharing | Exact active-branch JSONL inspection/redaction, explicit destination and modal upload approval, public `gh gist create --public=false` stdin adapter | [Sharing evidence and limits](#reviewed-session-sharing). |
| Hosted pull-request agent | Foreground/worktree sessions can use installed `git` and `gh` tools to create branches, commits, pushes, and PRs | Local orchestration implemented; GitHub credentials and hosted repository access are external dependencies. |
| Cross-machine cloud synchronization | Exported sessions and Git/remote-provider workflows | Requires an external storage or hosted-agent service; no vendor-neutral synchronization service exists in this local extension. |

## Workflow details and evidence

### Bundled default Pi runtime

Unset, empty, or whitespace-only `pi.executablePath` selects bundled `@earendil-works/pi-coding-agent@1.5.2` without system Pi/Node lookup.
Any nonempty value, including saved `pi`, selects external Pi without rewriting configuration.
Reset removes only the chosen target override; another effective override can still win.
All extension-owned launches share this selection, including helpers and controlled terminal handoff; ordinary terminals are unchanged.

The workspace Extension Host's `process.execPath` starts the pinned absolute npm entry through a bootstrap.
Electron's initial `ELECTRON_RUN_AS_NODE=1` is removed before Pi/tools run.
Bundled launches suppress automatic version checks, clear package/managed-install overrides, and reject initial CLI `update` before upstream import, including custom `npmCommand`.
Extension releases own runtime updates; external launch behavior is unchanged.
Pi 1.5.2 has no built-in TUI `/update` route.

Ordinary Pi stores, credentials, sessions, resources and provider environment are reused without migration or new isolation.
Helpers keep disposable directories and their environment allowlist.
User-installed extensions must support Pi 1.5.2 for bundled launches; broader external runtime compatibility is not verified.
Isolated helpers and direct-shell discovery accept exactly Pi 1.3.0 or 1.5.2, not version ranges.
Canonical resource metadata, safety, approval, and isolation checks remain unchanged.
The minimum VS Code version is 1.146.0, matching the pinned `@types/vscode` declarations.
Pi 1.5.2 public API compatibility and Linux x64 extracted-runtime smoke passed; see [current evidence](BUNDLED_RUNTIME_VALIDATION.md#pi-152-regression-checks).
Earlier Pi 1.3.0 and VS Code 1.140.0 / 1.143.0 validation below is historical and does not establish reruns for these updated dependencies.
Settings opening does not start or validate Pi, and launch failures have no PATH fallback or operation replay.
Trust, tool permissions, Preview/Apply, and ownership rules remain unchanged.

Reload remembers only session paths with a readable saved header and matching workspace; unsaved state clears the previous restore reference.
An absent legacy restore file automatically starts a new session without a confirmation dialog.
A short Sidebar notice reports the recovery; only the restore reference is cleared, without changing existing session files or executable overrides.
Invalid headers, missing header workspaces, permission failures, and invalid bundled assets do not enter this missing-file route.
Bundled Pi fails for those errors; external Pi retains its earlier automatic fresh-session fallback for other restore errors.
Offline regression tests cover automatic bundled and external recovery, Sidebar warning events, preserved session files, changed startup origins, and storage failures.

The universal layout retains the production dependency closure and six native prebuilds for Linux, Windows, and macOS arm64/x64; the unused GPL Doom example is excluded.
Asset inclusion is not a claim that all targets work.
See [Bundled runtime validation](BUNDLED_RUNTIME_VALIDATION.md) for discovery evidence, final-gate status, license disposition, and retained platform/remote/provider handoff.

### Open a worktree in a new window

**Pi: New Worktree in New Window** uses VS Code’s built-in Git extension to create a named branch from the selected repository’s HEAD and open its worktree in a new window.
The command needs a trusted, local desktop workspace and a repository discovered by Source Control.
It does not move sessions or uncommitted changes and does not remove the worktree on close.
See [the worktree instructions](USER_GUIDE.md#open-a-worktree-in-a-new-window) for recovery and shared-folder limits.

### Concurrent Sidebar sessions

One registered Sidebar displays retained per-runtime conversation controllers.
A running ordinary request in A does not block selecting live B, opening an unloaded saved B, or creating C from Sessions.
Sessions rows, View all, native Switch Session, Previous/Next, New Session, Resume Session, and local `/new`/`/resume` use the registry.
Live selection changes presentation only; it does not dispatch RPC `switch_session`, abort A, or release A's request lease.
Cold saved sessions use validated initial-session startup in a separate runtime.
Native Switch and Previous/Next reveal the selected Sidebar conversation even when the retained view is hidden.
An editor-owned file reveals its existing panel instead of creating another writer.
The next cycle command continues from that panel's position without changing the Sidebar binding.

Transcripts, streams, history windows, composer text, attachments, queues, model/thinking state, proposals, checkpoints, and Stop stay with their originating controller.
Opaque entry IDs and view-binding generations reject stale renderer actions; already accepted asynchronous work keeps its captured origin.
Native input/approval dialogs identify their source conversation and remain source-bound across selection changes.

| Host-owned status | Meaning |
| --- | --- |
| Idle | No owned current-window request outcome; saved history does not infer success. |
| Running | Accepted startup/submission, request/tools, retry, compaction, queue draining, or settlement is active. |
| Waiting for input | A live source-bound input/selection/editor/approval request needs a response. |
| Completed | The request settled successfully, including queue reconciliation; content and edits are not certified. |
| Failed | Startup/request failure or unexpected disconnect prevented settlement. |
| Stopped | Explicit cancellation settled. |

Recent Sessions and View all place the status icon before the title.
Automatic saved-session scans run after the request releases its lease and coalesce concurrent completions.
Only Running rotates, and it stays static with reduced motion enabled.
The status name remains in the row tooltip and accessible name.
To check spoken output, use two fixture sessions with different states, one unread, in an isolated VS Code profile with a desktop screen reader.
Focus each row with the keyboard and confirm that it announces the title, status, and any unread result without confusing repetition.
Browser checks cover accessible names, not speech on specific screen-reader and platform combinations.
The unread dot remains separate from the status icon.
Connection, delivery uncertainty, and cleanup warnings remain distinct from these labels.
A settled retained result or actionable failure diagnostic advances one host-memory result revision per owned request.
Token/progress updates, list refreshes, and row selection do not advance it.
Unread clears only for the exact revision rendered in selected conversation detail while the Sidebar is visible and the reader follows the latest output.
Sessions view, hidden views, earlier history, and stale/cross-session acknowledgements cannot clear a newer result.
Transcript New output/Jump to latest remains a separate feature.

One fixed admission pool permits **one Primary plus eight additional interactive runtimes total across Sidebar entries and editor panels**.
Retained idle entries and quarantined cleanup count toward the additional eight; capacity rejection does not evict work or lose a draft.
Saved discovery stays bounded to 100 entries and a 64 MiB metadata-read budget; live entries are merged and deduplicated so they remain selectable.
An additional Sidebar session opens without a confirmation dialog and shares workspace files without worktree isolation.
Auxiliary **Close Session** confirms before stopping its work or discarding unsent memory-only state, retains saved Pi history, and cannot discard protected failed-restore data.
Capacity and writer claims release only after bounded verified cleanup; uncertainty retains reservations and originating canonical-root exclusive-workflow exclusion until reload.

**Primary** is the stable window-service owner, not current display selection.
Terminal environment/handoff/recovery, restart, annotations, editor actions, review/repair/debug, settings/authentication, transfer/sharing, and public bridge broadcast remain Primary-owned.
Auxiliary Sidebar runtimes support ordinary controls but use editor-role restrictions for privileged routes.
Selection and panel focus do not silently retarget global commands.
Ordinary requests retain shared canonical agent leases; direct shell, actual session/resource mutation, Apply, import, and checkpoint restore retain exclusive gates.
Checkpoint overlap safeguards apply to auxiliary Sidebar trackers too.

Hiding or re-resolving the Sidebar does not stop owned work; extension deactivation shuts down owned runtimes.
Activity, unread state, auxiliary transcripts, and auxiliary restore references are memory-only, without additional persistent transcript keys.
Primary keeps its existing restore/cache behavior.
Reload does not automatically restore auxiliary sessions, restart their requests, or replay queues.
Optional composer recovery uses the same consent-gated `SessionDraftStore` and unchanged aggregate limits.

Implementation: `sidebarSessions.ts`, `sessionActivity.ts`, `interactiveSessionSlots.ts`, `sidebar.ts`, `sidebarHtml.ts`, `piRuntime.ts`, and the existing writer, gate, checkpoint, dialog, and draft controllers.
Validation on 2026-11-17 used Node.js 26.8.2 and network-disabled `bwrap` copies with isolated stores/profiles, not a live provider.
The ownership suite passed 71 tests after the 2026-11-18 review fixes, including cancelled submissions, promoted draft ownership, transactional construction, uncertain cleanup, unchanged-binding navigation, and shared image eviction.
Twelve direct-shell lifecycle regressions verify owned settlement and unread results without weakening exclusive admission.
The single-document Sidebar browser fixture verified eight entry bindings, six activity labels, independent Stop, delayed image origins, drafts/reading position, stable focus, and guarded acknowledgements with zero CSP, page, console, or unexpected-network errors.

| Initial full-workflow gate | Result on 2026-11-17 |
| --- | --- |
| Compile and full `npm test` | Passed: 114 files, 1,940 tests passed, three existing skips. |
| Documented Biome 2.5.13 check | Passed with warnings/information; no errors. |
| Full rich-content, thinking-picker, and settings browser suites | Passed; thinking picker covers 864 layout cases. |
| VS Code 1.146.0 native Extension Host, Restricted Mode, and full UI | Passed with deterministic RPC fixtures and a private virtual input seat. |
| Current stable native Extension Host, Restricted Mode, and full UI | Passed; stable was independently resolved to 1.146.0, commit `69047191fc427f2f92828279aae1d90d8eeda7ab`. Offline launchers used that verified cached artifact. |

[Development scenarios](DEVELOPMENT.md#sidebar-concurrency-validation) cover the four requested capabilities and Primary-only limits.
Earlier editor-session evidence below is historical and does not validate the new shared pool or concurrent Sidebar routing.
Full native UI runs verify A-running → saved B cold startup → fresh C → retained A, separate drafts, hidden B unread results, inactive B native input replies, and B-only Stop while A completes.
Retained selection issues zero RPC `switch_session` calls.
Cold first sends and Sessions-composer promotion clear only their exact accepted draft across recovery-owner changes; newer text remains protected.
Review fixes on 2026-11-18 also settle row navigation when cancellation, rejected admission, a no-op, or editor reveal leaves the binding unchanged.
Late completion cannot unlock a newer binding.
Selecting a retained controller resets its image delivery record and resends referenced payloads that remain in its bounded host cache; other state refreshes do not reset that record.
This repairs shared-renderer image eviction without increasing image limits or moving payload ownership between conversations.
Saved-session refreshes accept only the newest scan for the current discovery owner; older or superseded scans cannot replace its index.
The renderer waits for history loading to finish before sending or deduplicating a result acknowledgement.
Shell completion publishes its final controller state before the new result revision, so a preparation snapshot cannot mark the result read.
Actual renderer readiness, including repeated readiness, replays only the selected controller's referenced images without reconnecting an already-connected Primary.
Cold native Switch/Previous/Next initializes a validated Primary location before discovery and preserves trust, terminal-ownership, and writer admission checks.
Busy `/new` and `/resume` use the local navigation path, not a model queue, with attachment and prepared-action guards intact.
A real runtime session replacement keeps nonempty text blocked in host-owned per-entry state until a valid empty composer report.
The block survives view changes and renderer recreation, cannot be cleared by late acceptance, and also guards background launch before and after approval.
First file assignment in a new entry remains valid for cold startup and launcher promotion.
Fourteen dedicated composer-context tests cover these rules and delayed old-context text/empty reports.
A host-owned `composerContext` binds reports and sends to actual session replacements, including replacements while the last reported text is empty.
The browser fixture keeps old nonempty input blocked until clear, even when new host metadata still reports an empty unblocked composer.
Six accepted-submission lifecycle tests cover detached Primary/auxiliary delivery, newer and blocked text, inactive owners, and acceptance after reconstruction.
The browser fixture also checks restored-composer acceptance without a local submission token and rejects old tokens, mismatched host revisions, and repeated acceptance over newer text.
The review-fix run passed all 115 unit files with 2,005 tests and three existing skips, the documented Biome check with no errors, and full rich-content, thinking-picker, and settings browser suites.
New browser checks verify row unlocking after an unchanged-binding reply, image recovery after B evicts A's payload at the 100-image limit, and same-revision acknowledgement after loading finishes, with zero CSP, page, console, or unexpected-network errors.
Nineteen further mock-host cases verify stable saved-to-live cycle positions, Primary checkpoint restoration after display-only Sessions browsing, admitted safety activation before prompts, and local settings at full capacity.
Local command failure, delayed acceptance, invalid arguments, and session details do not allocate or retarget a conversation.
The native checks above are retained initial-PR evidence; they were not rerun for these review fixes.
The fixtures also retain native settings, read-only review, Preview/Apply/Undo, queue, terminal ownership across reload, and explicit text-only draft recovery checks.
Native fixture corrections wait for file-watcher/editor updates and current pickers; they do not retry writes or change production guards.
The configured/imported session store is used when seeding cold B.
Native concurrency runs produce `pi-sidebar-concurrency-before.png` and `pi-sidebar-concurrency-sessions.png` in the test temporary directory for visual review.

#### External handoff

| Responsible role | Prerequisite and action | Expected result / unverified behavior | Restriction |
| --- | --- | --- | --- |
| macOS/Windows maintainers | Use disposable native profiles and repeat concurrency, source-bound input, shortcuts, Stop, and cleanup fixtures. | Equivalent UI routing and process lifecycle; platform input and descendant cleanup remain unverified here. | Do not infer platform validation from Linux/WSL; preserve Windows cleanup warnings. |
| Remote maintainers | Use an authorized Remote SSH/WSL/container workspace with disposable stores and repeat the fixtures. | Processes and discovery stay on the workspace Extension Host; remote behavior remains unverified. | Local Linux under WSL is not Remote WSL evidence. |
| Accessibility/product reviewer | Review the generated before/workflow captures and keyboard/focus evidence with real assistive technology. | Understandable activity/unread semantics without lost focus or excessive announcements; subjective usability and actual announcements remain unverified. | DOM/native keyboard checks are not screen-reader acceptance. |
| Account owner | Obtain separate authorization before live-provider or account validation. | Provider behavior and external service effects remain unverified by deterministic fixtures. | No login, live calls, uploads, existing-profile installation, or publication was performed. |

No packaging or distribution change was needed; no VSIX, installation, publication, or live-provider validation is claimed for this change.

### Concurrent interactive editor sessions

**Pi: New Concurrent Session** (`pi.newConcurrentSession`) and the Pi view-title **+** open independent native `WebviewPanel` sessions.
Each opening requires a trusted, file-backed workspace and confirmation that concurrent sessions share files without isolation.
The opened workspace URI is retained for folder lookup, scoped settings, and reconnect; a separate verified canonical root owns filesystem checks and operation locks.
Editor runtime startup and ordinary prompt dispatch check the original folder registration and canonical root, including after asynchronous preparation.
Removing the original folder or changing its root fails closed instead of selecting the first workspace folder.
Editor panels share at most eight additional runtime slots with auxiliary Sidebar conversations alongside the stable Primary runtime.
Each panel owns its RPC process, transcript, composer draft, attachments, queue, model/thinking controls, and Stop.
Hiding a panel or switching tabs does not stop work; closing it shuts down only its runtime and retains saved Pi session files.
A normal close frees its slot after every pending bounded stop settles; cleanup-unverified closes retain their slot and writer claim until window reload.
An unverified RPC cleanup result also leaves a canonical-root reservation that blocks exclusive workspace operations until reload, including when no request lease remains.
Ordinary shared agents can continue, but active and later requests receive unverified checkpoint attribution for that root.
The shared eight-additional-runtime bound includes retained idle entries and quarantined closed sessions.
Inspect and stop residual processes before reloading; no request is retried automatically.

Panels have no serializer and do not restore or restart automatically after reload.
A saved session can resume through the sidebar after its panel closes and writer cleanup is verified.
Panel transcript caches and restore references are memory-only and bypass the sidebar's persisted keys.
Optional text recovery uses one shared consent-gated `SessionDraftStore`, with the existing aggregate limits and Disable/discard-all semantics.
Existing Pi credentials, configuration, and session storage remain shared; separate runtimes are not a sandbox.

Sidebar navigation commands select entries through the registry; editor-panel focus does not redirect them.
Other global integrations, including editor actions, review, and repair, stay Primary-bound.
Panel **More…** omits Primary-only transfer/sharing, authentication, review/repair/debug, compatibility, terminal handoff/recovery, and restart routes.
The runtime host also rejects editor-panel terminal, restart, and annotation requests.
Per-panel native model and thinking pickers remain available.

One in-window canonical session-file registry prevents duplicate RPC starts and switches, retaining reservations when cleanup is uncertain.
Other windows and external processes are not locked; this is not a universal upstream cross-process lock.
Ordinary interactive requests share workspace agent leases; direct shell, controls, Apply, import, and restore remain exclusive.
Active background tasks retain the existing exclusive gate in their canonical workspace.
Overlapping requests and later operations from another owner conservatively invalidate checkpoint restoration without discarding failed-restore snapshots.
Native extension dialogs share one origin-bound controller and one owned multiline editor across all runtimes.
The shared log uses client generations unique across runtimes and retains at most 32 warning-suppression generations.

Implementation: `concurrentSessions.ts`, `sidebar.ts`, `piRuntime.ts`, `sessionWriters.ts`, and the shared operation, checkpoint, dialog, draft, and logging controllers.

#### Earlier editor-session validation

The following evidence predates Sidebar concurrency and shared admission across both surfaces.
Offline host regression tests cover simultaneous requests, separate transcript and Stop routing, close/startup races, capacity and cleanup quarantine, single-writer reservations, deletion races, shared drafts, and origin-bound dialogs.
The full unit suite and host/browser compilation passed with locked dependencies and one test worker.
`npm run test:rich-content` passed with two independent Chromium documents using the bundled renderer.
The concurrency fixture verifies initial detail mode, hidden Sessions navigation, separate drafts, interleaved streams, and per-document Stop, with no CSP violations, page errors, or external requests.
The documented `biome check src resources` check passed with warnings and no errors.
A one-off macOS VS Code 1.146.0 native screenshot check used a disposable development profile and deterministic RPC fixture, without extension installation or model calls.
It verified native session-opening confirmation, two split editor panels with distinct session IDs and active requests, separate drafts, and Stop in one panel while the other kept working.
Post-review host regressions cover opened workspace aliases, multi-root reconnect, accepted queue recovery, already-detached stop completion, late capacity warnings, and exclusive exclusion after unverified cleanup.
Queue recovery tests also cover equal text with distinct image snapshots in Next and After this, with both reported and unreported pending records.
A post-review macOS VS Code 1.146.0 check opened the workspace through a directory symlink and verified two native panels, distinct session IDs, concurrent requests, and independent Stop with the same offline fixture.
These focused checks are not a complete native UI suite.
The alias fixture selects a junction on Windows; this local run tested a macOS symlink only.
Remote, other platforms, reload, and live-provider behavior remain unverified for this change.

### Fixed primary composer status

One permanent area stays inside the composer above its box, outside transcript/workflow scroll, at the same location in Sessions and conversations.
Idle reserves one line without Ready text or a dot; long actionable text/buttons can wrap and grow.

The priority is problems > submission blockers > progress > non-Ready results > quiet idle.
Stop stays in composer actions; Reconnect/Retry/Refresh history keep host availability checks.
Fixed-status unit/browser checks and full Linux native UI suites passed on VS Code 1.106.0 / 1.142.0; see [Composer behavior and validation](COMPOSER_UX.md) for geometry, reading-position and coverage limits.

### Visible submission blockers

Neutral empty input cannot replace progress.
Nonlive `#composer-status` describes input/Send/After this separately from the single polite, atomic `#status` live region; no duplicate visible row or announcements.
Host authorization is unchanged.
Unit/browser and Linux native UI checks passed for the new placement and descriptions; real screen-reader announcements remain unverified.

### Latest-output navigation

Unchanged message articles, selected text and completed rich content stay in place when messages arrive.
Retained reading anchors survive history trimming.
Unit and offline Chromium regressions cover append, batched history diagrams, delayed Mermaid layout and acceptance focus; native/remote checks were not rerun.

### Panel clipboard and send feedback

Copy requests are bounded to 8,000 characters with correlated results and stale-view checks.
Disabled/read-only composers reject image paste.
Acceptance preserves newer drafts and transcript focus; IME commit Enter is not Send.
Unit regressions cover these paths.
Native OS/remote clipboard and live-provider timing were not checked.

### Operation diagnostics

The shared log uses safe technical categories, operation IDs, generations and built-in VS Code levels.
Implementation: `logging.ts`, `extension.ts`, runtime/RPC/Sidebar/inline-completion integration; typed metadata, bounded records and warning suppression.
Log files can outlive a window; review before sharing.
No raw conversation/errors/stdio, automatic Output opening or telemetry.
Windows/macOS and Remote SSH/WSL/container routing/focus require environment-specific checks.

### Text draft recovery

Implementation: `sessionDraftStore.ts`, `sessionDraftController.ts`, `composerDraftHtml.ts`; revision/view/session binding, no automatic replay or attachment persistence.
Primary, auxiliary Sidebar, and editor-session composers share consent, aggregate storage bounds, and Disable/discard-all state.
Disabling recovery invalidates pending consent and stale draft bindings across subscribed views.
The shared store tracks a memory-only writer identity for each retained record.
Accepted sends remove a record only when the captured binding still owns it; equal text, revisions, or timestamps cannot clear another view's saved draft.
Offline regressions cover late acceptance, shared writers, replacement-view recovery offers, and the unchanged persistence envelope.
Earlier storage evidence below does not validate this multi-view behavior.
Recorded native checks verify active-row placement and Disable in Linux desktop SQLite on VS Code 1.106.0 / 1.142.0.
Earlier web-remote client IndexedDB evidence predates this relocation; remote controls were not rerun.

### Discoverable file context and accessible messages

Passive canonical workspace metadata only; capture still requires selection and explicit Send.
Reply headings show only `Pi` and retain numbered accessible names and focus during streaming and history updates.
Earlier Orca evidence applies to the previous layout; this relocation needs separate screen-reader validation.
Automated accessibility assertions are not audible or human-usability checks.

### Transcript code wrapping

CSS-only presentation for transcript code/source fallbacks; scroll position and bottom following are preserved.
Shell cards, widgets, source/copy text and editor files are unchanged.
No saved configuration is added.

### Bounded conversation search/history

Implementation: `conversationHistory.ts`, `conversationHistoryHtml.ts`; at most 100 messages / 250,000 shared text/thinking characters and 1,000 match ranges.
Persistent Pi RPC single lines allow 64 MiB instead of 5 MiB, with unchanged LF framing, decoded UTF-8 byte counting and CRLF handling; larger frames are rejected.
Public `get_messages` still returns the full active branch without pagination, JSONL reads or model calls.
Initial load and settlement still use the full response.
Repeat navigation can reuse up to three prepared display windows of an unchanged text-only snapshot within the in-memory budget.
One visibility and message-count pass supplies all prepared windows.
A cache miss, new session or work, process replacement, or explicit Refresh requires an authoritative fetch.
Full-response decoding and synchronous JSON parsing can still increase memory use and pause the Extension Host.
Locally typed frame-too-large errors produce an allowlisted Output category and a fixed Sidebar notice, without raw frame, error or path data.
The first fatal decoder failure stops decoding and releases retained input; the client ignores later stdout while bounded cleanup completes.
New RPC commands and dialog replies are rejected before they can write to that failed client.
History failures preserve existing session references and files, without automatic new-session fallback or request replay.
Bridge frames remain limited to 1 MiB and one-shot Pi output to 5 MiB; attachment and session import/export limits are unchanged.
Omitted long-message text is labelled, not retrievable here.
See [Composer behavior and validation](COMPOSER_UX.md).

### Sidebar slash commands

Typing `/` in either Sidebar composer shows local commands before Pi connects and does not start Pi.
The fixed shortcuts are `/new`, `/model`, `/thinking`, `/settings`, `/extension-settings`, `/skills`, `/commands`, `/resume`, `/session`, `/reconnect`, `/compact`, and `/reload`.
Settings and Conversation details shortcuts remain process-free.
Runtime controls connect only on explicit submission and retain their existing host guards.
`/skills` filters Pi's public `get_commands` by `source: "skill"`; `/commands` includes all discovered resource types.
There is no independent filesystem scan or project-resource approval change.
Resource selection inserts a revision- and draft-bound command without sending it.
The connected menu labels Sidebar, Skill, Prompt, and Extension entries and hides reserved internal controls.
Local names take precedence over duplicate Pi commands.
Only `/compact` accepts inline arguments; existing native controls handle other values.
Attachments and prepared editor actions block registry-routed `/new` and `/resume`, but another conversation's ordinary request, queue, or dialog does not.
Other local commands retain their originating runtime's idle and mutation guards.

Evidence: `slashCommands.ts`, `slashCommands.test.ts`, `sidebarHtml.test.ts`, `composerDraftHtml.test.ts`, and the offline Chromium fixtures cover routing, cold suggestions, skill filtering, cancellation, stale pickers, bounded cold-start handoffs, draft preservation, and narrow menus.
Native Extension Host, remote, other-platform, and live-provider slash command checks remain unverified.

### Temporary passage annotations

Primary Sidebar `vscode_annotate` adds whole-line highlights, literal hovers and read-only native comments below marked ranges.
Auxiliary Sidebar and concurrent editor runtimes cannot authorize annotations.
Comments are grouped at the range end line and show **Pi** as author and **Pi annotation** as label.
Literal untrusted explanations also appear in the Comments panel.

- `pi.annotations.initialState` is `collapsed` by default or `expanded`.
  Set it through **VS Code Settings → Pi → Editor → Annotation initial state**.
  It affects only newly created or replaced annotations.
  Existing handles and user state on redraw are unchanged; user collapse survives redraw.
- Clear Annotations removes decorations and threads locally.
  State is memory-only.
- Trust, authentication, stale checks, schema, limits and results are unchanged.
  `count` counts annotations, not groups.
  `visible` means a visible editor exists, not that a widget is visible.
- Native expansion, replacement or removal may auto-open Comments and change layout or visible range/scroll.
  The extension does not write files, open documents/tabs, perform explicit tab/selection/focus/reveal/scroll operations, or write global VS Code comments settings.
  Comments visibility settings may hide widgets.
- Edits/close and session/resource/client transitions clear annotations and pending calls.
  Terminal/background credentials remain insufficient.

Earlier controller/tool regression tests and Linux x64 native Extension Host, production `annotations` and separate `annotation-prototype` fixtures passed on VS Code 1.140.0 / 1.143.0 with initially expanded threads.
Before the native Settings routing change, the updated production fixture also passed on both versions for default-collapsed display, click-to-open, custom Pi Settings selection/reset and retained state.
Unit tests and standalone Settings/rich-content browser checks passed for that earlier annotation change; they do not verify the new native Settings route.
See [Native annotation thread feasibility](ANNOTATION_THREAD_FEASIBILITY.md) for commands, coverage and historical failures.
Remote, Windows/macOS, accessibility and live-provider checks remain unverified.

### Native Pi extension dialogs

Public RPC `input` stays single-line; `editor` opens an explicitly accepted non-secret multiline document with owned Submit/Cancel.
Timed confirmations use full read-only review before Allow; untimed permission modals are unchanged.

Implementation: `extensionDialogRequests.ts`, `extensionUiDialogs.ts`, origin-bound runtime handles, unit and deterministic native UI fixtures.
One active multiline editor request across sidebar and editor runtimes / 100,000 characters; cancellation never returns partial text.
The singleton controller subscribes to each runtime and keeps replies bound to their origin.
VS Code can retain untitled hot-exit backups; Save is not Submit.
No credential-editor claim or arbitrary TUI component support.

### Approved Pi resource reload and restart

Implementation: `piRuntimeControl.ts`, packaged `pi-control.ts`, read-only sentinel and fail-closed input guard; read-only command ownership discovery, handled acknowledgements, canonical/trust/dialog/queue locks, strict refresh, uncertain disconnect without replay.
Pi 1.3.0 offline reference fixture passes repeated reload.

### Pi session branches

Typed RPC and public `ctx.navigateTree()` command; stable IDs, stale leaf/client/session checks, shared sidebar transition and revision-safe draft insertion.
Includes abandoned user forks.
Navigation alone is not durable across restart; no filesystem/Git restore or automatic summary generation.

### Pi terminal compatibility and ownership

Stops the RPC writer before launch; retains canonical operation ownership until explicit return/uncertainty confirmation.
Paths with spaces use argv arrays.
Custom TUI components/renderers/themes remain terminal-only; no PTY/browser protocol.
Unit/browser and isolated Pi reference evidence in [Pi control validation](PI_CONTROL_VALIDATION.md); minimum/current Linux native, alias and packaged ownership checks pass; real interactive TUI, other-platform and remote behavior remain unverified.
See [Native parity validation](NATIVE_PARITY_VALIDATION.md).

### Windows Pi process launches

Implementation: `piSpawn.ts`, `piProcess.ts`, both launch clients, and native Windows fixture tests.
Custom batch wrappers are rejected.
Root termination is bounded; Windows descendant cleanup remains explicitly unverified.
Foreground deletion and startup-failure tests verify that cleanup warnings reach runtime listeners before the old client is released.

### Git change review

Implementation: `gitSnapshots.ts`, `gitReview.ts`, `reviewFindings.ts`; real Git fixtures and host/controller tests.
Staged commands use the current `pi.*` identifiers; hosted PR APIs excluded.

### Semantic code context

Implementation: `semanticContext.ts`, `sidebarAttachments.ts`, `vscodeBridge.ts`; bounded, trusted, same-workspace results, cancellation and authenticated bridge tests.
No repository index or embeddings.

### Workspace diagnostic repair

Implementation: `workspaceDiagnostics.ts`, `workspaceDiagnosticsController.ts`, `editProposalController.ts`; strict parsing, stale/writable checks, native multi-file edit and Undo evidence.
Diagnostic disappearance is not test evidence.

### Selective application

Implementation: `editHunks.ts`, `editProposals.ts`, `editProposalController.ts`; selected-preview/one-workspace-edit and stale-version tests.
No automatic rebase.

### Composer file completion

Implementation: `composerFileToken.ts`, `sidebarFileCompletion.ts`, `sidebarAttachments.ts`, `composerFileCompletionHtml.ts`; parser/protocol/host regressions and browser fixtures.
Native UI fixtures cover dirty snapshots, inspection, failed capture, path insertion and explicit single Send; minimum/current Linux native, workspace-alias and packaged fixtures pass; see [Native parity validation](NATIVE_PARITY_VALIDATION.md).
Search is bounded to configured VS Code exclusions and common generated directories, not `.gitignore`.
VS Code narrows nonempty queries before returning up to 2,000 paths; the host rechecks the literal match before showing up to 30 validated results.
Context-sensitive case variants, such as Greek sigma, can consume places in the native cap without matching the final literal check.
No Pi API or model request is used for completion.

### Context inspection

Implementation: `contextInspector.ts`, `sidebarAttachments.ts`; revision-safe consumed-item tests.
Estimates exclude Pi history/instructions/future reads; image usage unknown.

### Failed-test repair

Implementation: `testRepair.ts`, `testRepairController.ts`; real failing Node test repaired/rerun with fixture response.
Two attempts, one source file; no private Test Explorer API.

### Request checkpoints

Implementation: `checkpointCapture.ts`, `checkpointCaptureHost.ts`, `checkpointWorker.ts`, `changeTracker.ts`, and `checkpointHistory.ts`.
Small workspaces use bounded batches for capture and settlement; larger workspaces share one checkpoint worker per Extension Host.
The request keeps its workspace lease until settlement completes or is discarded.
A second bounded check of matched files determines whether the inline Revert action is available; stale matches stay available for inspection.
Stop cancels capture before prompt dispatch without aborting an idle Pi client.
Offline tests cover capture limits, editor changes, concurrent ownership, worker failure, and Stop followed by a successful request.
Memory-only; no creations/deletions/shell rollback.
Concurrent-session safety invalidates current attribution on overlapping agent leases and historical restoration on later operations from another owner.
Invalidation retains failed-restore snapshots under the existing storage and lifecycle limits; it does not establish attribution for external writers.

### Direct shell

Compatibility with exactly Pi 1.3.0 or 1.5.2 uses canonical packaged read-only sentinel version metadata, without an execution probe or approval handshake.
Read-only proposal enforcement remains active.
`!!` excludes model context, not Pi history or exports.
Attachments and queues are rejected; shell effects are non-restorable.
Lost abort/final evidence disconnects without replay.
Earlier unit/browser/native and packaged results in [Native parity validation](NATIVE_PARITY_VALIDATION.md) are historical; they do not validate this permission change.
Interactive TUI, remote and other-platform checks remain unverified.

### In-flight instructions

Implementation: `piRpcClient.ts`, `piRuntime.ts`, `sidebar.ts`, `sidebarAttachments.ts`, `sidebarHtml.ts`; deterministic RPC/lifecycle/attachment/keyboard fixtures.
Ordinary composer text, text context and images are supported; only Pi's authoritative user-message start promotes a queued item to the transcript, and unsupported/uncertain delivery disconnects without replay.
Pi queue grouping settings remain native.

### Debug-context questions

Implementation: `debugContext.ts`, `debugContextController.ts`; fake DAP/host invalidation tests.
Only checked js-debug read paths; no evaluate/recursive capture.

### Pi Settings

The Pi view title's native **⋯** overflow menu contains **Extension Settings** then **Pi Configuration**, directly in the same configuration group.
There is no standalone settings gear or settings submenu, and composer **More…** has no duplicate entries for these commands.
**Pi: Extension Settings** (`pi.openSettings`) opens native VS Code Settings filtered to `@ext:narumi.narumi-pi`, without a custom `pi.*` form or Pi launch.
General, Permissions, and Editor group all 11 existing settings without changing IDs, defaults, types, bounds, declared scopes, or runtime behavior.
VS Code owns save-on-edit, validation, draft handling, scope selection, native array controls, search, configured-value indicators, and Reset menus.
The former custom page's 4,096-character string, 100-item list, and 16 KiB serialized-list edit limits do not apply to native Settings.
Native Settings editability is not a runtime authorization check; untrusted launch and resource activation remain blocked by host guards independently of `pi.approveProjectResources` editing.

**Pi: Pi Configuration** (`pi.openPiConfiguration`) opens a dedicated singleton panel.
Repeated invocation reveals it.
Save to selects Global Pi or Project Pi, with Project Pi identified as the first workspace folder's `.pi` directory.
Model groups manual Provider ID, Model ID, thinking level, and ordered patterns; Behavior groups steering, follow-up, compaction, and retry; MCP groups safe configured-server metadata.
The panel has one Open Extension Settings action and no User/Workspace selector or duplicate General/Permissions/Editor controls.
Inherited rows show read-only values with one source label, Inherited from Global or Pi default.
Set global override or Set project override opens a local draft initialized from the displayed value without a file write.
Saved Global override or Project override rows remain editable, with a separate unsaved-draft indicator.
Save stays visible in editable rows, disabled without a draft, while pending, or when stale; it does not hide after a successful override save.
Select, checkbox, and MCP metadata changes create drafts, not immediate writes; same-value overrides remain valid.
Discard changes removes only the local draft, not a saved override.
Remove global override or Remove project override and Reload row are in the row actions menu; stale drafts also show an inline Reload row recovery action.
Removal resets only the saved selected-scope member and is disabled without an override, or while pending or stale.
Opening or closing the keyboard-accessible menu preserves drafts.
Failed saves and scope changes preserve drafts by scope and key; stale drafts require explicit Reload row.
Secondary Reload saved values reads saved values and preserves unrelated drafts; it does not reload Pi resources.
Advanced contains Open Pi settings dialog… and Manage MCP servers…, retaining the existing native dialog routes.
One warning identifies inactive Project overrides; Review project approval setting only opens native `pi.approveProjectResources` Settings.
Inherited Global values are not flagged inactive, and neither saved nor draft values are verified current-session values.
One shared save/restart explanation replaces repeated row text; file locations and precedence remain in expandable help.
Restart Pi… is a separate fixed host route to the existing confirmed restart, not a Save side effect.
Cancellation or failure retains saved files and drafts; failure reports runtime uncertainty, and resumed-session values or launch overrides can still take precedence.
Bounded restart ID/status recovery and host result replay preserve feedback after hide/reveal without storing authority or repeating the action.
There is no Save All or Reset All.
The webview receives validated allowlisted common-setting values, safe MCP metadata, opaque revision tokens, and a host-owned restart action token, not raw files, unlisted settings, or MCP transport/authentication fields.
Full snapshots stay in Extension Host memory; native webview persistence contains only bounded validated common-setting drafts, not complete snapshots or MCP data.
Trust, canonical paths, dirty-buffer checks, member-level patches, and revision checks remain required for native file operations.
No duplicate schema, new VS Code keys, higher minimum VS Code version, passive Pi launch, automatic file write, live apply, automatic restart, approval, or connection is added.
`pi.openNativeSettings` and `pi.openNativeMcp` retain their existing native management dialogs.

Historical inline-form evidence: offline model/host tests and the settings browser fixture covered inline controls, native scopes, inheritance, reset, stale drafts, bounds, secret exclusion, keyboard focus, themes, and layout.
The earlier macOS arm64 Extension Host fixture exercised the production form protocol and cold operation owner on VS Code 1.140.0 and 1.143.0.
These results predate the native Settings route and compact Pi Configuration layout and do not validate them.
Historical native Settings route and compact-layout evidence: the offline suite passed 99 test files with 1,466 tests passed and three skipped on macOS arm64.
The following results predate the configuration usability change and do not validate the revised controls or host routes.
The standalone Settings browser fixture passed explicit saves, menus, stale recovery and focus, bounded draft migration, secret exclusion, CSP, and 24 width/theme combinations; rich-content checks also passed.
Native Extension Host checks passed on VS Code 1.140.0 and 1.143.0, including separate Restricted Mode runs that rejected process launches.
Focused native UI checks passed on both versions for all 11 controls, native array edits, category labels, User/Workspace save-on-edit and scoped Reset, plus the separate Pi Configuration singleton, three native themes, draft recovery, keyboard actions, explicit file Save and Reset, and focus return.
These checks used disposable local profiles and fixture responses, not a live provider or external MCP server.
A local VSIX package and extracted bundled-runtime smoke check passed with a single test worker; the first concurrent package attempt hit an existing RPC fixture timeout.
Virtual-workspace rejection has unit coverage, not a native virtual-window run.
Full Linux UI and annotation suites, Windows native behavior, actual remote-user targets, Remote SSH/WSL/container, screen readers, live providers, and external MCP servers were not checked in that historical run.

Historical upstream overflow-menu evidence: Linux x64 unit checks passed 1,494 tests with three skipped across 99 files; Settings browser and rich-content checks passed.
Focused native UI checks passed on VS Code 1.140.0 and 1.143.0 for the ordered direct menu entries, keyboard opening/Escape, both destinations, the cross-link, and no standalone gear.
Both commands declare gear icons; the tested native overflow menus render text labels without icons.
Passive settings routes did not start Pi; menu checks followed one fixture sidebar startup and added no process or model request.
Remote, native virtual-workspace, Windows/macOS, real screen-reader, live-provider, and installed-package UI checks were not run for that overflow-menu change.
These results do not validate the merged source.

Merged configuration usability and overflow-menu validation passed on Linux: 102 test files with 1,596 tests passed and three skipped, settings/rich-content browser suites, and minimum-version native Extension Host and Restricted Mode checks.
Focused native Settings UI checks passed on VS Code 1.140.0 and stable 1.143.0 for all 11 native controls and all eight Pi file controls at both scopes.
The settings browser matrix passed 36 row-menu states and 18 Advanced menu layouts in three themes, including restart feedback recovery, scoped removal, local discard, and stale-draft recovery.
These checks were rerun after merging `origin/main` (`37758e4`), including the adjacent ordered menu entries, renamed cross-link, keyboard opening/Escape, and no additional process or model request after the fixture sidebar startup.
See [Current validation](NATIVE_CONFIGURATION.md#current-validation) for commands and local captures, and [External handoff](NATIVE_CONFIGURATION.md#external-handoff) for unverified usability, platform, remote, and screen-reader checks.

### Pi extension status and text widgets

Implementation: `sidebarExtensionUi.ts`, `sidebar.ts`, `sidebarHtml.ts`; bounded parser, flood, current-client lifecycle, panel re-resolution and 224 browser layout/keyboard fixtures.
The cleanup passed Linux native checks on VS Code 1.106.0 / 1.142.0.
Earlier workspace-alias and packaged-install evidence predates this relocation; see [Native parity validation](NATIVE_PARITY_VALIDATION.md).
Public Pi 1.3.0 RPC reference; no snapshot endpoint, terminal component factories, ANSI styling or verified extension identity.
Unsupported runtimes show no extension area.

### Thinking blocks

Implementation: `piMessages.ts`, `sidebarAssistantStream.ts`, `sidebarState.ts`, `sidebarHtml.ts`; indexed replacement, lifecycle, bounds, persistence exclusion, and browser keyboard/theme/focus/scroll fixtures.
Public Pi 1.3.0 shapes are the reference, not a new minimum.
Missing thinking is not an error; hidden reasoning and opaque signatures are not displayed.
Minimum/current Linux native, workspace-alias and packaged fixtures pass, including history recovery after reload; see [Native parity validation](NATIVE_PARITY_VALIDATION.md).

### Rich panel responses

Implementation: `markdown.ts`, `webview/richContent.mts`; renderer tests, headless CSP/lifecycle/layout checks, and VS Code 1.106.0 native UI fixtures.
Mermaid is a bundled asset loaded on first eligible use; failed loading leaves the source visible.
Unchanged completed code and diagram nodes can survive streaming text updates; otherwise, the Webview sanitizes and replaces the entire message.
Rendering remains bounded, with no raw HTML, full TeX documents, arbitrary Mermaid configuration, or terminal-renderer parity.

### Codex side-by-side chat panel

The quiet idle composer has an attachment icon and combined model/thinking button, on-demand details, full-image thumbnails and keyboard preview, bounded prose, fixed primary status and separate Stop.
Blocking errors/cleanup warnings retain a separate non-dismissible notice and diagnostic action.

Implementation: `src/sidebar.ts`, `src/sidebarHtml.ts`, `scripts/interface-fixture.mjs`, `scripts/fixed-status-fixture.mjs`; fixed-status unit/browser checks and full Linux native UI suites passed on VS Code 1.106.0 / 1.142.0.
Client Windows/macOS, remote, and real assistive-technology checks were not rerun.

### Codex context from open files and selections

Implemented with item, size, and total bounds.
Ask About Selection, the Ask Pi code action, and Ctrl+Alt+A (Cmd+Alt+A on macOS) stage selected text as an unsent reference in the stable Primary session's composer.
Capture happens before view focus changes the active editor.
File and precise line/column labels keep same-line selections distinct; repeat capture of the same range replaces its snapshot.
Users can add multiple references, remove each one, and describe the requested work before explicit Send.
The current session, history, and composer draft are retained; no separate question input or immediate model request is used.
Busy-session ordinary Ask reference capture uses the existing composer queue only after explicit submission.
Modify, Explain, Fix, Review, Document, and Generate Tests prepare a labelled read-only action with a visible default description and Cancel.
Modify requires a user description; other presets combine their fixed request with optional composer details on Send.
The host binds these actions to opaque IDs, required references, source validation, and the current session.
Cancellation keeps references and text; changed references/session identity invalidate the action, and stale IDs never fall back to ordinary requests.
Prepared read-only actions cannot queue, run shell/slash commands, start background work, or submit through the Sessions new-session route.
Preview actions keep read-only generation and existing native Preview/Apply checks; no editor action writes files at preparation.
Offline command/host/browser regressions cover all menu entries, source changes, ID/reference/session invalidation, cancellation, retry policy, busy submission guards, asynchronous preparation/approval races, and rejection of incomplete required references.
The isolated native `selection` fixture checks first-open staging, draft/focus, keyboard capture, multiple references, removal, every menu preset, explicit read-only Preview/Apply/Undo, session/history retention, busy policy guards, and ordinary queue acceptance; it does not simulate queued execution.
The focused fixture passed on Linux VS Code 1.140.0 with fixture Pi only, and the rich-content browser suite passed.
Other platforms, remote hosts, and live providers were not checked for this change.

### Codex cloud task review locally

Implementation: `backgroundResults.ts`, `backgroundAgents.ts`; Git, partial-failure and metadata/reload tests.
Legacy tasks without verified origin cannot import; model test claims are not evidence.

### Copilot change review and revert

Each foreground tool call appears at its conversation position, collapsed by default during execution and after completion.
Manual disclosure choices survive output updates and history refresh.
Pi history restores retained calls; tool payloads are not cached in VS Code workspace storage.
At most 30 calls share transcript bounds.
History window boundaries keep source groups together for Earlier navigation.
An oversized single source keeps the assistant answer before tool details.
Proposals, changed files, and background agents remain in the workflow area.
Covered pre-captured regular edit/write files only; shell and uncertain effects require Source Control review.

### Native Pi settings

Global Pi uses Extension Host `~/.pi/agent` or `PI_CODING_AGENT_DIR`; Project Pi uses the launch workspace's `.pi` (first workspace folder, no multi-root selection).
Trusted, file-backed workspace required.
Provider ID and Model ID use manual text inputs; startup thinking level uses a select; scoped model patterns use ordered multiline input, one pattern per line.
Steering and follow-up modes select `one-at-a-time` or `all`; automatic compaction and retry use checkboxes.
Provider/model entry uses the approved manual fallback because cached `availableModels` has no independently verified workspace/session origin.
No cache projection, catalog fetch, model-discovery RPC, helper, or credential read is added.
Unapproved saved Project overrides are labelled inactive, not active runtime settings; inherited Global values are not flagged inactive.
Reads, opening, switching scopes, opening an override draft, and discarding drafts create nothing; the first explicit override save creates only the needed file and missing Pi directories; absent reset creates nothing.
The form and native dialogs reuse guarded selected-member writes, retaining inheritance, canonical gates, editor guards and stale-content/identity checks.
Save does not restart, approve or connect.
Existing `settings.json` and `mcp.json` have an advanced editor with a warning and normal VS Code Save/backups; absent files need a common-control save first.
Startup model patterns require explicit restart and are not access control.

### Native runtime settings

Typed public RPC setters also request Global Pi persistence; acknowledgment does not verify disk durability.
Queue modes/compaction project from `get_state`; retry state is unknown.

### Native MCP management

The configured list exposes validated name, transport type, source, enabled state, and exposure metadata, with inline enabled/exposure edits and explicit save/reset at the selected native scope.
Configured state is separate from connection state, which remains unknown.
The Project Pi form and native dialogs include inactive project entries with approval off, without activation by editing.
Project metadata overrides preserve inherited transport and credentials.
Server creation, transport editing, credentials, authentication, diagnostics, and advanced editing remain in existing explicit native management interfaces.
An advanced editor is available for existing `mcp.json`; interactive auth uses the controlled terminal.

Implementation: `nativeMcpDiagnostics.ts`; credentials/env/header/command values withheld, no auth-file reads or discovery connections.
Current-session state remains unknown; CLI checks require execution/network approval and saved native trust can differ.
`/mcp` ownership is checked before terminal guidance.
Actual Pi local stdio fixtures verify direct/deferred/codemode/hidden/per-tool exposure, resources, replacement/disabled ownership, errors and read-only denial.
Full in-panel OAuth/live state remains unsupported; see [Native configuration contract](NATIVE_CONFIGURATION.md) and [Native parity validation](NATIVE_PARITY_VALIDATION.md).

### Native MCP and external tools

Inherited through Pi, not an Extension Host MCP client.
Each server/bridge is a separate dependency.
Server annotations are unverified; Pi and installed extensions own permissions, including MCP tool permissions.

### Bridge lifecycle safety

Implementation: `resources/pi-bridge.ts`, `piBridgeLifecycle.test.ts`, and the offline Pi 1.3.0 `scripts/test-bridge-lifecycle-reference.mjs` check.
Late callbacks cannot emit into an outgoing runtime or replacement session; current connection failures retain disconnect events.
No automatic restart or request replay.
Native UI, macOS, remote and live-provider behavior are separate checks.

### Claude Code permission prompts

Tools and commands can run without confirmation when no policy is installed.
Existing Pi-requested dialogs are displayed unchanged; workflow safeguards remain separate.

### Image-aware chat

Submitted images remain on the consuming user turn as responsive thumbnails with keyboard preview.
Stable content IDs merge local labels after history refresh; bounded one-shot caches keep Base64 out of routine state/storage, and missing bytes degrade to labeled placeholders.

### Provider authentication

Implementation: `providerAuth.ts`, `isolatedPi.ts`, `resources/pi-isolated-helper.ts`; fake provider/browser/device/manual-redirect/cancellation and secret-free diagnostic fixtures.
Built-in provider metadata only; generic prompt labels.
Native dialog fixtures pass on minimum/current Linux, aliases and packaged builds.
No all-provider/live/remote authorization claim.
Explicit restart refreshes a running Pi; sign-out does not revoke provider access or unset environment credentials.

### Session export/import

Implementation: `sessionTransfer.ts`, `sessionTransferController.ts`, `piRuntime.ts`; bounded format/tree/reference/image validation, exclusive writes, stale/cancelled/failed activation fixtures, expired-client/execution history rejection, verified imported-history display under ownership, and unsaved-origin import.
Native dialogs pass on minimum/current Linux, aliases and packaged builds.
A network-free SDK comparison for an explicit supported Pi 1.3.0 or 1.5.2 installation is available through `scripts/test-isolated-sdk.mjs`.
Full-tree JSONL export and legacy migration are not implemented.

### Reviewed session sharing

Implementation: `sessionShare.ts`; fixture CLI captures exact payload/argv, validates returned gist URLs, and rejects uncertain completion without replay.
At most 2 MiB; non-public gists are link-readable, not confidential.
Radius remains blocked pending a public transport; no private Pi sharing imports or real uploads used in validation.
