# Pi Feature Matrix

This matrix maps the capabilities advertised by the four requested reference extensions to the Pi workflow implemented in this repository.
Vendor-owned hosted services cannot be reproduced by a local extension, so those rows name the external dependency and the available Pi-local alternative.

The minimum supported VS Code version is 1.140.0, with matching `@types/vscode` declarations.
Versions 1.106–1.139 are no longer supported.
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
| Bundled default Pi runtime | Exact Pi 1.3.0 production dependency, workspace Extension Host runtime, shared Pi stores, explicit external override and target-specific reset | [Runtime behavior and validation limits](#bundled-default-pi-runtime). |
| Fixed primary composer status | One permanent composer area, with quiet idle space and wrapping actionable text | [Status behavior and checks](#fixed-primary-composer-status). |
| Visible submission blockers | Non-neutral blockers share primary status; neutral empty input uses only a tooltip and accessible description | [Submission descriptions and checks](#visible-submission-blockers). |
| Latest-output navigation | Keyboard-accessible Jump to latest, bounded New output indicator and preserved manual reading | [Reading position and checks](#latest-output-navigation). |
| Panel clipboard and send feedback | Tool input/output Copy uses the VS Code clipboard; mixed text/image paste keeps text; drafts clear only after acceptance | [Clipboard and acceptance checks](#panel-clipboard-and-send-feedback). |
| Operation diagnostics | Shared **Output → Pi** log, explicit **Show Output**, and short results and uncertainty instructions in the Sidebar | [Logging boundaries and evidence](#operation-diagnostics). |
| Text draft recovery | More → Conversation details recovery controls, explicit retention consent, bounded workspace-scoped text storage, session-bound retained-text notice, manual Restore/Discard and Disable/discard-all | [Storage and recovery evidence](#text-draft-recovery). |
| Discoverable file context and accessible messages | Capability-aware snapshot/path instructions in Submission help and the input's accessible description; stable, labelled message headings | [Context and accessibility limits](#discoverable-file-context-and-accessible-messages). |
| Quick session switching | Searchable native Quick Pick plus previous/next commands and guarded default chords; bounded same-workspace discovery, stable cycle order, authoritative transition checks | `sidebar.ts`, `piRuntime.ts`, `sessionNavigation.test.ts`, `sessionSwitchRuntime.test.ts`; native keyboard and picker fixtures run without a live model. |
| Grouped native session actions | One searchable native Quick Pick with five groups, including Conversation display → Word wrap / Conversation details; existing mutation routes retain host checks | `sidebar.ts`, `sessionActions.test.ts`; separators, description filtering, stale/lifecycle rejection and cancellation retain original host guards and command IDs. |
| Transcript code wrapping | More… → Conversation display → Word wrap shows On/Off, off by default and local to the view | [Display-only behavior](#transcript-code-wrapping). |
| Bounded conversation search/history | Header Find text / Earlier history / Latest history icons; search-only scope and unloaded-history note, no passive unavailable strip, conditional loading/position/truncation feedback and safe literal highlighting | [History bounds](#bounded-conversation-searchhistory). |
| Temporary passage annotations | Foreground whole-line highlights, literal hovers and read-only native comments; collapsed by default, with an initial-state setting | [Annotation contract and evidence](#temporary-passage-annotations). |
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
| Codex edit and preview changes | Editor actions use the persistent Pi Chat session, create proposal cards, generate virtual-document diffs, and require Preview before Apply | Implemented in `src/editorActions.ts` and `src/sidebar.ts`. |
| Codex cloud delegation | Independent background and detached-worktree Pi agents with streamed tracking | Local equivalent implemented; OpenAI-hosted Codex Cloud remains an OpenAI service dependency. |
| Codex cloud task review locally | Inspect actual isolated-task results and explicitly import selected files into the originating worktree | [Task import evidence and limits](#codex-cloud-task-review-locally). |
| GitHub Copilot inline completion | Manual or opt-in automatic VS Code ghost-text completion | Implemented with cancellation, debounce, cache, and bounded context. |
| GitHub Copilot next edit suggestion | `Pi: Suggest Next Edit` predicts one focused whole-file change and opens a diff preview | Implemented local equivalent; Copilot's proprietary ranking model is a GitHub service dependency. |
| Copilot Chat conversational assistance | Dedicated Pi view plus native `@pi` Chat participant and slash commands | Implemented. |
| Copilot inline chat | `Pi: Inline Edit` targets the selection or current line, routes into persistent Pi Chat, preserves follow-up context, and previews edits | `Ctrl/Cmd+I` runs Quick Fix (`pi.quickFix`), with an Inline Edit fallback only when no relevant diagnostic exists. |
| Copilot Ask/Edit/Plan/Agent modes | Pi-default conversation without extension-defined modes | Deliberately uses Pi's default tools and extension-contributed tools instead of recreating Copilot modes or fixed allowlists. |
| Copilot autonomous multi-step agent | Persistent Pi RPC conversation reads, edits, runs commands, tests, retries, and self-corrects | Implemented using Pi's default coding toolset. |
| Copilot central session management | New, name, resume, compact, export, terminal handoff, foreground, and background sessions | Implemented in the Pi conversation view. |
| Copilot Plan-to-implementation handoff | Plan and build welcome actions create ordinary prompt drafts in the same Pi-default session | No special mode transition or runtime restart is required. |
| Copilot change review and revert | Chronological tool calls, changed-file cards, request history, Source Control, diff, open, and stale/dirty-safe revert | [Tool history and recovery limits](#copilot-change-review-and-revert). |
| Copilot custom instructions | Pi global/project AGENTS.md and Pi system/settings resources | Implemented through normal Pi resource discovery and explicit project trust. |
| Copilot skills and custom agents | Pi skills, prompt templates, extension commands, contributed tools, and background agents | Implemented and discoverable through **Commands and Skills**; tool discovery is not restricted by a fixed allowlist. |
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
| Claude Code terminal-style interface | Open the active Pi session in an integrated terminal | Implemented. |
| Claude Code subscription/model choice | Pi's provider authentication, subscription OAuth, API keys, model catalog, and thinking levels | Implemented by reusing Pi; provider subscriptions remain provider dependencies. |
| Image-aware chat | Bounded PNG, JPEG, GIF, and WebP RPC image payloads from file selection or Ctrl/Cmd+V paste, with model-capability checks | [Image lifecycle](#image-aware-chat). |
| Provider authentication | Separate native sign-in/sign-out commands; isolated selected Pi 1.3.0 helper using public `ModelRuntime`, masked stdin input, explicit host/store approval | [Authentication evidence and limits](#provider-authentication). |
| Session export/import | Existing full-tree HTML renderer, public SDK active-branch JSONL export, validated same-workspace v3-tree import into a retained collision-safe copy | [Session-transfer evidence and limits](#session-exportimport). |
| Reviewed session sharing | Exact active-branch JSONL inspection/redaction, explicit destination and modal upload approval, public `gh gist create --public=false` stdin adapter | [Sharing evidence and limits](#reviewed-session-sharing). |
| Hosted pull-request agent | Foreground/worktree sessions can use installed `git` and `gh` tools to create branches, commits, pushes, and PRs | Local orchestration implemented; GitHub credentials and hosted repository access are external dependencies. |
| Cross-machine cloud synchronization | Exported sessions and Git/remote-provider workflows | Requires an external storage or hosted-agent service; no vendor-neutral synchronization service exists in this local extension. |

## Workflow details and evidence

### Bundled default Pi runtime

Unset, empty, or whitespace-only `pi.executablePath` selects bundled `@earendil-works/pi-coding-agent@1.3.0` without system Pi/Node lookup.
Any nonempty value, including saved `pi`, selects external Pi without rewriting configuration.
Reset removes only the chosen target override; another effective override can still win.
All extension-owned launches share this selection, including helpers and controlled terminal handoff; ordinary terminals are unchanged.

The workspace Extension Host's `process.execPath` starts the pinned absolute npm entry through a bootstrap.
Electron's initial `ELECTRON_RUN_AS_NODE=1` is removed before Pi/tools run.
Bundled launches suppress automatic version checks, clear package/managed-install overrides, and reject initial CLI `update` before upstream import, including custom `npmCommand`.
Extension releases own runtime updates; external launch behavior is unchanged.
Pi 1.3.0 has no built-in TUI `/update` route.

Ordinary Pi stores, credentials, sessions, resources and provider environment are reused without migration or new isolation.
Helpers keep disposable directories and their environment allowlist.
User-installed extensions must support Pi 1.3.0; broader external runtime compatibility is not verified.
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
Recorded native checks verify active-row placement and Disable in Linux desktop SQLite on VS Code 1.106.0 / 1.142.0.
Earlier web-remote client IndexedDB evidence predates this relocation; remote controls were not rerun.

### Discoverable file context and accessible messages

Passive canonical workspace metadata only; capture still requires selection and explicit Send.
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
Full-response decoding and synchronous JSON parsing can still increase memory use and pause the Extension Host.
Locally typed frame-too-large errors produce an allowlisted Output category and a fixed Sidebar notice, without raw frame, error or path data.
The first fatal decoder failure stops decoding and releases retained input; the client ignores later stdout while bounded cleanup completes.
New RPC commands and dialog replies are rejected before they can write to that failed client.
History failures preserve existing session references and files, without automatic new-session fallback or request replay.
Bridge frames remain limited to 1 MiB and one-shot Pi output to 5 MiB; attachment and session import/export limits are unchanged.
Omitted long-message text is labelled, not retrievable here.
See [Composer behavior and validation](COMPOSER_UX.md).

### Temporary passage annotations

Foreground `vscode_annotate` adds whole-line highlights, literal hovers and read-only native comments below marked ranges.
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
One active multiline editor request / 100,000 characters; cancellation never returns partial text.
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
No Pi API or model request is used for completion.

### Context inspection

Implementation: `contextInspector.ts`, `sidebarAttachments.ts`; revision-safe consumed-item tests.
Estimates exclude Pi history/instructions/future reads; image usage unknown.

### Failed-test repair

Implementation: `testRepair.ts`, `testRepairController.ts`; real failing Node test repaired/rerun with fixture response.
Two attempts, one source file; no private Test Explorer API.

### Request checkpoints

Implementation: `checkpointHistory.ts`, `changeTracker.ts`; immediate-write subprocess boundary and stale/dirty/dependency tests.
Memory-only; no creations/deletions/shell rollback.

### Direct shell

Pi 1.3.0 compatibility uses canonical packaged read-only sentinel version metadata, without an execution probe or approval handshake.
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
Bundled assets, bounded rendering, source fallback; no raw HTML, full TeX documents, arbitrary Mermaid configuration, or terminal-renderer parity.

### Codex side-by-side chat panel

The quiet idle composer has an attachment icon and combined model/thinking button, on-demand details, full-image thumbnails and keyboard preview, bounded prose, fixed primary status and separate Stop.
Blocking errors/cleanup warnings retain a separate non-dismissible notice and diagnostic action.

Implementation: `src/sidebar.ts`, `src/sidebarHtml.ts`, `scripts/interface-fixture.mjs`, `scripts/fixed-status-fixture.mjs`; fixed-status unit/browser checks and full Linux native UI suites passed on VS Code 1.106.0 / 1.142.0.
Client Windows/macOS, remote, and real assistive-technology checks were not rerun.

### Codex context from open files and selections

Implemented with item, size, and total bounds.
Ask About Selection, the Ask Pi code action, and Ctrl+Alt+A (Cmd+Alt+A on macOS) stage selected text as an unsent reference in the active session's composer.
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
Isolated actual Pi 1.3.0 network-free SDK comparison is available through `scripts/test-isolated-sdk.mjs`.
Full-tree JSONL export and legacy migration are not implemented.

### Reviewed session sharing

Implementation: `sessionShare.ts`; fixture CLI captures exact payload/argv, validates returned gist URLs, and rejects uncertain completion without replay.
At most 2 MiB; non-public gists are link-readable, not confidential.
Radius remains blocked pending a public transport; no private Pi sharing imports or real uploads used in validation.
