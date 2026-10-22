# Security and Privacy

## Runtime Selection and Update Ownership

An unset, empty, or whitespace-only `pi.executablePath` selects the exact bundled production dependency `@earendil-works/pi-coding-agent@1.3.0`.
A nonempty value selects external Pi, including an explicitly saved `pi` command.
Configuration is not rewritten; reset removes only the selected target's override and runtime selection uses the resulting effective value.
Opening Settings does not start or validate Pi.
Changes apply to new processes or an explicitly confirmed restart, not an active client.

Bundled paths resolve from the active extension installation on the workspace Extension Host, not from the workspace or local UI machine.
The resolver checks the pinned package identity, entry metadata, and required files inside the extension installation.
The Extension Host's absolute `process.execPath` starts a small packaged bootstrap with the absolute npm `dist/bundle/cli.js` entry.
No system `pi` or `node` lookup is required for bundled launches.
Missing or invalid assets and unsupported host runtimes fail without PATH fallback, replacement-session creation, or automatic operation replay.
These checks are not a sandbox against code that can modify the extension installation.

The reload restore reference is saved only after a bounded header read verifies an existing session and matching workspace.
An unsaved assigned path clears the previous restore reference but remains available in runtime memory.
An absent legacy restore file can be forgotten only after explicit **Start New Session** approval before Pi starts.
This approval permits the current startup/request to continue in a fresh session with the unchanged selected runtime.
Cancellation retains the reference; recovery never deletes or recreates existing session files.
Trust, ownership, restore reference, launch policy, canonical workspace, runtime assets, and file absence are checked again after approval.
An existing invalid header, missing header workspace, dangling symlink, permission error, or invalid bundled runtime does not authorize this confirmed missing-file recovery.
External Pi retains its earlier automatic fresh-session fallback for other restore errors; bundled Pi does not.
Saved executable overrides, including legacy `pi`, remain unchanged because their intent cannot be inferred.

Desktop Electron receives `ELECTRON_RUN_AS_NODE=1` only to enter Node mode.
The bootstrap removes that variable before importing Pi so tools and nested Electron programs do not inherit it from bundled startup.
Bundled launches set `PI_SKIP_VERSION_CHECK=1` and clear inherited `PI_PACKAGE_DIR` and `PI_MANAGED_INSTALL_ROOT` before upstream import.
Version-check suppression remains in Pi's environment and can reach descendants; it is not offline mode or a general network restriction.
The bootstrap rejects an initial CLI `update` command before importing upstream code, including when Pi settings specify a custom `npmCommand`.
This prevents that route from updating the packaged runtime or an unrelated global installation.
Pinned Pi 1.3.0 has no built-in TUI `/update` route.
Extension releases own bundled runtime updates.
External Pi retains its existing environment, Node/shim lookup, package-directory behavior, and update ownership.
Ordinary user-created terminals are unchanged; the extension adds no global Pi installation or PATH entry.

Ordinary bundled launches reuse the same Pi user store, provider environment, resources, and session storage as external Pi on that host.
`PI_CODING_AGENT_DIR` remains effective.
Runtime selection adds no credential isolation, migration, or independent user store.
Only isolated helpers retain disposable directories and the existing environment allowlist, with the selected runtime's required launch fields.
User-installed Pi extensions remain trusted executable code and must be compatible with the selected version.
Trust, permissions, read-only enforcement, Preview/Apply, stale-content checks, credential separation, and terminal ownership requirements remain unchanged.
See [Bundled runtime validation](BUNDLED_RUNTIME_VALIDATION.md) for evidence and unverified targets; asset presence does not establish cross-platform or remote execution support.

## Process Boundaries

The extension starts Pi with `shell: false`.
For external Pi on Windows, native `.exe` files run directly.
Only the complete standard npm Node shim template without extra shebang arguments or environment assignments is recognized; its Node executable and script run directly without evaluating batch text.
Other batch wrappers fail closed.
External executable and Node lookup use the final normalized child environment and working directory, not an inherited parent PATH fallback.
Windows environment keys are merged and removed without case sensitivity.
Missing or empty PATH disables bare-name search; empty PATH entries do not implicitly search the workspace.
Explicit relative executable paths and relative PATH entries use the child working directory.
Both clients share bounded process cleanup.
POSIX clients own a detached process group; Windows clients own the direct runtime rather than `cmd.exe`.
Windows descendant cleanup is not verified, including after a confirmed root exit, and RPC termination reports an explicit warning.
Foreground session deletion and failed startup cleanup keep a warning-only subscription until stop settles.
The subscription is released on success and failure; late state events from the detached client are not forwarded to the replacement session.
Cancellation and other one-shot failures include cleanup uncertainty in their error details.
Open inherited pipes and failed termination reach a bounded cleanup-unverified outcome rather than hanging.
Runtime settlement releases waiters and operation locks on disconnect; it does not establish that escaped or Windows descendant work stopped.
Queue drafts remain uncertain and checkpoint recovery remains conservative.
Verify remaining work before another operation that can conflict.
Prompts, source code, terminal text, and image payloads are written to Pi over stdin rather than process arguments.
Pi provider authentication remains in Pi's credential store or provider environment variables.
The VS Code bridge listens on a random loopback TCP port in the same extension-host environment.
Each bridge request and event subscription requires a random per-window token passed to foreground Pi processes and future integrated terminals.
Independent background/worktree agents receive neither bridge credentials nor the bridge extension.
Oversized or malformed bridge frames fail closed and terminate their socket.
Session shutdown and subscription replacement mark outgoing callbacks inactive before destroying their sockets.
Pending event-bus requests are cancelled and their late success/error responses are discarded before the old Pi API is invalidated.
Intentional cleanup emits no disconnect event and never replays a request into the replacement session; current connection failures still emit one disconnect event.
Processes in an authenticated terminal can inherit that token.
The non-secret `PI_VSCODE_BRIDGE_EXTENSION` variable identifies the bridge bundled with the active VSIX, but users must pass it explicitly with `pi --extension` in an ordinary integrated shell.
Requests remain allowlisted and expose no arbitrary command execution or file mutation method.
The bridge exposes bounded editor context, language-provider navigation metadata, file opening, notifications, and JSON-safe events from same-host VS Code extensions.

## Pi Tools

Foreground, background, and worktree sessions do not pass a fixed `--tools` list.
Pi therefore exposes its default `read`, `write`, `bash`, and `edit` tools together with tools contributed by installed Pi extensions.
Background and worktree buttons require explicit confirmation before launch.
Focused preview workflows use a packaged read-only gate while generating proposals.

## Tool and Shell Permissions

Pi and installed Pi extensions own tool and shell permissions.
pi-vscode does not package a tool-confirmation gate, set a permission mode, or add approval for built-in `bash`, `edit`, and `write` calls.
Without a permission policy, tools and shell commands can run with no confirmation.
Installed extensions execute with the user's permissions; they are not a sandbox.

This also applies to `!` and `!!` in the sidebar and controlled Pi terminal: pi-vscode adds no extra execution approval or host authorization handshake.
Existing Pi-requested dialogs are displayed unchanged.

Workspace trust, project-resource approval, read-only proposal enforcement, Preview/Apply, stale-content checks, and other workflow confirmations remain required.
Historical validation records describe the behavior checked at that time, not the current tool/shell permission contract.

## Extension Dialogs

Dialog replies are bound to the exact inbound event, originating RPC client, and session generation.
Each request can complete once.
Duplicate IDs are rejected, and failed response writes are not retried.
Stop, disconnect, disposal, session replacement, and observed session-identity changes invalidate pending handles before a replacement process can receive a reply.
The controller admits at most 16 pending dialogs and remembers at most 4,096 IDs per generation; further requests fail closed until that generation ends.
Select lists are validated as a whole: at most 100 string options and 100,000 total characters.
Malformed or oversized lists never become partial permission menus.

The multiline editor requires per-use acceptance of the non-secret text contract before creating an untitled document.
VS Code can retain this text in hot-exit backups.
This is not a credential editor, and this extension cannot promise to remove VS Code backups.
Prefill and submitted text are limited to 100,000 characters, with one active editor request at a time.
Submit captures the full current document text and version once; an empty string is a value, not cancellation.
Text uses the native document's line endings, which can normalize mixed line endings.
Save is not submission and can create a user-selected file.
Cancel and close return no partial text.
Submit/Cancel commands check the exact active owned document in the host; context keys alone do not authorize a response.

Cleanup disables request actions first and closes only owned tabs through the stable TabGroups API.
Dirty untitled text can prompt Save / Don't Save / Cancel.
Choose Don't Save to discard it.
Cancelling the close can leave an inactive document; close/discard it explicitly.
No global revert or arbitrary-editor close command is used.
The controller does not write dialog text to workspace paths, transcript state, configuration, or extension storage.
Returned text reaches the requesting Pi extension and can enter ordinary provider/history flows under that extension's behavior.

Pi-provided deadlines cancel input, select, editor confirmation pickers, and timed confirmation reviews locally without sending a competing timeout default.
Deadline checks also reject results if timer callbacks were delayed.
Untimed Pi-requested confirmations retain the complete native permission modal.
Stable VS Code APIs cannot dismiss that modal on client replacement, but its late result cannot authorize the replacement client.
Timed confirmations instead use a cancellable Block-first picker and a full read-only review before Allow.
The review supports Unicode/multiline content up to 100,000 characters through a request-owned content provider, not an untitled document or workspace file.
Its Allow/Block commands require the exact active review document and live origin handle.
Timeout, close, or invalidation removes retained provider text, expires cached content, closes owned review tabs, and disables approval.
No truncated permission message can directly authorize an action.

## Direct Shell

Only explicit column-one `!command` or `!!command` from an idle session composer uses direct-shell RPC.
Leading whitespace, code fences, and prose are model prompts.
A leading backslash escapes one exclamation mark.
Empty commands, hidden/control characters, commands over 8,000 characters, attachments, queued submission, background submission, and the Sessions-level composer are rejected.
Model output, tool output, history, and retry never dispatch shell syntax.

The host uses the shared canonical operation owner.
It requires trust, a file-backed workspace, matching canonical workspace/session identity, unchanged launch policy, no pending queue or extension dialog, and sidebar ownership rather than terminal ownership.
This owner excludes foreground requests, session/resource controls, Preview/Apply, imports, and checkpoint restores.
The host validates the originating client generation, session, workspace binding, command, context mode, trust, and launch policy before submission.
These checks do not request execution approval.

Safe `get_commands` discovery checks the canonical packaged read-only sentinel path and its version metadata.
Only the verified Pi 1.3.0 `user_bash` contract is enabled.
No command is executed to probe support, and no approval handshake is used for compatibility discovery or execution.
The read-only policy still throws while preview-only work is active.
A `user_bash` handler returns `undefined` to continue; only a valid `{ operations }` or `{ result }` replaces execution.
Tool-call `{ block }` objects are invalid here.
Pi 1.3.0 reports and rethrows handler failures before local execution.

The controlled TUI adds no pi-vscode confirmation for `user_bash`.
Pi and installed extensions can still request their own dialogs or enforce their own permission policies.

Shell command text stays on Pi stdin.
The launcher remains `shell: false`; Pi performs the explicit shell execution.
Output is correlated by command ID, bounded to 64,000 retained characters, stripped of terminal and hidden formatting controls, and rendered as inert plain text.
The final result replaces streamed output.
History replacement remains inside the captured canonical operation owner.
Failed post-submission session/origin verification disconnects the originating client before ownership is released, so later prompts cannot enter an actual session under stale cached history.
`!` enters model context on the next prompt under Pi's normal history/compaction rules.
`!!` is excluded from model context but remains in Pi session history, exports, and later sharing.
It is not private execution or deletion.

A 60-second execution deadline is separate from normal RPC request timeouts.
Stop/deadline requests `abort_bash`, then requires acknowledgement and the final execution result, with five-second bounded waits.
Missing or failed evidence disconnects Pi, reports cleanup uncertainty, and never replays the command.
Even acknowledged cancellation cannot establish that escaped or Windows descendants stopped.
Inspect processes, Source Control, and external effects before conflicting work.
Direct-shell checkpoint entries have no restorable files; arbitrary shell/service effects cannot be rolled back.
Rejection before submission keeps the composer draft.
Accepted submissions clear only the captured composer revision.

## Project Trust

Project-local Pi settings, extensions, skills, and prompts are not approved by default.
Enable `pi.approveProjectResources` only for a trusted workspace.
RPC launches explicitly pass `--no-approve` when this setting is disabled, rather than relying on inherited global Pi approval.
New workflow processes and mutations reject untrusted or virtual workspaces in the host, not just disabled UI.
Foreground actions and resumed session headers must match Pi's canonical working directory.
Cross-worktree sessions must be opened in the matching workspace window.
The Pi bridge extension is bundled in the VSIX and loaded process-locally for foreground RPC and **Open in Terminal** Pi sessions.
Release/source installers and extension activation remove only the historical `picode.ts` and `pi-vscode.ts` global bridge paths created by this project; they do not create a Pi extension directory on a clean installation.
Activation performs this migration before starting Pi and fails closed if cleanup cannot complete, preventing a legacy global copy from loading beside the bundled bridge after a direct VSIX or Marketplace upgrade.
Pi extensions execute with the user's permissions and must be reviewed before installation or explicit loading.

## Foreground Resource and Session Controls

Reload, fork, clone, navigation, restart, and terminal ownership share the foreground operation owner and canonical workspace operation gate with Apply/import/restore.
The gate prevents conflicting extension-owned operations.

Searchable switching, previous/next commands, and saved-session sidebar routes share the guarded runtime switch path.
Discovery uses bounded same-workspace metadata from the active session directory, not arbitrary stores or full transcript search.
Picker preparation and acceptance reject stale session/client/view lifecycle state; failed discovery cannot authorize a retained index.
A selected saved session ID must still match its bounded header, and repeated file/header snapshots reject observed destination replacement before dispatch.
The canonical operation gate excludes Apply, imports, restores, direct shell, and terminal handoff during RPC switching and authoritative runtime refresh.
A verified cancellation keeps the current session; a thrown RPC result or failed authoritative refresh disconnects safely because the destination can already be active.
Neither outcome automatically repeats switching or sends a model request.
Existing composer binding/recovery checks remain unchanged; extension status/widget UI still resets before dispatch, while the conversation workflow reset follows verified switching.

- Controls reject busy sessions, queued instructions, active extension dialogs, untrusted/virtual workspaces, stale client generations, changed session/leaf identity, and canonical workspace mismatches.
  Approval callbacks revalidate the origin after asynchronous UI.
- Cold configuration operations can hold the same guard without starting Pi.
- Startup captures launch settings before asynchronous preparation.
  It rechecks trust, disposal, policy and canonical root before spawning, and uses that canonical cwd.
  Disposal during preparation or synchronous reset callbacks cannot spawn a detached replacement.
- Non-decision completion notices do not retain operation ownership or keep completed commands pending.

The packaged control command is limited to reload and unsummarized navigation through public extension APIs.
It is not a model tool or a bridge mutation endpoint.

- Dispatch requires exactly one expected extension command with canonical packaged-path metadata, plus bridge and policy markers.
- A separate read-only policy handles reserved control input if dispatch cannot find the command.
  This prevents a discovery/dispatch race from converting control JSON into an ordinary model prompt.
- Installed extensions remain trusted executable code, not a sandbox.

Missing policy ownership, partial reload, unexpected model activity, timeout, disconnect, or failed strict refresh causes disconnect without automatic retry, rollback, or replay.
A failed UI refresh does not prove that a branch mutation failed.
Keep source sessions and inspect actual history before recovery.

- Control handling requires `prompt` disposition `handled`, observes extension errors, and verifies authoritative commands and state afterward.
- Navigation also requires a token-correlated cancellation result and expected-leaf verification.
- Reload cannot reuse the old extension context.
  Transient extension UI resets before transitions.
- The host does not edit JSONL parent IDs.

Reload retains the launch-time executable/options and project-approval decision.
A changed launch decision requires a separate explicit restart confirmation.
Restart directly opens the captured persistent session; it does not fall back to a fresh session.
A restart failure can leave Pi disconnected and does not restore old configuration bytes.
Tree retrieval retains at most 2,000 entries / 100 levels and uses the existing 5 MiB framing and command deadlines.
Draft text is limited to 50,000 characters; image payloads are not retained in tree items.
Navigation does not undo filesystem, Git, shell, service, or external effects.
Unsummarized navigation alone is not durable across restart in the checked Pi version.

Terminal handoff stops the foreground RPC writer before constructing the terminal.
It transfers the canonical gate without an unlock/relock gap and holds it until explicit ownership return.

- The same packaged bridge, read-only policy, launch overrides and explicit project-resource approval flag are supplied as argument arrays and environment, never shell text.
- Before stop or launch, a bounded workspace-state marker records the canonical root (4,096 characters), session path (4,096 characters) and session ID (200 characters), without credentials.
  - Activation restores the blocked owner and canonical gate before sidebar startup.
  - Disposal releases local locks but does not remove this marker.
  - Invalid markers fail closed; explicit clearing does not resume an unverifiable session.
  - Confirmed same-session startup and successful marker removal are required before normal ownership resumes.
- Pi assigns an unsaved session path before writing a header; its temporary ID is not durable.
  These empty sessions use the captured launch cwd and assigned path, while saved sessions must also match the persisted ID and header cwd.
- Storage failures prevent launch or stop a new writer and retain recovery ownership.
- Stop cleanup warnings require an inspection confirmation before launching another writer.
  Cancellation after uncertain cleanup or terminal-construction failure leaves ownership held for recovery.
- Terminal closure does not establish descendant termination.
  Returning ownership requires explicit confirmation, trust/root/current-policy revalidation and same-session startup.
- Drafts and ordinary attachments are not transmitted by handoff.
- Foreground terminal credentials do not become background-agent credentials.

## Temporary Editor Annotations

`vscode_annotate` adds temporary whole-line highlights, hovers and read-only native CommentThreads.
Threads are grouped at each range's end line and show **Pi** as author and **Pi annotation** as label.
`pi.annotations.initialState` accepts `collapsed` (default) or `expanded`, exposed as **VS Code Settings → Pi → Editor → Annotation initial state**.
For `collapsed`, `CommentThread.collapsibleState` remains unset, using the API's collapsed default; `expanded` explicitly sets `CommentThreadCollapsibleState.Expanded`.
The setting affects only newly created or replaced annotations, not existing thread handles or user state on redraw.
The native Comments panel also lists explanations.
The user-authorized native display may auto-open that panel and change editor layout or visible range/scroll during expansion, replacement or removal.
The extension does not write files, open documents/tabs, perform explicit tab/selection/focus/reveal/scroll operations, or override VS Code comments settings.
No global VS Code comments settings are written.
VS Code comments visibility settings may hide widgets.
Result fields are unchanged: `count` counts accepted annotations, not thread groups; `visible` means a visible editor exists for the document, not that a widget is visible.
It accepts inclusive one-based whole-line ranges for one already-open regular text document inside the trusted workspace matching the foreground Pi working directory.
Dirty buffers and inactive tabs are supported.
Both admission and final validation require a current text/diff tab; cached documents left after tab closure are not eligible.
Workspace-root aliases are validated against their canonical root; nested symlinks, hard-linked leaves, outside-root paths, ambiguous open aliases and non-file resources are rejected.
The host compares exact current lines with LF-normalized expected text, captures buffer versions before asynchronous validation, and rechecks versions, file identity, root bindings, trust, origin and clear/edit revisions before applying a replacement.
External filesystem changes are not globally atomic with these checks.

The shared window bridge token alone does not authorize annotations.
Each foreground RPC client receives a separate random `PI_VSCODE_ANNOTATION_TOKEN` in its launch environment only.
The terminal environment collection never receives that credential, terminal handoff explicitly removes it, and background launches remove inherited values.
A private origin exchange also verifies the current live sidebar client, session ID and canonical cwd.
Its opaque annotation origin changes on manual clear and session/resource/client resets.
Callbacks capture this origin and transport liveness; cancelled, disconnected, replaced or expired work cannot restore cleared annotations.
Annotation calls do not acquire the foreground request gate again, so an ordinary read-only question can annotate while retaining its request ownership.
Control transitions reject new annotation calls.

These credentials isolate ordinary terminal/background bridge callers, not trusted code running inside the foreground Pi process.
Pi extensions and foreground subprocesses can access their process environment; this is not a sandbox against credential theft.
Credentials and opaque origins are excluded from the model-visible tool schema/results, logs, VS Code storage and terminal handoff.
Origin/transport failures produce sanitized tool errors, without automatic retry.

The packaged read-only gate permits exactly `vscode_annotate` as an additional editor-only operation.
File mutation, shell execution and unrelated extension tools remain blocked.
Hover and native comment messages are literal untrusted text, using `MarkdownString.appendText` with trusted commands and HTML disabled.
Autolink punctuation is encoded as character references so bare URLs and email addresses also remain literal text.
They are labelled Pi annotations, not verified diagnostics.
Threads have no reply or edit actions.
Limits are 20 annotations per call, 200 lines / 10,000 expected-text characters / 1,000 message characters each, and 100 retained annotations across 20 documents.
Invalid replacements are atomic and keep earlier annotations; no silent range clamping or retention eviction occurs.

Annotation state is memory-only.
Clearing removes decorations and disposes native threads.
Document text edits, document close and the last text/diff tab close clear that document; save-only dirty-state events keep it.
Visible-editor changes also remove old decorations from reused hidden editors.
Manual clear, session/branch changes, resource reload, client replacement, disconnect, terminal handoff and disposal clear all annotations and invalidate pending work.
Hidden-sidebar state is retained.
No Problems entries, new persistence, provider request, or source comment is added by the Clear Annotations command.
Tool inputs, including expected text and explanations, remain subject to ordinary Pi/provider history retention; clearing editor annotations does not erase that history.

## Change Safety

Deleting a conversation requires modal confirmation and moves its persistent session file to Trash before starting a replacement session.
If and only if the active file provider reports Trash as unsupported, the extension keeps the conversation and offers permanent deletion behind a second modal confirmation that remains bound to the original session even if Pi starts a replacement.
Kept and failed outcomes compare the runtime session identity captured before deletion and clear the old transcript if recovery started a replacement.
The primary notice does not include the session path; an explicit **Show Output** action opens safe technical records in **Output → Pi**.
Ordinary permission or I/O failures never fall through to permanent deletion.
Focused editor edits enter the persistent Pi Chat session as edit proposals.
A packaged read-only policy gate recognizes only extension-controlled prompt-prefix metadata, narrows active tools, and blocks every non-read-only tool while Pi generates a proposal.
Apply remains disabled until the user opens Preview for the current hunk selection.
Selection changes invalidate Preview.
The host computes hunks from captured text, validates IDs, checks document version immediately before one workspace edit, and finishes the proposal without applying the remainder.

Every ordinary foreground request starts conservative checkpoint capture because default Pi and extension-contributed tools may mutate state.
Any tool start makes automatic retry unsafe, including a tool not known to Pi.
Checkpoint capture completes before submitting the foreground prompt; late tool-start notifications never establish the before-image.
Coverage requires pre-captured existing regular text and an unambiguous supported edit/write announcement whose expected result matches final disk text.
This is conservative coverage, not proof of every external writer's identity.
Dirty buffers, unsupported files, creations/deletions and ambiguous attribution are excluded.
Shell/custom-tool requests and process exits without settlement are non-restorable.
Capture is bounded to 10,000 entries / 20 MiB.
History is memory-only, capped at 20 requests, 2 MiB per file side and 20 MiB retained before/after bytes; unresolved restore failures retain recovery data and may prevent new history from being retained.

Restore preflights all selected paths/content/dirty buffers and later checkpoint dependencies, then rechecks each write.
Proposal/import/restore and active Pi work in the same canonical directory share an operation gate.
Successful and partial restore attempts invalidate dependent previews.
This gate cannot serialize another VS Code window or an external process.
No operation promises filesystem-wide atomicity or rolls back arbitrary shell/service effects.
Checkpoints never rewind the transcript or index; Source Control review and backups remain required.

## Webview Safety

The Pi conversation webview keeps scripts nonce-only and does not allow eval.
`default-src` remains `none`.
Bundled styles and fonts load only through VS Code resource URIs, with `localResourceRoots` restricted to `out/rich-content`; transcript images add only `img-src data:`.
Inline styles are permitted because KaTeX layout attributes and Mermaid SVG styles require them.
This is a deliberate style-only change from the former nonce-only style policy, not permission for message-supplied HTML or CSS.
Network connections, external images, frames, and object loads remain blocked.
The Extension Host validates supported MIME, canonical Base64, decoded size, image header, and dimensions before delivery.
The Webview independently checks the bounded one-shot payload protocol and constructs labels, image elements, and previews with DOM APIs rather than interpolating attachment values into HTML.
Raw Markdown HTML is escaped by the host parser.
Link targets permit only HTTP, HTTPS, and mailto schemes without whitespace or control characters.
Markdown images produce only their alt text.
Browser DOMPurify sanitization is a second boundary before message HTML insertion, retaining the MathML needed for accessible math but removing active elements and event handlers.

KaTeX uses `trust: false`, strict errors, 4,000 source characters per formula, 50 formulas per message, 200 macro expansions, and a 10em size limit.
Resource-loading and HTML extension commands fall back to source.
Mermaid accepts only bounded flowcharts and sequence diagrams with complete fences.
Before parsing, it rejects configuration directives, front matter, user CSS, HTML, image shapes, external URL syntax, and callbacks.
Mermaid strict mode and a second SVG sanitization pass remove links, images, foreign objects, animation elements, event handlers, and non-fragment URL references.
No diagram binding callbacks run.
Source remains available when parsing, layout, limits, or sanitization prevent a preview.

Diagram work is serialized, with at most 100 queued blocks.
Host Markdown and browser diagram caches each retain at most 64 entries and 2,000,000 source/output characters.
Detached nodes, changed content/theme keys, and disposed views cannot receive late results.
Page disposal clears browser pending work and its diagram cache; an already-running Mermaid operation can finish but cannot insert its result.
Source/edge/expansion limits bound work; there is no hard preemption of synchronous renderer computation.
Generated HTML and SVG do not replace Markdown in RPC or stored history.
All renderer assets and third-party license texts ship in the VSIX; no CDN is used.
User, model, tool, attachment, and persisted text cannot inject raw scripts or HTML.
The modal image preview uses a native button trigger, supports Escape/close, clears its image source, and returns focus to the trigger.

## Settings Page

**Pi: Open Settings** (`pi.openSettings`) and the sidebar gear run `workbench.action.openSettings` with the fixed filter `@ext:narumi.narumi-pi`.
They do not open a custom `pi.*` settings form or start Pi.
General, Permissions, and Editor group all 11 existing settings without changing IDs, defaults, types, bounds, declared scopes, or runtime behavior.
VS Code owns configuration targets, native validation, incomplete-input behavior, and save-on-edit.
The former custom page's 4,096-character string, 100-item list, 16 KiB serialized-list edit limits, and custom save/retry/revision protocol do not apply to native Settings.
Native Settings editability is not a security boundary.
In particular, do not assume that `pi.approveProjectResources` is disabled in native Settings in an untrusted window.
Host trust, file-workspace, launch-policy, and project-resource checks remain independent of configuration editing and reject untrusted process launches and resource activation.
Current Restricted Mode and virtual-workspace activation support is unchanged.
Reset removes only the selected configuration target's override.
For `pi.executablePath`, another effective override can still select external Pi; otherwise the empty default selects bundled Pi.
Launch settings affect later process creation, not running foreground or background agents.

**Pi: Open Pi Configuration** (`pi.openPiConfiguration`) opens one dedicated panel; repeated invocation reveals it.
It has only a Global Pi/Project Pi file selector, with no User/Workspace selector or General/Permissions/Editor controls.
Its inline form edits only the eight existing common native settings and safe MCP enabled/exposure metadata through host-owned allowlists.
The common fields are startup provider, startup model, startup thinking level, ordered model patterns, steering mode, follow-up mode, automatic compaction, and automatic retry.
Save to selects Global Pi or Project Pi, with Project Pi identified as the first workspace folder's `.pi` directory.
Model, Behavior, and MCP sections group controls without adding new configuration targets.
Provider ID and Model ID are manual inputs; no cached catalog projection, catalog fetch, model-discovery RPC, helper, or credential read is added.
Inherited rows show read-only values and one source label, Inherited from Global or Pi default.
Set global override or Set project override opens a local draft initialized from the displayed value without writing a file or creating directories.
Saved overrides remain editable and distinct from unsaved drafts; a same-value override is valid.
Save stays visible in editable rows, disabled without a draft, while pending, or when stale.
Checkbox, select, and MCP metadata changes create drafts only.
Discard changes removes only the local draft; it never removes a saved override or writes a file.
Remove global override or Remove project override resets only the saved selected-scope member through the existing guarded path, not a copy of the inherited value.
These removal actions and Reload row are in the row menu; stale drafts also show an inline Reload row recovery action.
Opening or closing the menu does not discard drafts.
One warning identifies inactive Project overrides when project-resource approval is off; inherited Global values are not flagged inactive.
Neither saved nor draft values are represented as verified active-session values.
Secondary Reload saved values reads saved values and preserves unrelated drafts; it does not reload Pi resources.
Advanced opens Open Pi settings dialog… or Manage MCP servers… through the existing native dialog routes, not a direct JSON editor.
One shared explanation distinguishes file saves from running sessions; file locations and precedence remain in expandable help.
There is no Save All or Reset All.
This adds no configuration keys or duplicate schema.
`pi.openNativeSettings` and `pi.openNativeMcp` retain their existing native management dialog behavior.
Opening, reading, refreshing, or switching Pi file scopes does not create files, read credentials, discover models, start or restart Pi, or change current session RPC state.
Existing extension activation still initializes the bridge and performs legacy bridge cleanup.

The Pi Configuration webview has no VS Code configuration save/reset protocol.
Host validation checks native message size, request ID, key, scope, revision, value type, enum, and descriptor bounds.
Native-file messages accept only descriptor-bound common-setting values or allowlisted MCP metadata edits.
Incoming native requests are capped at 32 KiB; validated native projections are capped at 512 KiB to support bounded file reads and inherited values.
The browser cannot supply filesystem paths, JSON member paths, command identifiers, or complete native objects.
The host resolves native targets and member paths and checks trust, file-workspace availability, origin, and revision on each operation.
Native file edits and resets require a trusted, file-backed workspace, including for Global Pi.

Each native save is bound to its submitted scope.
Revision checks and file snapshots reject known stale writes, including changed inheritance sources.
These checks are not atomic against other windows or external file writers.
Conflicting drafts require an explicit row reload; a page refresh does not authorize a stale draft against a new revision.
Native drafts remain separate by scope and key and survive failed saves and scope changes; native saves are never automatic.
The host queue admits at most 16 operations; a rejected save or reset gets an error with only its bounded request ID and writes nothing.
Reset removes only the selected native scope's override.
Small drafts are kept in webview state while hidden, not in Pi settings or extension global/workspace storage; closing the panel discards them.
The separate restart action retains saved files and drafts on cancellation or failure; it never rolls back saved files or reports failed application as success.
Draft persistence permits only bounded validated common-setting drafts, never complete native snapshots or MCP data, including transport/authentication fields.
Webview state also keeps one bounded restart request ID and fixed outcome status for feedback recovery, never the action token.
Recovery does not dispatch a restart; the panel retains its latest bounded result in host memory and repeats only that result on webview readiness.
Obsolete General/Permissions/Editor recovery data is ignored, not replayed as configuration writes.
Workspace, approval, or agent-directory changes invalidate native snapshots.
Replaced loads and disposed panels reject stale or late results; rejected save/reset requests return bounded results so pending rows can recover.

Pi Configuration scripts and styles are bundled under `out/settings`, which is the panel's only local resource root.
The page uses `default-src 'none'`, nonce-only external scripts, local stylesheet resources, and no inline-style exception.
It enables no network connections, images, fonts, frames, or objects.
Configuration values enter the DOM through input values and `textContent`, not HTML.
Open VS Code Settings runs one fixed host-owned command/filter, never a browser-supplied command ID.
Review project approval setting accepts exactly `{ type: "openProjectApproval" }` and runs `workbench.action.openSettings` with the fixed filter `pi.approveProjectResources`.
It requires current panel authority and native-file availability and changes no approval, trust, or runtime state.
The separate Restart Pi… button (`native-restart-pi`) sends exactly `{ type: "restartPi", id, actionToken }` to the fixed host-owned `pi.restartResources` route.
Its snapshot `restartActionToken` is opaque, short-lived action authority bound to the host runtime, workspace, and policy origin.
The host rejects invalid shapes, unavailable state, stale authority, and disposed panels, and consumes accepted authority before dispatch.
No browser-supplied command identifier or file path is accepted.
The fixed `{ type: "restartResult", id, status }` response contains a bounded request ID and only `completed`, `cancelled`, `failed`, or `rejected` status.
The route reuses the existing restart confirmation and runtime lifecycle checks, including trust, canonical workspace, launch policy, session identity, ownership, queues, dialogs, and cleanup inspection.
The sidebar command's internal Boolean return does not change those checks or its user behavior.
A failed restart reports runtime uncertainty; resumed-session values and VS Code launch overrides can still take precedence after a completed restart.
Save, saved-override removal, and Reload saved values never dispatch restart.
Panel disposal removes its listeners, clears retained restart feedback, and prevents late posts.
A native file operation or confirmed restart already accepted by the host can finish after the panel closes.

## Native Pi Configuration

Pi Configuration permits inline common-setting and safe MCP metadata edits, not arbitrary native file editing.
Server creation, transport editing, credentials, authentication, diagnostics, and advanced editing remain in existing explicit native management interfaces.
Command Palette native management remains available.
Native controls require a trusted, file-backed workspace even for Global Pi.
Passive opening or reading starts no Pi process, server, credential command, authentication flow or connection and creates no files.
Native projections load only when the Pi Configuration panel opens or is explicitly refreshed; opening native VS Code Settings does not read native files.
Global Pi uses the Extension Host's `~/.pi/agent` or `PI_CODING_AGENT_DIR`; Project Pi uses the current launch workspace's `.pi` (the existing first workspace folder behavior, not multi-root selection).
Remote windows use remote host paths.
The Project Pi form and native dialogs label unapproved project settings and MCP entries inactive; editing does not activate them.
The form marks only saved Project overrides inactive, not inherited Global values.
Management code never reads `auth.json` or `mcp-auth.json`.
The browser receives only validated allowlisted common-setting values, safe MCP metadata, opaque revision tokens, and a host-owned restart action token.
Invalid existing common-setting values produce fixed diagnostics without the raw value.
MCP projections contain validated names, transport type, source, enabled/exposure metadata and unknown connection state, not URLs, commands, arguments, environment/header values, OAuth fields or raw errors.
Raw file text, unlisted settings, and MCP transport/authentication fields remain host-only and do not enter browser messages, persisted browser state, or logs.
Full native file snapshots remain host-only and memory-only.
MCP enabled/exposure saves and resets affect only the selected native scope; project metadata overrides preserve inherited transport and credentials.

Open missing files unrelated to native configuration do not block these controls.
Open editor documents for missing configuration targets, dangling aliases, changed alias bindings, dirty/version-changed target buffers and non-ENOENT path errors still fail closed.
Missing target-name variants are also blocked on Windows and macOS.

Common file controls accept at most 128 KiB of regular single-link UTF-8 strict JSON with bounded nesting.
The form and native dialogs reuse descriptor-bound reads, canonical ancestor checks, target revisions, dirty-buffer checks, writable mode and repeated origin/trust/policy checks to reject known unsafe or stale writes.
Each edit binds to the captured canonical workspace, agent directory, native scope, approval/environment state, and relevant file revisions, including inheritance sources.
Host-owned member-level patches preserve unrelated data; there is no second persistence implementation.
The shared canonical workspace gate and canonical target-file gate serialize extension-owned work.
Reset removes only the selected override; unknown keys and unrelated member bytes remain unchanged.
Only an explicit override save can create the needed configuration file and missing Pi directories under the captured canonical ancestor.
Reading, opening, refreshing, switching Pi file scopes, entering edit mode, discarding drafts, or resetting an absent override creates nothing; saving `settings.json` does not create `mcp.json`, or conversely.
An external process or another window can still race checks, and an I/O failure can leave a partial write or newly created file.
No compensating write restores stale full-file content.
The explicit advanced native editor opens an existing `settings.json` or `mcp.json` after a warning and uses normal VS Code Save/backups, not the bounded common-control path.
An absent file requires a common-control override save first.

Saving or resetting a form row does not apply runtime settings, approve a project, load executable resources, install a package, reload or restart a runtime, or connect an MCP server.
Apply is separate, explicit and idle-only.
Resource reload can execute configured resources and connect servers under existing trust; startup model preferences still need controlled restart.
Background agents remain unchanged.
Saved-file/apply-failed state is reported without rolling back files.
Runtime queue/compaction/retry setters also request Global Pi persistence; RPC acknowledgment is not verified disk durability.

The explicit `pi mcp list --json` diagnostic requires approval for all enabled file-configured servers, local server/credential-command execution and networks.
It uses shell-free argument arrays without credentials, a 30-second deadline, cancellation, combined 128 KiB output limit and bounded cleanup.
Only allowlisted diagnostic metadata is retained in memory; raw transport/error/stderr output is discarded.
It is separate from current-session evidence.
Pi CLI saved project trust differs from the VS Code approval switch: diagnostics are blocked if project MCP configuration exists without project-resource approval; the CLI may still skip project entries not trusted in native Pi.
Native trust is never changed by management.

Interactive MCP auth remains in the controlled Pi terminal and requires verified built-in command ownership before guidance.
No command or credentials are injected into terminal input.
Pi owns browser/remote redirects, tokens, logout and cancellation; returning from the terminal is not auth success evidence.
Third-party command output is never treated as native connection state.
Existing contributed-tool permissions and the focused read-only gate are unchanged.
See [Native configuration contract](NATIVE_CONFIGURATION.md) for upstream API gates and remaining acceptance items.

## Operational Logging

Activation owns one host-local **Output → Pi** `LogOutputChannel`, shared by runtime, Sidebar and inline completion.
Records are written when events occur, including runtime warnings when the Sidebar is closed.
Logging does not start Pi, retry work, change operation ownership or open a panel.
Only an explicit **Show Output** action calls `show(true)` to preserve editor focus.
Destructive confirmation and Pi-requested dialogs are unchanged.
Cleanup uncertainty, delivery uncertainty and instructions not to repeat completed commands remain in the Sidebar.

Records use typed allowlisted metadata: fixed operation/result/category names, validated filesystem codes, exit codes/signals, bounded counts/durations, flags, host-generated operation IDs and client generations.
Activation adds extension/VS Code versions, platform and local/remote host category, not remote names.
Unknown errors use `unknown`; error messages, causes and stacks are not copied.
Prompts, responses, thinking, code, tool/shell/terminal/queue text, attachments/images, session paths/titles, credentials, auth redirects, MCP transport fields and annotation origins/tokens are excluded at all levels.
Stdout, stderr and malformed frames are never copied to Output.
Existing private diagnostic buffers keep their existing bounds and access boundaries.

VS Code supplies timestamps, severity, log-level filtering and file retention.
Info records operation boundaries/results; Warn/Error records abnormal outcomes; Debug/Trace can expose safe command timing and discarded/cancelled work, not raw content.
Use VS Code's built-in log-level controls; this extension adds no logging setting, telemetry, upload or workspace log file.
Application-generated records are capped at 8,000 characters, marked if truncated, and exclude terminal/control/bidirectional formatting characters.
Repeated protocol/runtime warnings are limited to one detailed record per code and generation per five seconds, with suppressed totals at the next eligible warning or generation end.
Unknown codes share one key; each generation has fewer than 32 keys.
Final outcomes and Sidebar warnings are not suppressed.
No unbounded application log buffer is retained.

VS Code log files can outlive the current window.
Review log files before sharing; allowlisting is not a guarantee that every future diagnostic is safe.
This extension does not provide secure erasure of VS Code-managed logs or backups.

## Data Bounds

Text attachments are limited per item and in aggregate.
Image attachments are limited by count, MIME type, canonical Base64 encoding, decoded byte size, a 16,777,216 decoded-pixel ceiling, and active-model capability.
Clipboard images are validated in both the webview and Extension Host, and SVG payloads are rejected.
Transcript descriptors contain only bounded IDs, labels, MIME, dimensions, and availability.
Base64 is never written to `workspaceState` or included in routine streamed `state` messages.
Payloads are sent once per resolved Webview and retained in oldest-first 100-asset / 25 MiB Extension Host and Webview caches; each image remains capped at 5 MiB.
Pi history image extraction starts only after selecting the retained 100-message suffix, then permits at most 25 MiB of estimated decoded image work per synchronization while walking messages newest first.
Cache eviction, browser decode rejection, or missing/invalid Pi history produces a labeled unavailable placeholder instead of repeated corrupt delivery, unbounded recovery, or unsafe rendering.
The Extension Host keeps a bounded 1,000-ID rejection set so browser-rejected content is not re-admitted on later history refreshes.
RPC JSON lines, bridge requests and responses, editor selections, diagnostics, tool output, persisted messages, completion context, change snapshots, and background-task output are bounded.

## Transcript and Status Behavior

Provider thinking is a presentation-only assistant field.
Extraction retains only the indexed visible string, redacted flag, and truncation flag.
Opaque thinking, text, and tool-call signatures are not copied into this field, public sidebar state, HTML, or VS Code workspace persistence.
A redacted block discards any accompanying text and displays a fixed unavailable-content label.
Thinking uses DOM `textContent`, not HTML or Markdown execution, and control/bidirectional override characters are removed while newlines and tabs remain readable.
The existing CSP is unchanged.

Thinking shares the 100-message / 250,000-character retained transcript budget.
Each stream retains at most 128 text/thinking blocks; history extraction retains at most 128 thinking blocks per assistant message.
Character or block omissions have explicit truncation markers.
Indexed block-end content replaces streamed deltas; the final assistant message and later Pi history replace partial presentation.
Stream ownership is cleared on retry, settlement, process exit, and session changes.
A session change removes its incomplete message immediately.
History responses from an older synchronization or session are discarded.
Thinking never enters answer text extraction, prompt construction, or edit-proposal parsing.
Pi can retain thinking in its own session files under its normal data policy; the extension restores it from Pi rather than its workspace cache.
Disclosure state is local to the current panel.

Submitted attachment descriptors are captured before asynchronous startup and attached only to that user turn.
Acceptance consumes only the captured draft IDs, so context added during startup remains queued; rejected or cancelled submissions keep their draft attachments, and retry retains its original descriptor snapshot.
Stable image IDs are SHA-256 hashes of validated bytes and let Pi history recover locally known labels without persisting duplicate payloads.

Foreground tool calls appear in conversation order between assistant responses.
Pi history restores retained calls and their correlated results after refresh.
The panel retains at most 30 calls, with up to 8,000 characters each for input and output, within the shared 100-message / 250,000-character transcript budget.
At a history window boundary, a response and its retained tool calls move to the earlier window together.
If one source entry exceeds a complete window, the answer has priority; omitted tool details cannot be recovered separately through Earlier.
Tool payloads are not saved in VS Code workspace storage.
Pi session history has its own retention.
Edit proposals, file changes, and background agents keep their separate workflow surface.
Thumbnail decode adjusts the scroller only to preserve a bottom-following reader or compensate for inserted height.
Cancellable foreground startup, work, tool, settling, and cancellation states expose **Stop**.
Composer locks, hints, and runtime status use the same foreground state, and transient lock warnings clear when the lock ends.
Operational notices use short primary summaries and an explicit **Show Output** action.
Runtime warnings use fixed summaries for known codes and a generic summary for unknown warnings.
Raw runtime diagnostics and paths do not enter the notice or Output.
Queued-instruction uncertainty takes precedence over nested runtime warnings so the UI never encourages a blind resend.

## Pi Extension Status and Text Widgets

Foreground Pi RPC `setStatus` and text-array `setWidget` updates use insertion-ordered, memory-only maps.
Keys are protocol values, not verified extension identities.
Extension text cannot set host connection, permission, pending-delivery, or Stop state.
Separate labelled, keyboard-readable scroll regions have bounded height; their diagnostic never replaces a host warning.
No global VS Code Status Bar entries are created.

Each client/session generation permits 16 status keys and 16 widget keys.
Keys permit 1–128 UTF-16 code units.
Status values and individual widget lines permit at most 1,000 input code units; widgets permit 20 lines.
Retained raw keys and normalized text share a 32,000-code-unit budget.
Replacement retains insertion order; omitted values remove only the matching raw key; an empty array retains an empty widget.
Omitted placement means `aboveEditor`; only `aboveEditor` and `belowEditor` are accepted for non-removal updates.
Invalid records, invalid placement, key overflow or character overflow leave earlier entries unchanged and set one fixed diagnostic per generation.
New entries never evict other entries or host controls.

The host removes terminal escape sequences, terminal string payloads, C0/C1 controls, Unicode line separators and bidi overrides from displayed text and key labels.
The renderer uses DOM `textContent`, not HTML, Markdown, link handling, ANSI interpretation or executable components.
Existing CSP is unchanged.
All extension UI events remain subject to the existing bounded RPC frame parser; retained state and rendering are coalesced through the sidebar's 33 ms state timer.

New/switch operations clear state before Pi can emit fresh session UI.
Client replacement, failed startup, stop, disconnect and extension disposal also clear it.
The runtime subscription checks current-client identity before forwarding an event, including late callbacks from a replaced client.
Resource reload and branching integrations must call `resetExtensionUi()` before replacing their runtime/session.
No snapshot endpoint or persistence is assumed; only newly emitted events repopulate cleared state.
Panel re-resolution within the same runtime can display current memory state.
Other UI methods and trust, canonical-path, permission and edit checks keep their existing boundaries.

## Workflow Snapshots

Git review uses fixed argument vectors, no shell, no external diff/textconv, no optional index writes, bounded output, and cancellation deadlines.
Staged capture compares HEAD/index; unstaged capture compares index/worktree including non-ignored untracked files; complete working-tree capture compares HEAD/final files; branch capture compares the selected merge-base/HEAD trees.
Bases are chosen from at most 200 enumerated local/remote refs, never arbitrary revision arguments.
No fetch occurs.
Capture permits 100 reviewed files, 100 KB per side, 400 KB retained text, 200 KB diff and 45 seconds; excluded files remain marked not reviewed.
Worktree snapshot reads retain the root/ancestor directory identities and nanosecond change/modification times.
After opening the leaf, they verify its canonical path, unchanged ancestor chain and named/opened identity before reading, then repeat those checks before retaining text.
Opened file type, link count and size are checked independently of the earlier pathname stat; POSIX nonblocking opens avoid waiting on a substituted FIFO.
Observed parent swaps, including a renamed parent restored after open, fail closed and descriptors are closed on rejection.
These are snapshot consistency guards, not filesystem-wide atomicity against external processes.
Repository identity, HEAD and index entries are revalidated for mutable scopes, along with changed/untracked names and retained contents for worktree scopes.
Branch review revalidates selected base OID, merge-base and HEAD, independent of dirty index/worktree state.
Unstaged renames are shown as deleted/added paths rather than inferred rename matches.
Findings are checked against captured text and cannot invent paths or ranges.
Up to eight reviews are memory-only, replaced per repository/scope.
Problems point to immutable before/after documents, explicitly labelled captured scope/time, not live worktree diagnostics.
Native Problems clicks can reopen historical captured text without a fresh Git check; explicit finding navigation, Ask and Fix always revalidate repository/session/snapshot identity.
Stale detection clears that review.
A fix requires an after-image matching the current writable document inside the selected workspace, rejects nested symlinks, and revalidates on Preview and Apply.
After canonical path validation, it opens the target through the selected folder URI so an existing aliased buffer and its version participate in every check.
The after-image comparison runs after asynchronous writable preflight; a buffer change during that check cannot authorize a fix request.
Before-images and diverged worktrees are ask-only.
No snapshot persistence is added; approved Pi requests retain the ordinary provider/history behavior.
Source snapshots are sent only after confirmation; existing Pi history and later tool reads remain separate context.
Git read paths disable hooks, fsmonitor, external diff and textconv; result capture disables configured clean/smudge/process filters, and inherited `GIT_*` overrides are removed.
Non-UTF-8 path records reject capture.
Unsafe paths and binary/symlink/submodule files are excluded rather than interpreted as model-selected filesystem targets.
Task import also excludes executable-bit changes/additions instead of silently losing mode changes.

Isolated-task metadata records the exact detached base and originating repository identity.
Import revalidates task inactivity, source revision, destination identity, clean affected buffers and base-or-already-imported content before writes.
Legacy or interrupted tasks with unverifiable inactivity cannot import.
PID reuse fails closed.
Import never stages, resets, changes branches, or deletes the source worktree; partial I/O failures report exact applied/skipped/failed paths for recovery.
Explicit worktree removal is destructive and separately confirmed.
Missing or unowned cleanup paths fail closed.

## Semantic Context and Diagnostic Repair

Semantic actions require a trusted file-backed workspace before invoking language providers.
Provider commands can activate third-party language extensions; read-only means no requested mutation, not a sandbox for provider code.
The adapter normalizes definitions/references/symbols/call hierarchy, rejects malformed, cross-workspace and symlink targets, and limits results to 50 with a shared five-second provider deadline.
Normalized results are deduplicated and ordered by file path, then numeric start/end line and column before the 50-result limit.
Cancellation/timeout discards late results but cannot stop an extension's internal provider work.
The authenticated foreground-only `vscode_code_context` bridge returns only metadata (zero-based ranges, one-based source input); 1 MiB bridge frames and the Pi tool's 50 KB/2,000-line output truncation still apply.
Manual attachments can include 20 excerpts of 4,000 characters each, under existing item/aggregate bounds; they use ordinary inspect/redact/pin/explicit-send behavior, and require reattachment rather than single-file refresh.

Workspace diagnostic repair selects up to 100 errors/warnings across 20 regular files in one canonical workspace matching Pi's working directory.
Snapshots include exact dirty-buffer content/version, with 100,000 characters per file and 400,000 serialized characters per request/response.
Inspection and modal transmission confirmation precede a read-only Pi request.
Strict JSON replacements can target only captured paths; unknown/duplicate paths, operations, binary content and oversized responses are rejected.
No files are created, renamed or deleted.

Diagnostic capture freezes all already-dirty editor buffers and versions before asynchronous file checks and does not reopen them.
Other documents must match a bounded, descriptor-bound disk snapshot before inspection or transmission, even if they become dirty during opening.
The shared worktree/diagnostic reader checks canonical containment, ancestor metadata, named/opened inode identity, file type, link count and byte bounds before reading and again before retaining bytes, and always closes the descriptor.
Diagnostic reads allow up to 400,003 disk bytes while retaining the 100,000-character text limit.
Matching accounts for UTF BOMs, configured encodings supported by Node's strict `TextDecoder`, and VS Code line-ending normalization.
VS Code's Shift JIS, EUC-JP/KR, KOI8-R/U, Mac Roman and Big5 identifiers are normalized alongside UTF/Windows/ISO labels.
A recognized label does not guarantee identical codec tables: unsupported codecs, malformed bytes, decoder/editor mapping differences (such as some Big5-HKSCS extensions or ISO-8859-1 control bytes), and changed text still fail closed.
VS Code may itself load a raced path, but unmatched text is not retained in the workflow snapshot or sent to Pi.
These checks do not provide filesystem-wide atomicity against external processes.

Workspace-root symlinks/junctions are supported as editor URI aliases: semantic lookup/excerpts and diagnostic repair derive relative names from the selected folder URI, then validate them against its canonical root.
Diagnostic capture rechecks that root binding after asynchronous document/writable checks.
File and directory symlinks below that root remain excluded.

Multi-file proposals namespace hunk IDs and preview each selected file.
The captured editor workspace path must still resolve to the captured canonical root at Preview and Apply, including after asynchronous preflight.
Apply acquires the canonical directory gate, preflights all proposal paths, content, versions and writable states, then rechecks all versions after asynchronous checks and sends one `WorkspaceEdit`.
A false apply result is an error, never a compensating write.
Native Undo and Source Control are recovery tools.
External processes and other windows can still race validation.
Post-Apply observations last one second: diagnostics are reported disappeared, still present or not revalidated; no event is not proof of a fix, and disappearance never means tests passed.
Proposal callbacks, observers, virtual content and finding collections are disposed rather than persisted.

## Composer File Completion

Completion runs locally in the workspace Extension Host and does not call Pi.
Only the trusted file-backed workspace whose canonical root matches the active working directory is searched.
A workspace-root URI alias is supported; nested links, traversal, non-file schemes, hard-linked leaves and outside-root results are rejected.
Discovery uses stable `findFiles` with enabled boolean `files.exclude` / `search.exclude` patterns and fixed generated-directory exclusions.
It does not interpret `.gitignore` or conditional exclusion objects.
Add sensitive paths to the supported exclusions; filenames can otherwise appear locally before capture.
Queries and results are not logged or persisted.

Each query carries a bounded ID, composer revision, full draft, cursor and parsed token range.
The host keeps at most 30 random candidate IDs from up to 2,000 discovered names, sorts paths, and cancels discovery after two seconds.
Queries permit 256 characters and paths 1,024 characters.
Input, cursor, selection, composition, navigation and session changes invalidate old results.
Selecting a candidate is single-use and expires after 30 seconds.
The composer briefly locks text and cursor changes during capture, blocks Send, and releases after success, failure or a five-second capture deadline.
Programmatic draft changes cancel capture before replacing text.
Late results cannot replace a newer draft.

Tab path insertion checks the candidate path but does not open the document or read its contents.
`@` capture uses descriptor-bound bounded disk reads before and after editor opening, with canonical root/ancestor checks.
Clean document text must match safely captured disk bytes under the configured encoding.
An already-dirty buffer is captured without reopening and its version is checked after asynchronous validation.
Binary, oversized, stale or replaced files fail without changing the token or attachment list.
Successful capture uses the existing attachment pipeline, including text limits, sensitive-name warnings, inspection, redaction and pins.
The matched token is removed only after capture succeeds.
Captured text reaches Pi only through an explicit ordinary submission.
These checks are not filesystem-wide atomicity against external processes.
No shell quoting contract is added; `!` and `!!` drafts do not complete.

## Context and Test Evidence

Attachment inspection shows exactly the queued snapshots, not all provider context.
Pins are bounded in-memory text, expire with session/reload, and never refresh silently.
Redaction creates a new revision; accepted sends remove only the consumed unpinned IDs.
Filename/secret warnings and log redaction are best-effort, not guaranteed detection.
Attachment editing uses a normal untitled editor that VS Code may back up for hot exit; close/discard it after use.
Debug/test redaction uses password-masked literal replacement and fresh read-only inspection instead of an untitled copy.
This extension does not persist raw debug snapshots/checkpoint text; normal user-approved provider transmission and Pi history have their usual retention.

Test commands are user-supplied executable/argument vectors, not model output or shell expressions.
Each run displays the working directory and requires explicit trust/approval; it executes workspace code with the user's privileges and may have side effects.
Runs are capped at 60 seconds / 256 KiB output and own a POSIX process group.
Timeout/cancellation kills owned processes; escaped descendants and Windows descendants are not guaranteed stopped.
A hard pipe deadline returns an explicit cleanup-unverified result instead of hanging.
Each observed run is bound to the selected clean source version and disk contents, checked before and after execution and before proposing a repair.
A mismatch requires fresh evidence; external writers can still race checks.
Existing logs are explicitly selected bounded UTF-8 files (100,000 bytes), preserving multiline content without creating another hot-exit-backed editor.
Test output is inspected/redacted before a read-only repair request.
Preview is separate from Apply.
Apply requires explicit save/rerun approval and revalidates the captured workspace root, session, trust and source version after that approval, before changing the buffer.
Cancellation or rejected aliases perform no edit or save, so a later ordinary Save cannot persist an aborted repair.
No compensating write or rollback overwrites concurrent user edits.
An approved save failure still retains the edit for user recovery and prevents reruns.
There are at most two repair attempts.
Only observed process results count as test evidence; supplied logs and background model summaries are labelled accordingly.

## In-Flight Instructions

Only ordinary composer requests own the active session queue.
Callback-owned editor, review, repair and debug requests cannot accept continuations.
While queueable, Enter sends a steering message after current tool calls; Alt+Enter sends a follow-up on macOS and Linux clients, while Windows clients use Ctrl+Q, including when connected to WSL or another remote workspace.
Either path starts immediately while Pi is idle.
Slash commands are not queued.

Queued submissions capture their text-context and image snapshots in the Extension Host before asynchronous acceptance.
Text context is embedded in the queued message and up to five validated images (5 MiB each) use Pi's native `steer` / `follow_up` image field.
The selected model must support images.
Pi acknowledges queue state with message text only, so the extension keeps a private ordered in-memory ledger for attachment ownership, bounded to 30 MiB of pending or recovered attachment snapshots; oldest recovered entries are evicted when count or byte limits require it.
Public pending summaries expose only a stable instruction ID, queue kind, at most 1,000 display characters and an attachment-presence flag.
Image bytes and restoration callbacks are excluded from public runtime/Webview state, queue inspection, diagnostics and workspace persistence.
Acceptance consumes only the captured unpinned attachment IDs, leaving attachments added during acceptance in the next draft.

Queue removal is not delivery evidence.
A removed record remains privately staged until Pi emits the corresponding `message_start` with `role: "user"`; only then does the extension retire recovery ownership and add its memory-only presentation snapshot to the transcript.
Stable IDs and FIFO matching keep identical text distinct.
The final `get_messages` synchronization remains authoritative and is seeded with live attachment descriptors so validated image labels survive replacement without duplicate messages.
Missing user starts at settlement or process exit recover the instruction as uncertain instead of displaying it as delivered.

Queue state remains bounded to 10 messages / 50,000 characters.
Pi's `steeringMode` and `followUpMode` control one-at-a-time versus grouped delivery and are not overridden.
`agent_settled`, not a model-turn end, closes the request/checkpoint.
Cancellation clears pending instructions before abort.
Verified clearing preserves text and attachment snapshots in the recovery picker; unsupported commands, missing queue-state acknowledgement, inconsistent ordering or ambiguous delivery stop/disconnect Pi and mark retained drafts uncertain.
A malformed acknowledgement after an authoritative user start disconnects safely but does not make that delivered instruction replayable.
Recovery is explicit and never replays automatically.
Attachment payload recovery and queued transcript presentation are memory-only and do not survive an Extension Host reload.
Review history before resending an uncertain draft.
Draft insertion and accepted-send clearing check the composer revision, and attachment restoration fails atomically if newer draft attachments have consumed its limits.

## Composer Draft Recovery and History Navigation

Text draft retention is off until the user accepts a workspace-specific non-secret storage notice.
The versioned `pi.sidebar.drafts.v1` workspaceState key is separate from transcript storage and is not enrolled in Settings Sync.
Allowlisted records contain only a hashed session-file owner (or the separate Sessions composer), text and an update timestamp.
Limits are 50,000 characters per draft, 20 records, 250,000 aggregate characters and seven-day recovery expiry.
Cleanup runs on the next activation/access; an offline workspace cannot perform scheduled deletion.
VS Code manages storage placement and backups.
On checked Linux desktop versions 1.106.0 and 1.142.0, the active envelope resides under the disposable client profile's `User/workspaceStorage/<workspace-id>/state.vscdb`, in the `ItemTable` row for `narumi.narumi-pi`.
With the checked VS Code Server web clients, it resides in the client browser's workspace IndexedDB `ItemTable` row, not the remote server's active storage rows.
A remote Extension Host does not imply server-side workspaceState retention.
That host still receives and processes draft updates through VS Code's authenticated connection; client-side retention does not mean the text stays off the remote host or its transport.
These updates are not model/provider requests.
These observations cover local desktop and loopback web-remote clients, not Remote SSH/WSL/container or cross-machine deployments.
The approval notice states that other remote layouts remain unverified.
No credential-storage or secure-erasure guarantee is made.

Attachments, pins, image bytes, extension-dialog text and queued-message recovery ledgers do not enter this store.
Debounced text updates carry a random view/session binding and monotonically checked composer revision.
Accepted sends remove only their captured draft revision; serialized writes cannot replay an obsolete snapshot over a later clear.
Context changes and late replies cannot clear newer input.
Kept text with uncertain context blocks normal composer submission until the user verifies the session and clears it.
Restore requires an empty unchanged composer and is an insertion only, never a send, queue or shell dispatch.
Discard removes the current record; Disable and discard all removes the owned key.
Storage failures are reported and can leave older persisted bytes; do not rely on recovery as a backup.

Conversation history navigation uses only public `get_messages` while the existing idle/session ownership checks permit it.
Each request is generation/session/client-bound; new work, resource/branch transitions and process replacement invalidate stale results.
Each request obtains a full active-branch response under the unchanged 5 MiB frame bound, then retains a replacement window of at most 100 messages and 250,000 shared content/thinking characters.
Earlier windows do not replace the persisted latest cache.
Omitted long-message portions are labelled and not independently retrievable.
No raw session-file read, private pagination API or model prompt is used for browsing.

Search is local literal case-sensitive matching over current-window rendered answer/shell text, including code/diagram source, but excluding thinking, tool details, images and rendered SVG text.
Search work is bounded to 250,000 text characters, 256 query characters and 1,000 match ranges.
CSS Highlight ranges do not modify source nodes; unsupported highlighting does not execute another rendering path.
UI explanations, search controls and native Quick Pick groups do not replace host trust, permission, operation-owner or stale-content checks.

## Debugger Inspection

Only explicit paused `node`/`pwa-node` js-debug capture is enabled.
Stable VS Code 1.106 APIs bind the selected frame to a tracked pause generation; continue, step, restart, frame changes and termination invalidate capture.
Requests are limited to `stackTrace`, `scopes` and one non-expensive local `variables` scope: 20 frames, 50 candidates, 1,000 characters/value, 20,000 total characters and a five-second deadline.
No evaluate, mutation, memory, recursive or lazy-value requests are sent.
Custom description/property generators and automatic getter expansion must be disabled.
Configuration is resolved against the debug session's workspace URI and rechecked before DAP reads.
The checked adapter read path can still perform adapter-specific inspection work; this is not a promise of inert evaluation across debugger versions.
Raw launch configuration/environment are excluded, and source excerpts require clean bounded regular files inside the workspace.
Capture and variable selection are local; only a second inspected/redacted snapshot plus an explicit question can reach Pi.
Debug snapshots cannot be pinned.

## Isolated Provider Authentication

Provider sign-in/sign-out is separate from process-free native VS Code Settings and Pi Configuration.
A user command acquires foreground ownership and the canonical workspace operation gate without starting the ordinary agent.
Authentication also serializes the selected canonical Pi store within this Extension Host.
This does not lock another VS Code window; Pi owns cross-process credential-store synchronization.
No credential file is copied, backed up, or restored by VS Code.

The selected bundled or external Pi runtime loads the packaged helper through the documented `--extension` loader and public package root.
The helper currently requires Pi 1.3.0.
It runs with disposable working/home/agent/session directories, offline startup, no discovered extensions/MCP/tools/skills/prompts/context/themes, and an OS/runtime/proxy environment allowlist.
Provider credentials, bridge tokens, Node hooks, and ordinary user settings are not inherited into bootstrap.
Static built-in provider discovery uses an empty isolated credential store, `modelsPath: null`, `refreshOnCreate: false`, and `allowModelNetwork: false`.
It does not invoke credential checks or read the selected store.

Only explicit host/store/provider approval permits a login/logout request containing the selected store path on stdin.
The helper then calls public `ModelRuntime.login`/`logout`; it never returns a Credential.
Secret, private text, and complete manual redirect values use dedicated password-masked native input, not the generic RPC input/editor or a webview.
Provider prose and raw errors are discarded.
Browser/device URLs require HTTPS, no credentials/fragment/controls, and explicit native approval.
The complete URL is preserved; Pi owns redirect state/expiry and provider callback behavior.
A cancelled prompt or finished helper invalidates pending native input/browser approval, and late answers cannot be sent to another flow.

Frames are LF-only UTF-8 JSON, at most 16 KiB, with 256 KiB total helper output, at most 100 prompts and 20 browser/device events, 8,192 input characters, a 15-second startup deadline and a five-minute operation deadline.
Malformed/oversized fragments fail before another newline.
Disposal aborts owned helpers and input listeners.
Cleanup remains bounded with explicit uncertainty, including Windows descendants.
No secret values enter process arguments, browser state, extension storage, transcripts, telemetry, or diagnostic editors.
Complete redirect URIs are private input; only the provider's authorization URL can open in the browser.

Store-change success and credential-changed/catalog-refresh-failed are distinct.
Running model selection and conversation state are not changed; refresh requires explicit Pi restart.
Cancellation, failure, or uncertain completion never starts another login.
Sign-out is store deletion, not provider revocation; environment and model-configuration credentials can remain effective.
Live-provider/remote authorization and provider-specific configuration prompts are not validated; custom extension providers are not loaded by this helper.

## Session Transfer and External Sharing

Local JSONL operations use the same isolated helper and public Pi session APIs.
The host validates the full v3 file before handing a private staged copy to Pi.
Owned staging directories are canonicalized, including when the system temporary path has a symlinked ancestor.
Selected source/destination path checks are not relaxed.
Image character checks use a stack-safe scan; canonical decode/re-encode equality and all byte limits remain required.
It rejects unsupported versions, invalid UTF-8, missing final newline, unknown entries/roles/blocks, duplicate IDs, orphaned/forward/cyclic parents, invalid branch-relative compaction/context-edit references, unsafe paths, symlinks/hard links, and cross-workspace cwd.
Capture uses descriptor-bound identity/ancestor checks.
Bounds are 32 MiB per file, 8 MiB per line, 50,000 entries, depth 64, 500,000 data nodes/reference steps, and 5 MiB/image with 25 MiB total image data.
These limits bound retained work; they are not filesystem-wide atomicity against external processes.

The packaged control command has one read-only `session-location` action.
Under the already-held foreground operation, the host verifies packaged command ownership before dispatch and requires a correlated `handled` result.
Public SessionManager reads return canonical `getSessionDir()` and session file, session ID, leaf and a SHA-256 digest, not entries.
Each entry is serialized separately with an LF separator; capture rejects more than 50,000 entries or 32 MiB of serialized entry bytes.
The response is capped at 16 KiB.
The read does not reset UI, change the control generation, or emit `resources_reloaded`.
A Pi-assigned, not-yet-written session leaf resolves through its existing canonical parent without creating a file.
This permits import from a new unsaved session; export and sharing still require a readable persisted source and matching entry digest.
Missing command dispatch remains blocked by the independent read-only gate.

JSONL export uses Pi's captured active leaf and public `exportToJsonl`, not the bounded sidebar transcript.
The descriptor-bound source is limited to 32 MiB before parsing.
Parsed entry serialization must match the in-memory digest.
Origin, canonical locations, leaf, digest and source bytes are checked again before local transfer or approved upload; a matching leaf alone cannot authorize export.
The helper uses an in-memory SessionManager so SDK initialization cannot append metadata to the source.
HTML retains Pi's full-tree rendering, which can include abandoned branches.
Local export is network-free and exclusively creates a new regular file with private mode; it never replaces an existing name.
Failed writes report a retained partial output instead of deleting or overwriting another writer's data.

Import calls public `AgentSessionRuntime.importFromJsonl` against staging.
Pi can append initialization metadata to that copy.
The host validates the resulting complete tree, then exclusively creates a random-named retained copy in the directory returned by the active SessionManager's `getSessionDir()`, not the parent of an externally resumed file.
Canonical workspace/trust/origin/client checks and the operation gate precede guarded activation.
Cancelled hooks, failed activation and uncertain completion retain source/old session/copy files and do not replay switching.
Only verified activation emits the imported-session event; history must match the current client/session before display.
Verified import history can synchronize while only the foreground operation owner is busy; actual execution, a newer composer request, or a newer history generation prevents stale replacement.
Session-bound attachments, pins, proposals, streams, retry and checkpoint UI are cleared on that verified transition, not on a failed import.

Sharing is a separate destination adapter, not a bridge method or a webview upload.
Preparation and read-only inspection are local.
Only active-branch JSONL up to 2 MiB is offered for GitHub sharing; inspection covers all raw entries, including excluded shell output, images, tool arguments/output, opaque thinking signatures and extension metadata.
Literal redaction changes string values in a fresh payload without changing source files.
It invalidates inspection and can make the shared JSONL non-resumable.
The exact latest payload must be inspected before a separate modal upload approval.
Inspection data is memory-only; native read-only documents can remain visible until closed.

The adapter runs `gh gist create --public=false --filename pi-session.jsonl -` without a shell, fixes the destination to github.com, and sends only the approved bytes on stdin.
GitHub credentials remain with gh.
Output is capped at 64 KiB and execution at 60 seconds.
Raw CLI diagnostics are discarded.
Returned links must be HTTPS gist.github.com user/hex-ID URLs without tokens/fragments.
A timeout, cancellation, malformed response or lost process result is an uncertain upload, never an automatic retry.
A non-public gist is readable by anyone with its link; remote deletion is a separate action.
Local deletion does not delete an uploaded copy.
Radius is blocked because its artifact transport has no verified public contract; no private module or endpoint is called.

## External Services

The selected Pi provider receives prompts and context according to its own privacy policy.
Git hosting, SSH, cloud agents, MCP servers, and other Pi-extension services are separate external dependencies with their own authentication and data policies.
