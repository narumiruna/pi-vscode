# User guide

Use the [overview](../README.md) for requirements, Marketplace installation, and first use.
This guide contains detailed controls, compatibility boundaries, and operational limits.

[Installation alternatives](#installation-alternatives) · [Runtime selection](#runtime-selection-and-recovery) · [Conversation controls](#conversation-controls) · [Workflows](#focused-workflows) · [Settings](#settings) · [Security](#security-and-limits) · [Extension bridge](#extension-bridge)

## Installation alternatives

If you have `narumi.pi-coding-agent-vscode` installed, follow [Upgrade from the old extension ID](#upgrade-from-the-old-extension-id) first.

For normal installation, use the [Marketplace instructions](../README.md#install).
The optional release installer requires `curl`, a POSIX shell, and the VS Code `code` command.

1. Download the script:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/narumiruna/pi-vscode/main/scripts/install.sh -o install-pi-vscode.sh
   ```

2. After a successful download, inspect `install-pi-vscode.sh` before executing it.
   See also [`scripts/install.sh`](../scripts/install.sh).
3. Execute the inspected script:

   ```bash
   sh install-pi-vscode.sh
   ```

   To install a specific version, pass it at this step instead, for example `sh install-pi-vscode.sh 0.0.2`.
4. Remove the downloaded script after installation:

   ```bash
   rm install-pi-vscode.sh
   ```

The installer downloads `pi.vsix`, installs it with `code --install-extension`, and removes only the legacy global bridge files created by older releases.
Extension activation performs the same cleanup for direct VSIX and Marketplace upgrades before starting Pi.
New installations do not create files under `~/.pi/agent`.

For manual installation, download `pi.vsix` from [GitHub Releases](https://github.com/narumiruna/pi-vscode/releases) and use **Extensions: Install from VSIX…**.

After installation or an update, run **Developer: Reload Window**.
Sidebar sessions and **More… → Open in Terminal** load the bundled bridge automatically.
See [Extension bridge](#extension-bridge) to use its tools in an ordinary integrated terminal.

## Runtime selection and recovery

The extension includes the exact production dependency `@earendil-works/pi-coding-agent@1.3.0`.
No separate Pi or Node.js installation is required for the default runtime.

1. An unset, empty, or whitespace-only `pi.executablePath` selects bundled Pi.
2. Any nonempty value selects external Pi on the workspace Extension Host.
   This includes a saved `pi` command, an absolute path, or a directory-qualified path relative to the workspace launch directory.
   Existing User, Workspace, and folder overrides are not rewritten.
3. Reset removes only the selected target's override.
   The resulting effective value selects either another external override or the new bundled default.

Upgrades without an executable override use bundled Pi automatically.
Older Settings pages could save the old `pi` default even when its value was unchanged.
That saved value cannot be distinguished from an intentional external choice, so it is not silently rewritten.
To use bundled Pi, reset the effective override in native Settings; check User, Remote, Workspace, and folder values as applicable.

The extension remembers a session for reload only after its saved header can be read and its workspace matches.
Older versions could remember an assigned path before Pi wrote the session file, causing `ENOENT` after an upgrade or reload.
If that remembered file is absent, startup automatically clears only the restore reference and starts a fresh session with the selected runtime.
No confirmation dialog appears; any pending request continues in that new session.
A short notice in the Sidebar reports that a new session was started.
Existing session files are not deleted or recreated.
Invalid headers, a missing workspace recorded in an existing header, permission errors, and invalid bundled assets do not use this missing-file recovery path.
Bundled Pi fails without a replacement for those errors.
External Pi retains its earlier automatic fresh-session fallback for other restore errors.
History synchronization failures do not use either fallback; existing session references and files are preserved, without automatic replacement-session creation or request replay.

Bundled Pi starts as a separate process through the workspace Extension Host's `process.execPath` and a small packaged bootstrap.
The bootstrap starts the absolute pinned npm entry `dist/bundle/cli.js`, not a command found on PATH.
Desktop Electron uses `ELECTRON_RUN_AS_NODE=1` only for initial startup; the bootstrap removes it before importing Pi or starting tools.
All extension-owned launches use the selected runtime, including RPC, focused requests, helpers, diagnostics, background/worktree agents, and controlled terminal handoff.
Ordinary user-created terminals are unchanged; bundling does not install a `pi` command or change PATH.

Ordinary launches reuse the Extension Host's existing `~/.pi/agent` or `PI_CODING_AGENT_DIR`, normal session storage, configured resources, and provider environment.
No credentials, configuration, or sessions are copied, migrated, or isolated by runtime selection.
The isolated authentication/session helper still uses disposable stores and its environment allowlist until an explicitly approved operation selects a store.
User-installed Pi extensions must be compatible with Pi 1.3.0; bundled Pi does not guarantee compatibility with every extension.
External Pi keeps its existing Node/shim lookup and `PI_PACKAGE_DIR` behavior.

Extension releases own bundled Pi updates.
Bundled launches set `PI_SKIP_VERSION_CHECK=1`, clear `PI_PACKAGE_DIR` and `PI_MANAGED_INSTALL_ROOT`, and reject an initial CLI `update` command before importing Pi, including with a configured `npmCommand`.
Pi 1.3.0 has no built-in TUI `/update` route.
This does not change external Pi updates or commands in ordinary terminals.

Settings changes affect new processes, not a running client.
Use the explicitly confirmed **Restart Pi (Current Launch Policy)** action to apply a changed runtime to the current persistent session.
Opening or saving Settings does not start or validate Pi.
Trust, project-resource approval, tool permissions, Preview/Apply, and terminal ownership checks remain unchanged.

If bundled assets are missing or invalid, startup fails without PATH fallback, a replacement session, or automatic operation replay.
Reinstall the extension, or set `pi.executablePath` to compatible external Pi and use the confirmed restart flow.
Inspect uncertain work and resolve terminal ownership or cleanup warnings before restarting or repeating an operation.
An extension downgrade does not roll back shared credentials or session formats; preserve backups and check compatibility before using older Pi with newer data.

Remote SSH, WSL, and container windows resolve the package and stores on the remote workspace Extension Host, not the local UI computer.
A universal asset layout is not proof that every platform or remote topology has been tested.
See [Bundled runtime validation](BUNDLED_RUNTIME_VALIDATION.md) for separate platform results and release gates.

## Windows process launches

Bundled Pi uses the Extension Host runtime and does not need a PATH Node executable.
The following external-Pi rules remain unchanged.

External Pi supports native `.exe` files and the standard npm `cmd-shim` Node template without custom shebang arguments or environment assignments.
The extension resolves that template to its JavaScript entry point and starts `node.exe` directly, without a command shell.
For external npm shims, Node must be beside the shim or in the child PATH; the VS Code executable is not substituted for Node.
Custom `.cmd`/`.bat` wrappers are rejected with a launch error.
Use a native executable or reinstall Pi with npm when a wrapper is unsupported.
This restriction does not change an explicit terminal handoff.

Executable lookup uses the final child environment.
Windows environment keys are case-insensitive; PATH overrides and removals apply before lookup.
Bare names search nonempty PATH entries in directory order, preferring `.exe`, then `.cmd`, then `.bat` in each directory.
Quoted PATH directories are supported; relative entries use the child working directory.
Missing or empty PATH does not search the parent PATH, system directories, or the workspace implicitly.
Explicit directory-qualified paths use the workspace launch directory.
Drive-relative paths such as `C:pi.cmd` and rooted paths without a drive are rejected, including in PATH entries.
Quoted empty PATH entries are ignored.

Stopping or cancelling targets the actual runtime, not a shell.
Cleanup has bounded exit and pipe deadlines.
Windows reports that descendant cleanup is unverified; a root-process exit is not proof that every tool or detached descendant stopped.
Foreground cleanup warnings remain available through session deletion and failed startup cleanup.
Check remaining work before starting conflicting operations.

## Get started

1. Run **Pi: Open Sessions** from the Command Palette, or open **Pi** in the Secondary Sidebar.
   Choose a session from **Sessions**, or use **View all** to search the current workspace.
   Sending from the Sessions-level composer starts a new session; **Back to Sessions** returns there from a conversation.
2. Choose the **Attach** icon to add code, files, or images, or paste a supported image with Ctrl/Cmd+V.
3. Enter a request.
   One composer button shows the active model and thinking level.
   Open it to choose **Change Model** or **Change Thinking Level**.
   Open **More… → Conversation details → Submission help** for shortcuts.
4. For proposed changes, use **Choose Hunks → Preview → Apply**.
   If you change the hunk selection after Preview, choose Preview again before Apply.
5. Open **More…** for session management, export, terminal handoff, staged review, repair tools, checkpoints, and background or worktree agents.
   Open **More… → Conversation details → Session details** to select and copy the full session ID and inspect context usage.

Use `@pi` in VS Code's native Chat view when you prefer the native participant workflow.
Native Chat history is separate from the Pi sidebar session.

### Switch sessions

Run **Pi: Switch Session** (`pi.switchSession`) to open a native searchable Quick Pick.
Search matches titles and session IDs; **Current** identifies the active saved session.
Press Enter to resume the selected session, or Escape to cancel without changing the conversation or composer.
Selecting the active session is a no-op.

| Action | Windows/Linux | macOS |
| --- | --- | --- |
| Switch Session | Ctrl+K, then Ctrl+Alt+Shift+S | Cmd+K, then Cmd+Alt+Shift+S |
| Previous Session | Ctrl+K, then Ctrl+Alt+Shift+Left | Cmd+K, then Cmd+Alt+Shift+Left |
| Next Session | Ctrl+K, then Ctrl+Alt+Shift+Right | Cmd+K, then Cmd+Alt+Shift+Right |

The previous/next command IDs are `pi.previousSession` and `pi.nextSession`.
Change these shortcuts in VS Code **Keyboard Shortcuts** if needed.
The defaults do not run in terminal input or while another Quick Pick is open.

Discovery uses the active session directory on the workspace Extension Host, keeps at most 100 saved sessions with matching canonical workspace, and shares a 64 MiB metadata-read budget.
It is not a complete search across all Pi stores.
The first navigation can start or restore Pi through the normal trusted startup path; it does not send a model request.
Use **More… → Resume Session** to select a saved file outside this discovered list.
A session from another workspace or worktree must be opened in its matching VS Code window.

Next moves forward through a newest-first snapshot; Previous moves backward, and both wrap around.
Updates to session modification times do not reorder an active cycle.
Search selection, other session transitions, changed membership, resource controls, and client/workspace changes rebuild the cycle.
An unsaved current session is not a resumable destination; Next starts at the first saved entry and Previous at the last.
An empty list does not switch; a list containing only the active session is a no-op.

Switching requires an idle trusted file-backed workspace, sidebar ownership, and no pending queues or extension dialogs.
Repeated navigation while a picker or switch is pending is rejected rather than queued.
Existing draft binding and recovery checks remain in effect; switching does not automatically restore or send a draft.
Attachments, edit proposals, checkpoints, and retry state clear through the successful conversation transition.
Extension-provided status and widget text reset before dispatch so fresh destination updates cannot mix with outgoing UI.
If switching succeeds but history refresh fails, use **Refresh history** or reconnect as directed; do not repeat the switch to recover history.
An uncertain authoritative runtime refresh disconnects safely rather than presenting the old session as usable.

### Conversation controls

- One primary status area stays inside the composer, directly above the composer box and outside the transcript and workflow scrollers.
  Its location is the same in Sessions and conversations.
  Idle reserves one line without Ready text or a dot; single-line progress does not move the composer box.
  Long actionable text and recovery buttons can wrap and increase its height.
- Status priority is problems, submission blockers, progress, non-Ready results, then quiet idle.
  Empty input is neutral: its disabled-send explanation uses only an accessible description and tooltip, never a visible hint or a replacement for progress.
  The host still validates every request.
- Stop remains in the composer actions.
  Reconnect, Retry, and Refresh history stay in the status area with unchanged host availability checks.
  Blocking errors and cleanup warnings retain their separate non-dismissible notice and **Show Output** action; tool output, background cards, and extension widgets keep their placements.
- **More… → Conversation details** contains submission help, file-completion instructions, text draft recovery, session ID, context usage, and extension status.
  Close or Escape returns focus to More.
  Read-only details remain available during work or disconnect; mutation controls retain their host checks.
- Tool calls start collapsed, including while running.
  Updates and completion preserve your expand/collapse choice.
- Scroll up without following new output.
  **Jump to latest** returns to current output and restores automatic following; **New output** indicates a transcript change, not a status update.
- **More… → Word wrap**, in **Conversation display**, shows On/Off and wraps long code lines for display only.
  It starts Off and is local to the view, not a saved setting.
  Source text, copied text, shell cards, and editor files are unchanged.
- The header's **Find text** magnifying-glass icon opens literal, case-sensitive search in the current history window, including code and diagram source.
  The scope explanation appears only inside the expanded search bar.
  When full history is not loaded, a note inside that bar says search covers current text only.
  Closing search removes the note and its space immediately.
  Search excludes thinking, tool details, and images.
  Use **Previous/Next** or Enter/Shift+Enter; Escape closes search and returns focus to the icon.
- The header's **Earlier history** clock icon replaces the bounded window; its **Latest history** down-to-line icon returns to the current tail and is disabled when that window is already latest.
  Loading, earlier-window position and truncation remain visible when relevant, even with search closed.
  Absent or unavailable history alone adds no header strip, including in an empty conversation.
  Actual failures keep the composer status, notices, diagnostics and guarded recovery controls.
  Each window contains at most 100 messages and 250,000 shared text/thinking characters.
  Omitted portions of long messages are labelled and cannot be browsed.
  Persistent Pi RPC single lines now allow 64 MiB instead of 5 MiB; larger history responses remain unavailable.
  Public `get_messages` still returns the full active branch without pagination; this is not whole-session search.
  Full-response decoding and synchronous JSON parsing can still increase memory use and pause the Extension Host.
- The input's accessible description and **Submission help** distinguish `@` snapshot attachment from Tab path-only insertion.
  Message headings support assistive-technology navigation.
  Earlier Orca evidence applies to the previous layout; screen-reader behavior for this relocation requires a separate check.
- **More…** has one searchable native picker with **Session management**, **Conversation display**, **Review and repair**, **Background work**, and **Pi configuration** groups.
  Existing session and work actions remain available; **Extension Settings** and **Pi Configuration** are not duplicated here.

#### Operation diagnostics

Choose **Show Output** on a diagnostic notice to open **Output → Pi**.
This explicit action preserves editor focus; success, failure, activation and process exit do not open Output automatically.
Short results and recovery instructions stay in the Sidebar.
A failed deletion still states that the session was kept.
Deletion confirmations and Pi-requested dialogs are unchanged.

The shared log records safe lifecycle, request, deletion/recovery, RPC, history/storage and inline-completion outcomes.
It uses fixed categories and host-generated operation IDs/client generations, not conversation content, session names/paths or credentials.
Unknown errors remain `unknown`; raw errors, stdout/stderr and invalid frames are excluded, including at Debug/Trace.
Locally typed frame-too-large errors use a safe allowlisted Output category and a fixed Sidebar notice, without raw frame, error or path data.
Use VS Code's built-in log-level controls for additional safe timing records.
Logs are not a full process transcript and do not establish that detached work stopped.
Follow uncertainty instructions before repeating commands.

VS Code owns log-file storage and retention.
Files can outlive the window; review them before sharing.
See [Operational logging](SECURITY.md#operational-logging) for the metadata and volume limits.

#### Text draft recovery

Open **More… → Conversation details → Text draft recovery → Enable recovery** to review and accept draft retention before saving any composer text.
This is for non-secret text only.
The extension uses workspace-scoped VS Code `workspaceState`, without Settings Sync: at most 50,000 characters per draft, 20 drafts, and 250,000 total characters.
Recovery expires after seven days; expired records are removed on the next activation or access.
On checked Linux desktop builds, drafts reside in the local profile's workspace database.
With the checked VS Code Server web clients, they reside in the browser's IndexedDB workspace storage, even though the extension runs in a remote Node Extension Host.
Other remote client layouts remain unverified.
Remote draft updates still pass through the workspace Extension Host over VS Code's connection; client-side storage does not mean the text never reaches that host.
These updates are not model/provider requests.
VS Code manages backups; removal is not secure erasure.

A short **Retained text available · Review** notice appears only when a draft is available for the current scope.
It opens recovery controls, not the retained text itself.
**Restore text** requires an empty composer and never sends, queues, or executes the text.
Attachments, pins, image bytes, extension dialogs, and queued-message recovery payloads are not saved.
**Discard retained text** removes the current record; **Disable and discard all** removes the extension's draft store and disables retention.
Removal is not secure erasure of backups.
Recent edits can be lost before storage completes.
A session change preserves newer text rather than silently assigning it to another session; verify the session and clear that kept text before sending again.

See [Composer behavior and validation](COMPOSER_UX.md) for state priorities, history bounds, and validation limits.

### Pi extension dialogs

Pi extensions can request single-line input or a native multiline editor through the public RPC UI protocol (reference: Pi 1.3.0).
No model request is needed to display a dialog.

Before each multiline editor opens, accept **Open Non-Secret Editor** or press Escape to cancel.
VS Code can retain untitled text in hot-exit backups.
Do not enter credentials.
Use **Pi: Submit Extension Editor** or Ctrl/Cmd+Enter to return the full current text, including an empty value.
Use **Pi: Cancel Extension Editor**, Ctrl/Cmd+Escape, or close the document to cancel without returning a partial value.
Actions appear only for the owned active editor.
**Save does not submit** and can prompt for a file path.
On cleanup, choose **Don't Save** to discard the text; cancelling that close leaves an inactive document that you must close yourself.

Only one multiline editor request can be active at a time.
Prefill and returned text are limited to 100,000 characters.
Text uses VS Code's document line endings; mixed line endings can be normalized.
Timeouts close the owned UI locally, while Pi supplies its own timeout default.
Replies cannot move to a replacement session or process.

Untimed confirmations keep the native permission modal.
Timed confirmations default to **Block**.
**Review Full Message** opens the complete bounded Unicode/multiline message in a read-only, memory-only document.
Only that active review enables **Pi: Allow Reviewed Extension Action** and **Pi: Block Reviewed Extension Action**.
Closing the review blocks the action; timeout removes the review and disables its actions.

### Editor actions

The Pi button in the editor title opens Sessions and uses separate light and dark icons to stay visible in both themes.

| Action | Shortcut or location |
| --- | --- |
| Fix a diagnostic or open inline edit | **Ctrl/Cmd+I** |
| Request an inline completion | **Alt+]** |
| Suggest the next edit | **Ctrl+Alt+N** / **Cmd+Alt+N** on macOS |
| Add a selection reference | **Ctrl+Alt+A** / **Cmd+Alt+A** on macOS; editor lightbulb → **Rewrite → Ask Pi**; or editor context menu → **Pi → Ask About Selection** |
| Modify a selection with Preview/Apply | Editor lightbulb → **Rewrite → Modify with Pi**, or editor context menu → **Pi** |

**Ask About Selection** captures the selected text as an unsent reference above the active session's composer, including on the Sidebar's first load.
It focuses the composer without a separate question input, immediate submission, draft clearing, or replacement session.
Existing draft-context checks still apply to text kept after a view or session transition.
Repeat with other selections to add references, then describe what to discuss or change for each file/range in your message.
Each reference has its own remove button; removing one does not remove the others.
Labels show the file and one-based line/column range, with an exclusive end coordinate, so different selections on the same line remain separate.
Capturing the same range again replaces that range's snapshot.
Existing attachment limits and **Attach → View attachments** inspection, redaction, refresh, and pin controls apply.

Only **Send** submits the message and remaining references through the ordinary session workflow.
While Pi is working, references can still be staged; explicit submission uses the existing steering/follow-up queue when available.
Opening the Sidebar can start Pi through its existing startup flow; no model request is sent by reference capture.
Normal composer permissions apply to an ordinary Ask About Selection submission.

The other selection-menu actions prepare a labelled read-only action above the composer:
- **Modify Selection (Preview):** enter the desired change before Send.
- **Explain Selection** and **Review Selection:** inspect the displayed default request and optionally add details.
- **Fix Selection (Preview)**, **Document Selection (Preview)**, and **Generate Tests (Preview):** inspect the displayed preset and optionally add details before generating a proposal.

Selecting these actions adds their captured reference without a question popup or immediate request.
The action description identifies its selected range; preview generation names that range as the replacement target and treats other references as supporting context.
The displayed preset and your message are combined only on explicit Send; the action never replaces or inserts composer text.
One prepared action can be active at a time; selecting another action replaces its intent while leaving other references available.
**Cancel** removes only the action, not references or text, and returns the composer to ordinary permissions.
Changing or removing the target reference, or switching sessions, invalidates the action.
A changed or closed preview target must be captured again before generation.
The complete action reference must fit within attachment limits; select less text or remove other attachments if it cannot fit.
These read-only actions wait for idle Pi and cannot use the ordinary queue, shell/slash commands, background submission, or Sessions-level new-session submission.
After Send, preview actions generate under the read-only policy and still require **Preview** before **Apply**.
A newer draft or reference is not cleared by an older accepted submission.
The separate **Pi: Inline Edit (Preview)**, diagnostic Quick Fix, and next-edit workflows retain their existing entry behavior.

Automatic inline completions are disabled by default.
Enable `pi.inlineCompletions.enabled` to request them after a typing pause.

### Temporary passage annotations

The foreground sidebar agent can use `vscode_annotate` in already-open code or text documents.
Whole-line highlights and hovers remain available.
Read-only native comments contain explanations below each range, grouped at its end line, with **Pi** as author and **Pi annotation** as label.
They start collapsed by default.
In **VS Code Settings → Pi → Editor → Annotation initial state**, choose `collapsed` (default) or `expanded` for `pi.annotations.initialState`.
The setting applies only to newly created or replaced annotations; it does not change existing thread handles or user state on redraw.
Explanations are literal untrusted text, not verified diagnostics, and have no reply or edit actions.
The native Comments panel also lists them.
User collapse is preserved on redraw.

VS Code may auto-open the Comments panel and change editor layout or visible range/scroll during expansion, replacement or removal.
The extension does not write files, open documents/tabs, perform explicit tab/selection/focus/reveal/scroll operations, or override VS Code comments settings.
No global VS Code comments settings are written.
VS Code comments visibility settings may hide widgets.
Inactive open tabs show annotations when you return to them, subject to those settings.
Cached documents with no open text or diff tab are not eligible.

Each call replaces the annotations for one file; an empty annotation list clears that file.
The agent must supply the exact current lines.
Stale text, invalid ranges and unsafe paths are rejected without replacing existing annotations.
Use **Pi: Clear Annotations** to remove all highlights, hovers and native threads locally, even when Pi is disconnected.
The tool's result fields are unchanged: `count` is the number of accepted annotations, not thread groups; `visible` means a visible editor exists for the document, not that a comment widget is visible.

Annotations are memory-only.
Editing a document or closing its last text/diff tab removes its annotations.
Saving without text changes keeps them.
Session or branch changes, resource reload, client replacement, disconnect, terminal handoff and window reload remove all annotations.
Hiding the sidebar does not remove them.
Annotations require a trusted, matching file-backed workspace and the foreground sidebar runtime; terminal and background agents cannot use them with their ordinary bridge credentials.

Limits: 20 annotations per call, 200 lines and 10,000 expected-text characters per annotation, 1,000 explanation characters, and 100 retained annotations across 20 documents.
The temporary editor UI is not persisted; ordinary Pi tool arguments and history have their normal retention.

## Upgrade from the old extension ID

The extension ID changed from `narumi.pi-coding-agent-vscode` to `narumi.narumi-pi`.
VS Code treats them as separate extensions.
Do not keep both installed.
The release installer and `npm run install:extension` stop if the old ID is installed.
Follow these steps before using either installer, installing a VSIX manually, or installing from Marketplace:

1. In the old extension, stop active requests and background agents.
   Export any conversation you need.
   Review and save worktree results outside extension storage.
   Record worktree paths and commit or copy any changes you need.
2. Remove the old extension from the same VS Code profile and extension host where you will install the new one:

   ```bash
   code --uninstall-extension narumi.pi-coding-agent-vscode
   ```

   For a named profile, use `--profile "<profile>"`.
   In a Remote SSH, WSL, or container window, remove the old extension from that remote host through the Extensions view.
3. Run **Developer: Reload Window**.
   Install the new extension, then reload again.
4. Open **Pi: Open Sessions** and select a persistent Pi session for the current workspace.

The installers do not copy or delete VS Code state.
The old sidebar cache, last-session pointer, and background-task records do not transfer to the new ID.
Worktrees under the old extension's global storage do not transfer.
Save their results before removal.
Pi session files remain separate from VS Code extension state and can be selected from the new extension.

### Identifier changes

This release also changes the identifier contract.
Rename existing `picode.*` settings and command IDs in custom keybindings to `pi.*`; `piCodingAgent.*` settings are no longer read.
Cached sidebar messages, last-session pointers, and background-task records use new keys and do not migrate.
Persistent Pi session files are unchanged.
Bridge consumers must use `PI_VSCODE_BRIDGE_PORT`, `PI_VSCODE_BRIDGE_TOKEN`, and `PI_VSCODE_BRIDGE_EXTENSION`; create a new integrated terminal after reloading.
Prompt markers now use `PI_VSCODE_*`; old markers remain plain transcript text.

## Focused workflows

- **Staged review:** Run **Pi: Review Staged Changes**, confirm the bounded snapshot, then use **Pi: Show Staged Findings** to navigate immutable before/after content.
  Findings become stale when HEAD or the index changes.
- **Change review:** Run **Pi: Review Changes**, choose staged, unstaged (including untracked), all working-tree changes, or current branch versus a selected local/remote base ref.
  **Pi: Show Review Findings** navigates the latest captured result.
  No fetch or hosted PR access is performed.
- **Review findings:** Problems entries open immutable captured text, labelled with scope/time.
  The Problems row's Quick Fix/lightbulb menu offers **Ask Pi About Finding** and, only for an exact writable after-image match, **Fix Finding with Pi (Preview)**.
  Stale actions require a new review; Problems are not live diagnostics.
- **Workspace diagnostic repair:** Run **Pi: Fix Workspace Diagnostics (Preview)**, select errors/warnings in one workspace, inspect the complete captured files, and confirm transmission.
  Choose hunks, preview every selected file, then apply once.
  Diagnostic updates are observations, not test results.
- **Semantic context:** Choose **Attach → Definition / References / Callers / Callees / Document Symbols** at the active cursor.
  Inspect/redact or pin the captured context before sending; attach again for a fresh provider lookup.
  Missing providers produce a notice, not guessed results.
- **Selected edits:** On a proposal card, choose **Choose Hunks → Preview → Apply**.
  Changing the selection invalidates the preview; normal editor Undo remains available after application.
- **Worktree result import:** Start an isolated agent from **More…**.
  When it becomes inactive, choose **Review Results → Apply Selected** to import reviewed text files into the originating worktree.
- **Attachment inspection:** Choose **Attach → View attachments** to inspect the exact snapshot, text-token estimate (excluding image tokens), redact or edit it, refresh it explicitly, or pin it for later requests.
  Composer counts cover attachment text only, not your typed prompt.
  Image thumbnails preserve the full image; activate **Open image preview** for a larger view.
  Removal is a separate control.
- **Failed-test repair:** Run **Pi: Repair Failed Test (Preview)**, approve a command or provide an existing UTF-8 log, inspect the evidence, then preview and apply the repair.
- **Request checkpoints:** Choose **More… → Request Checkpoints** to inspect coverage, preview a restore, and revert covered changes.
  Checkpoints are memory-only file recovery, not a Git or conversation rewind.
- **Composer files:** Type `@` to find workspace files.
  Up/Down selects a result; Enter, Tab, or a click captures an attachment snapshot and removes only that token.
  For a path only, type `./src/` or a filename with an extension, then use Tab or click a visible result.
  Path insertion does not open or attach the file.
  Escape closes suggestions; Tab without results keeps normal focus navigation.
  Quoted tokens support spaces.
  Shell input (`!` / `!!`), slash commands, email addresses, and selected text do not trigger file completion.
- **Resource reload:** Choose **More… → Reload Pi Resources** or run local `/reload` without attachments.
  This reloads the approved foreground resources without a model request.
  **Restart Pi (Current Launch Policy)** is separate and explicitly applies changed executable, launch overrides, or project-resource approval.
  Reconnect does not restart a running process.
- **Session branches:** Choose **More… → Browse Session Tree / Fork / Clone**.
  Stable entry IDs and indentation distinguish branches and duplicate labels.
  Fork accepts user entries, including abandoned branches; clone copies the active branch.
  Navigation never requests a summary or submits a draft.
  These actions do not restore files, Git state, or external effects.
- **Direct shell:** In an idle session composer, enter `!command` to include its output in the next model prompt, or `!!command` to exclude it from model context.
  Both remain in Pi history and exports.
  Pi and installed extensions own shell permissions; pi-vscode adds no execution confirmation.
  Remove attachments; commands cannot be queued or run from the Sessions-level composer.
  Prefix a leading `!` with a backslash (`\!text`) to send literal prompt text.
  Requires Pi 1.3.0 compatibility verified through read-only sentinel version metadata; other versions leave this feature unavailable without an execution probe.
- **Slash commands:** Type `/` in the composer to list Pi extension commands, prompt templates, skills, and `/compact`.
  Type `/com` to find command names that contain `com`.
  Use Up/Down to select, Enter or Tab to complete, then Enter to run.
  Click to complete or press Escape to close.
  `/compact` accepts optional instructions and acts on the current session.
  Remove attachments before running commands.
  TUI-only commands are not listed.
- **In-flight instructions:** While an ordinary request is running, choose **Next** (Enter) to submit after the current tool finishes, or **After this** to submit after the response finishes.
  The alternate shortcut is Alt+Enter on macOS and Linux, or Ctrl+Q on Windows (including remote WSL sessions).
  **Submission help** explains the actions; **Stop** stays separate.
  Pending text stays visible under these labels, then moves into the transcript as soon as Pi starts that user message.
  Locked requests cannot accept queued messages.
- **Debug questions:** Pause a Node.js debugger and run **Pi: Ask Debug Context**.
  Approve capture, choose local variables, inspect or redact the snapshot, and ask a read-only question.

File completion is local and requires a trusted, file-backed workspace matching the active Pi working directory.
It does not start Pi or send a model request.
Discovery checks at most 2,000 names, sorts up to 30 matching results, and has a two-second deadline.
Queries allow 256 characters; candidate paths allow 1,024.
Search uses enabled `files.exclude` and `search.exclude` patterns plus `.git`, `node_modules`, `out`, `dist`, `build`, `coverage`, `.next`, `.cache`, and `vendor` directories.
It does not read `.gitignore`; add private or ignored paths to those VS Code exclusions.
Results are bounded suggestions, not a complete repository search.
Nested symlinks and non-file resources are excluded; a workspace-root alias is supported.
Dirty editor text is captured at selection time.
Inspect or redact it through **Attach → View attachments** before explicit Send.
Existing attachment limits and sensitive-name warnings still apply.

Process-launching and mutation workflows require a trusted, file-backed workspace.
A Pi session's working directory must match the active workspace.
Open an isolated worktree in its own VS Code window before resuming its session.

## Pi resources, branches, and terminal ownership

Resource reload and tree navigation do not send a model request.
Pi 1.3.0 is the checked reference.

- They use a packaged public extension command, verified against its canonical `get_commands` ownership metadata.
- Missing metadata, command conflicts, unsupported APIs, and oversized trees produce an error, not a normal model prompt.
- A separate policy consumes the reserved control input if the command disappears between discovery and dispatch.

A failed control request or authoritative refresh can leave the actual session changed.
Do not assume that disconnection means the operation did not occur.

- Extension errors, missing handled acknowledgements, or failed authoritative refresh disconnect Pi without replay.
- Inspect history before repeating any uncertain operation.
- Use **Restart Pi (Current Launch Policy)** for explicit recovery.

Controls require an idle, trusted, file-backed workspace matching the session's canonical cwd.
Active queues, extension dialogs, and conflicting Apply/import/restore operations block them.
Reload retains the process's project-resource decision; it cannot adopt a changed approval setting.
A separately confirmed restart uses the current launch policy, preserves the persistent session and composer, and never replays a request.
Reload clears transient extension UI and pinned context.
It does not change VS Code themes or sidebar keybindings.

The tree permits 2,000 entries and 100 levels within the 64 MiB persistent RPC frame and unchanged 30-second command deadline.
It rejects malformed relationships instead of silently dropping branches.
Selected user text is limited to 50,000 characters; images are not restored into the composer.
A fork or navigation draft is inserted only after success and never overwrites a newer draft.
Unsummarized navigation alone does not persist the selected leaf across process restart in Pi 1.3.0; submit a new branch message or use a separate fork/clone when persistence is needed.
No summary-generation action is provided here.
Empty-session reload does not require a model call.
Before Pi saves a session header, controlled recovery can reopen its captured assigned path, but its temporary session ID can change.
Import also works from this unsaved state; export and sharing still require a saved source.

In both the sidebar and controlled Pi terminal, `!` and `!!` run without an extra pi-vscode approval.
Pi and installed extensions own permissions.
Without a permission policy, commands can run with no confirmation.

**Extension UI Compatibility** explains the terminal boundary.
**Open in Terminal** is an explicit ownership handoff, not a second writer: it stops foreground RPC, passes the same packaged bridge/read-only policy and project-resource approval flags, and holds the canonical operation lock.
If stop cleanup is unverified, another inspection confirmation is required before launch.
Cancellation or a terminal launch failure can leave ownership held; use **Return Pi from Terminal / Recover Ownership** after checking remaining processes.
Closing a terminal is not proof that tools or descendants stopped.
A bounded workspace ownership record survives window/Extension Host reload and blocks automatic RPC startup.
It stores only the canonical root and session identity/path, not bridge credentials.
The Return action requires confirmation and resumes the same persistent session with the current approved launch policy.
An invalid record requires explicit recovery and does not resume a guessed session.
Ordinary attachments and typed drafts remain available during handoff.
A terminal process can receive the foreground bridge token; independent background/worktree agents do not.

The controlled terminal and selected Pi runtime run in the workspace Extension Host.
Remote SSH, WSL, and container windows use that host's bundled package or explicit external executable and filesystem.
Argument arrays preserve paths with spaces.
See [Bundled runtime validation](BUNDLED_RUNTIME_VALIDATION.md) for current native results and unverified remote/platform handoff paths.

### Extension-author compatibility

Use `ctx.hasUI` for standard dialogs; it is true in RPC.
Use `ctx.mode === "tui"` for terminal components:

```typescript
if (ctx.mode === "tui") {
  // Use ctx.ui.custom() or terminal components here.
} else if (ctx.hasUI) {
  const value = await ctx.ui.input("Choose a value");
}
```

Sidebar/RPC behavior by Pi API:

- `select`, `confirm`, `input`, `editor`: Standard RPC dialogs; host support is separate from terminal rendering.
- `notify`, `setStatus`, text-array `setWidget`: RPC records; component-factory widgets are not forwarded.
- `setTitle`, `setEditorText`, `pasteToEditor`: Host-dependent requests; paste has no terminal paste semantics.
- `custom`, `onTerminalInput`: `custom` returns undefined; terminal input subscription is a no-op.
- Header/footer/editor factories, autocomplete providers, working/thinking indicators, tool expansion: Terminal-only; RPC setters are no-ops.
  Editor getters return empty/undefined; tool expansion reads false.
- Tool/entry renderers, terminal focus/mouse/overlays/keybindings: Not a browser component protocol; use terminal handoff.
- Pi themes: Theme lookup/listing is empty/undefined and switching fails in RPC.
  VS Code supplies sidebar colors.

Unsupported calls can be discarded before an RPC event exists.
No automatic detector or arbitrary in-panel TUI rendering is promised.
A new serializable component protocol or PTY design requires upstream support and separate design approval.
The extension does not add a PTY or a component protocol.

## Provider authentication

Run **Pi: Sign In to Provider** or **Pi: Sign Out of Provider**, also available under **More…**.
These actions require a trusted, file-backed workspace.
They use the selected bundled or external Pi subprocess on the workspace Extension Host.
The isolated helper currently accepts Pi **1.3.0** only.
Unsupported installations fail without attempting another authentication route.

The chooser lists built-in provider IDs and available API-key/OAuth methods without reading the selected credential store.
Extension-defined providers are not loaded.
After you select a provider, confirm the host and Pi store affected.
Pi owns credential writes; all credential, private configuration, and complete manual redirect input uses masked native input and helper stdin.
Browser/device approval opens only a validated HTTPS URL in your local browser.
Pi owns redirect state and expiry checks.
Arbitrary provider progress and error text are not displayed.

Sign-out removes Pi's stored credential, not provider access.
Environment and `models.json` credentials can remain effective.
A verified store change and a store change followed by catalog-refresh failure have different notices.
Restart a running Pi explicitly to refresh model availability; authentication does not change its selected model, conversation, or composer.
Cancellation or uncertain completion never triggers another login.
Opening native VS Code Settings or Pi Configuration does not authenticate or start this helper.

API-key, browser, device, manual-redirect, and cancellation behavior has deterministic fixture coverage.
Live-provider and remote authorization are not validated.
The native input uses generic field labels to avoid forwarding potentially sensitive provider prose; provider-specific configuration flows can require Pi's own terminal UI.
This is not a claim of all-provider native authentication support.

## Session transfer and sharing

Use **Pi: Export Session**, **Pi: Import Session Copy**, or **Pi: Share Session**, also available under **More…**.
These operations share foreground ownership and the canonical workspace operation lock.
Stop active work first.
JSONL operations require the isolated Pi 1.3.0 helper; no UI transcript is used as a session backup.

- **HTML export:** Pi's existing renderer, including the complete entry tree and abandoned branches; up to 32 MiB.
- **JSONL export:** Pi SDK active-branch semantics at the captured active leaf; up to 32 MiB.
  This is not a full-tree backup.
- **JSONL import:** Complete Pi v3 tree, same canonical working directory, at most 50,000 entries, 8 MiB per line, 32 MiB per file.
  Legacy/future versions, malformed references, unsupported entries, unsafe paths and links are rejected.
  Images allow 5 MiB each and 25 MiB total.
- **GitHub share:** Reviewed active-branch JSONL, at most 2 MiB, through the authenticated `gh` CLI on the Extension Host.
  No automatic destination choice or upload.
- **Radius share:** Blocked: no verified public artifact-upload contract in Pi 1.3.0.
  No private endpoint is used.

Local exports create a new file exclusively.
Existing names are never replaced; choose another name.
Import validates and stages the source, calls Pi's public runtime import, then retains a collision-safe copy in Pi's configured session directory before guarded activation.
This directory comes from the active SessionManager, not the resumed source file's parent directory.
Pi can append initialization metadata to the copy.
Source files are unchanged.
A failed or cancelled activation leaves the copy available and does not retry switching; check which session is authoritative before selecting it manually.
No retained copy is deleted as compensation.

JSONL export and sharing require a read-only, packaged command-context snapshot.
It returns the canonical session location, active leaf and SHA-256 entry digest, not transcript content.
The staged file must match Pi's active in-memory entries; changed paths, entries or leaves require new preparation.

Sharing preparation is network-free.
Inspect the exact read-only JSONL payload, optionally replace a literal in string values using masked input, and inspect again after each change.
A separate modal confirmation is required before `gh gist create --public=false` receives that exact payload on stdin.
A non-public gist is **not confidential storage**: anyone with its link can read it.
Images, `!!` shell entries, tool arguments/output, thinking signatures, and custom metadata can contain secrets even when hidden in the conversation.
Redacted JSONL can become non-resumable.
Delete remote copies separately on GitHub; deleting local history does not remove an upload.
Unknown upload completion is never retried automatically.

## Panel content

Pi extensions can show keyed status text in **More… → Conversation details → Extension status** and text-array widgets above or below the composer.
These labelled **Extension status** and **Extension widgets** areas are separate from host connection, permission, queue, and Stop controls.
Keys are supplied by Pi, not verified extension identities.
Terminal controls are removed; HTML, Markdown, links, ANSI styling, and terminal component factories are not rendered.
This uses the public RPC contract checked against Pi 1.3.0; runtimes that do not emit these events show no extension area and need no feature probe.

Extension UI is memory-only.
A new session, session switch, client replacement, disconnect, or extension disposal clears it.
Only new Pi events restore it; RPC has no widget snapshot endpoint.
Reopening the panel within the same runtime keeps current entries.
Limits are 16 status keys and 16 widget keys, 128 characters per key, 20 lines per widget, 1,000 characters per status or line, and 32,000 retained key/text characters.
Invalid or oversized updates keep earlier entries and show one bounded diagnostic in the extension area, not a host warning.

Provider-exposed thinking appears as plain text in a collapsed **Thinking** disclosure, separate from the answer.
It updates during streaming and is restored from Pi history.
Redacted blocks show an unavailable-content label; signatures and hidden reasoning are never displayed.
Providers or Pi runtimes that expose no thinking keep the answer-only view.
This display does not change the **Thinking** level or guarantee that a provider returns thinking.

Thinking shares the retained transcript limit of 100 messages and 250,000 text characters.
Truncated content is marked.
Streaming retains at most 128 text/thinking blocks per assistant message; history retains at most 128 visible thinking blocks per message.
Thinking is not saved in VS Code workspace storage, added to prompts, or parsed as an edit proposal.
Disclosure state stays in the current panel.

Tool calls appear in conversation order between assistant responses, not in a separate activity group.
Each call starts collapsed, including while it runs.
Expand it to inspect its status, input, output, and errors.
Updates and completion preserve your disclosure choice.
Pi history restores retained calls after refresh.
The panel retains at most 30 calls, with up to 8,000 characters each for input and output, within the shared transcript bounds.
Tool payloads are not saved in VS Code workspace storage; Pi session history has its own retention.
At a history window boundary, a response and its retained tool calls move to the earlier window together.
If one source entry exceeds a complete window, the answer has priority.
Excess tool details are truncated and cannot be recovered separately through Earlier.

Long assistant prose uses a bounded reading column.
Code, tables, math, and diagrams can use the full message width.
Primary status stays above the composer box, outside the scrolling content.
Its single polite, atomic `#status` live region announces only selected-message changes.
The nonlive `#composer-status` supplies the submission description for the input, Send, and After this without a second visible row or duplicate announcement.
**More… → Conversation details** contains context usage and **Session details**, with the copyable session ID.
Runtime notices keep short summaries and **Show Output** opens safe technical categories in **Output → Pi**, not raw details.
Queue uncertainty never means it is safe to resend.

The session panel supports Markdown headings, nested lists, task lists, tables, quotes, links, emphasis, and strikethrough.
Code highlighting covers Bash, CSS, JavaScript, JSON, Python, TypeScript, and HTML/XML, including their registered aliases.
Other languages stay plain text.

Math uses KaTeX with `$…$`, `$$…$$`, `\(...\)`, and `\[...\]`.
This is math rendering, not full TeX document support.
Currency text such as `$5 and $10`, shell-variable expressions such as `$PATH:$HOME`, and code are not treated as math.
Invalid or incomplete formulas remain readable source.
Each message can render up to 50 formulas of 4,000 characters each, with at most 200 macro expansions and a 10em KaTeX size limit.

Complete `mermaid` code fences can render flowcharts (`flowchart` or `graph`) and sequence diagrams.
Source stays visible below the diagram.
Other diagram types, invalid diagrams, configuration directives, custom CSS, HTML labels, images, links, and callbacks stay source-only.
Diagrams are limited to 8,000 characters and 120 lines; flowcharts also have a 100-edge limit.
At most 100 diagrams can wait for rendering.
Oversized or failed content does not prevent the rest of the response from displaying.

Links permit only HTTP, HTTPS, and email targets.
Raw HTML and Markdown images are not enabled; use image attachments instead.
Tables, code, and display math scroll horizontally when necessary.
Native `@pi` chat and Pi HTML exports retain their own renderers.

## Settings

Open the native **⋯** overflow menu in the Pi view title for **Extension Settings** followed by **Pi Configuration**.
Both commands appear directly in the same configuration group.
There is no standalone settings gear or settings submenu.
Run **Pi: Extension Settings** (`pi.openSettings`) or select **Extension Settings** in that menu to open native VS Code Settings filtered to `@ext:narumi.narumi-pi`.
**General**, **Permissions**, and **Editor** group the existing 11 extension settings.
Their IDs, defaults, types, bounds, configuration scopes, and runtime behavior are unchanged.
This command does not open the Pi Configuration panel, start Pi, or send a model request.

VS Code owns scope selection, validation, save-on-edit, array controls, search, configured-value indicators, and Reset menus.
Select the native settings scope before editing; available User, Workspace, folder, language, and remote-user targets depend on the window and each setting's declared scope.
**Reset Setting** removes the selected target's override; another effective override can remain.
Invalid or incomplete input follows native Settings validation and draft behavior, not the former custom page's Save/Retry or stale-row protocol.
The former custom VS Code form limits of 4,096 characters per string, 100 list items, and 16 KiB of serialized list text do not apply to native Settings.
See [VS Code Settings](https://code.visualstudio.com/docs/configure/settings#_settings-editor) for native controls.

Use **Pi: Pi Configuration** (`pi.openPiConfiguration`) or **Pi Configuration** in the same overflow menu for the separate Pi file editor [below](#native-pi-settings-and-mcp).
Repeated invocation reveals the same panel.
Pi file controls retain explicit row saves; they do not use native Settings save-on-edit.

Executable, provider, model, thinking, and project-resource settings are used when a Pi process starts.
Running foreground and background sessions are unchanged.
Reconnect does not restart a running process.
The model and thinking controls in chat change the current session separately; resumed sessions can restore their own model.
Completion settings affect later requests, subject to in-flight work and cached results.
Sensitive-name settings affect later warning checks.

In remote windows, native Settings handles local-user and remote-user values where available.
The extension's existing Restricted Mode and virtual-workspace limits are unchanged.
Do not assume that native Settings disables `pi.approveProjectResources` in an untrusted window.
Host trust and launch checks independently prevent untrusted process launches and resource activation.

| Setting | Default | Purpose |
| --- | --- | --- |
| `pi.executablePath` | Empty | Empty/whitespace selects bundled Pi 1.3.0; a nonempty value selects an external command or path on the workspace Extension Host. |
| `pi.provider` | Empty | Optional provider override; empty uses Pi settings. |
| `pi.model` | Empty | Optional model override; empty uses Pi settings. |
| `pi.thinkingLevel` | `default` | Optional thinking-level override. |
| `pi.approveProjectResources` | `false` | Allow trusted project-local Pi settings, extensions, skills, and prompts. |
| `pi.sensitiveContextNames` | Sensitive filename fragments | Add best-effort warnings to matching attachment labels. |
| `pi.inlineCompletions.enabled` | `false` | Enable automatic inline completions. |
| `pi.inlineCompletions.debounceMilliseconds` | `650` | Delay before an automatic completion request, in milliseconds. |
| `pi.inlineCompletions.minimumPrefixLength` | `3` | Minimum non-whitespace characters on the current line for an automatic completion request. |
| `pi.inlineCompletions.excludedLanguages` | `plaintext`, `scminput` | Language IDs excluded from Pi inline completions. |
| `pi.annotations.initialState` | `collapsed` | Initial native annotation state: `collapsed` or `expanded`; see [Temporary passage annotations](#temporary-passage-annotations). |

**Editor → Annotation initial state** applies only to newly created or replaced annotations, not existing threads or user state on redraw.

### Native Pi settings and MCP

Run **Pi: Pi Configuration** and select **Global Pi** or **Project Pi** under **Save to**.
Project Pi shows **First workspace folder · .pi**; there is no multi-root selector.
This dedicated panel contains only Pi file controls, with no General/Permissions/Editor form or User/Workspace selector.
Use its **Open Extension Settings** action for extension settings.
The **Model**, **Behavior**, and **MCP** sections group startup preferences, session behavior defaults, and configured servers.
File locations and detailed precedence rules are in expandable help.
The secondary **Advanced** menu opens **Open Pi settings dialog…** or **Manage MCP servers…**.
These actions open the existing native dialogs, not a direct JSON editor.
The form uses the existing native setting descriptors, not a second settings database or arbitrary JSON editor.
No new VS Code configuration keys are added.
The Command Palette commands below remain available.

| Field | Inline control |
| --- | --- |
| Provider ID | Manual text input for the startup provider |
| Model ID | Manual text input for the startup model |
| Startup thinking level | Select: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| Scoped model patterns | Ordered multiline input, one pattern per line |
| Steering mode | Select: `one-at-a-time`, `all` |
| Follow-up mode | Select: `one-at-a-time`, `all` |
| Automatic compaction | Checkbox |
| Automatic retry | Checkbox |

Provider and model entry is manual, including custom IDs; this page offers no cached catalog or model discovery.
It does not start a helper or read credentials to assist entry.
Ordered model patterns retain Pi's matching semantics; they are not model access control.

An inherited row shows a read-only value with **Inherited from Global** or **Pi default** as its source.
Choose **Set global override** or **Set project override** to open a local draft initialized from that value.
Entering edit mode does not write a file or create directories.
A saved row shows **Global override** or **Project override** and remains editable.
Unsaved changes have a separate draft indicator; neither saved nor draft values are verified current-session values.
**Save** stays visible in editable rows and is disabled without a draft, during a pending operation, or when stale.
After a successful save it stays visible but disabled until another edit.
Checkbox, select, and MCP metadata changes create drafts; editing alone never saves or resets a file.
A draft equal to an inherited value can still save an explicit selected-scope override.
**Discard changes** removes the local draft without changing saved files or removing a saved override.

Open the row actions menu for **Remove global override** or **Remove project override**, or **Reload row**.
Remove deletes only the saved selected-scope member and preserves inherited values and unrelated file members.
It does not save a copy of the inherited value and is disabled without a saved override, or while pending or stale.
Reload discards that row's draft and reads current values when no operation blocks it.
The menu supports keyboard use and Escape; opening or closing it does not discard drafts.
Drafts remain separate by native scope and setting and survive failed saves and scope changes.
A stale draft shows an inline **Reload row** recovery action and requires explicit reload before saving.
The secondary **Reload saved values** action reads saved file values and preserves unrelated drafts; it does not reload Pi resources.
There is no Save All or Reset All.
Only bounded validated common-setting drafts are kept in webview state; full native snapshots and MCP transport data are never persisted there.
A bounded restart request ID and fixed outcome status also recover feedback after hide/reveal, without repeating the action or storing its authority token.
Closing the panel discards these drafts.

The configured MCP list shows validated server names, transport type, source, enabled state, and exposure metadata.
Enabled and server exposure controls support explicit save and reset at the selected native scope.
Project metadata overrides preserve inherited transport and credentials.
Configured state is not connection evidence; connection state remains **unknown**.
Server creation, transport editing, credentials, authentication, diagnostics, and advanced editing remain in existing explicit native management interfaces.
Raw file text, unlisted settings, URLs, commands, arguments, environment/header values, and OAuth objects stay out of the browser.
Only validated common-setting values, safe MCP metadata, opaque revision tokens, and a host-owned restart action token reach the form; full file snapshots remain in Extension Host memory.

Global Pi uses the Extension Host's `~/.pi/agent`, or `PI_CODING_AGENT_DIR` when set.
Project Pi uses the current launch workspace's `.pi`: the existing first workspace folder behavior, not multi-root selection.
Remote windows use the remote Extension Host's paths.
Native controls require a trusted, file-backed workspace, including for Global Pi.

Opening, reading, refreshing, switching Pi file scopes, entering edit mode, or discarding drafts never creates files.
The first explicit override save creates only the required `settings.json` or `mcp.json` and missing Pi directories.
Resetting an absent override creates nothing.
When project-resource approval is off, one warning appears above the sections and saved Project overrides are labelled **inactive**.
Inherited Global values are not marked inactive.
**Review project approval setting** opens native Settings filtered to `pi.approveProjectResources` only.
Opening that setting does not change approval, trust, or runtime state; editing Pi files does not activate or approve project resources.

One shared explanation states that Save changes files only, not running sessions.
After a save or override removal, the result distinguishes saved files from unchanged runtime state.
Choose the separate **Restart Pi…** action to use the existing **Pi: Restart Pi (Current Launch Policy)** confirmation and lifecycle checks.
Restart is not automatic and does not replace **Reload saved values** or the resource-reload command.
Cancellation or failure retains saved files and drafts; failure reports runtime uncertainty and requires inspection before retry.
Resumed-session values and VS Code launch overrides can still take precedence after restart.

Native controls use Pi terms such as **Steering mode**, **Follow-up mode**, **thinking level**, and **scoped model patterns**:

- **Pi: Open Native Pi Settings** (`pi.openNativeSettings`) keeps its existing native dialogs for common Global Pi or Project Pi `settings.json` overrides.
  Reset removes only the chosen override.
  Startup provider/model/thinking level and scoped model patterns are restart preferences, not access control.
  An explicit advanced action opens the native file in VS Code.
- **Pi: Native Runtime Controls (Global Save)** changes idle foreground queue grouping, auto-compaction or auto-retry through public Pi setters.
  These setters also request a **Global Pi** settings save.
  An acknowledgment does not verify disk persistence; retry state has no public read in Pi 1.3.0.
- **Pi: Manage Native MCP Configuration** (`pi.openNativeMcp`) keeps its existing native management dialogs and passively shows configured metadata, with current connection state **unknown**.
  Add/edit/remove, enable/disable and exposure changes only save the selected file.
  Environment/header/OAuth values and credentials do not enter the browser.
  The explicit approved CLI diagnostic connects all enabled file-configured servers separately from the current session.
  Interactive management and authentication stay in Pi's controlled terminal after native `/mcp` ownership is verified.
- **Pi: Apply Saved Native Configuration (Reload Resources)** is a separate explicit action.
  A successful form or native-dialog save does not apply runtime settings, reload, restart, connect, install packages or approve project resources.
  A failed apply retains the saved file and reports that active state is not verified.
  Startup model preferences are not live-applied.
  Use **Pi: Restart Pi (Current Launch Policy)** explicitly to load startup defaults and model patterns into the same session; resumed model/thinking state can still take precedence.

Opening the form or native dialogs starts no Pi process or connection.
Native files use the Extension Host's paths, including remote paths in remote windows.
Common edits require a trusted file-backed workspace, bounded regular canonical files and fresh revisions; unrelated members remain unchanged.
Both existing `settings.json` and `mcp.json` files have an explicit advanced native editor action with a warning.
It uses normal VS Code Save and backups, not the bounded control workflow.
For an absent file, save an override through the common controls first.
See [Native configuration contract](NATIVE_CONFIGURATION.md) for persistence, CLI trust differences, safe-write limits and upstream API gaps.
Native MCP tools can already be inherited from Pi; this management surface does not replace Pi's MCP client or add a permission policy.

## Security and limits

Pi sessions expose Pi's default coding tools and tools contributed by installed Pi extensions.
Pi and installed extensions own tool and shell permissions.
pi-vscode adds no built-in tool or shell confirmation policy.
Without a permission policy, tools and commands can run with no confirmation.
Pi-requested dialogs continue to be displayed unchanged.

Focused edit workflows use a packaged read-only policy while generating proposals.
Applying edits, importing worktree results, rerunning tests, and restoring checkpoints always require explicit user action.
Project-local Pi resources remain disabled until the workspace is trusted and `pi.approveProjectResources` is enabled.

Prompts and approved context are sent to Pi through standard input, not command-line arguments.
The selected provider receives that content under its own data policy.
Transcript state stores image metadata, but not Base64 image payloads.

Key operational limits:

- Persistent Pi RPC single lines allow 64 MiB with unchanged LF framing, decoded UTF-8 byte counting and CRLF handling.
  Larger complete lines and unterminated fragments are rejected.
  The first fatal decoder failure stops decoding and releases retained input; later stdout is ignored while bounded cleanup completes.
  New RPC commands and dialog replies are rejected before writing to that failed client.
  Bridge frames remain limited to 1 MiB and one-shot Pi output to 5 MiB; attachment and session import/export limits are unchanged.
- Attachments allow 8 items and 400,000 total text characters, including up to 5 images of 5 MiB each.
- Each Git review supports up to 100 text files, 100 KB per side, 400 KB of retained text, a 200 KB diff, and a 45-second capture deadline.
  Unsupported files remain explicitly not reviewed.
  Up to eight captured reviews are held in memory, replaced per repository/scope.
- Semantic lookups return at most 50 locations with a five-second provider deadline.
  Attachments include at most 20 excerpts of 4,000 characters each, within the existing attachment limits.
  Language providers can activate third-party extensions and require workspace trust.
- Workspace diagnostic repair selects at most 100 errors/warnings in 20 files, 100,000 characters per file and 400,000 serialized characters per request/response.
  Existing dirty buffers are included; other document text must match safely captured disk bytes.
  Unknown paths, symlinks, stale/read-only targets and unverifiable text encodings are rejected.
  One workspace edit supports native Undo.
- Failed-test repair accepts an executable and argument array, not a shell expression.
  Runs stop after 60 seconds, output is capped at 256 KiB, and repair is limited to two attempts.
  Apply asks for save/rerun approval and revalidates the source before changing its buffer; cancellation or rejected workspace aliases leave no repair to save later.
- Checkpoints keep up to 20 requests in memory and restore only deterministically observed edits to captured regular text files.
  Direct-shell effects are non-restorable.
- Direct shell accepts up to 8,000 command characters and retains up to 64,000 output characters per card.
  Output is plain text with terminal controls removed.
  Commands have a 60-second execution deadline.
  Stop/deadline sends `abort_bash` and requires both its acknowledgement and a final result within bounded waits; otherwise Pi disconnects with cleanup uncertainty.
  An acknowledgement or process exit does not prove that escaped or Windows descendants stopped.
  Never repeat an uncertain command automatically.
- In-flight instructions are limited to 10 messages and 50,000 characters.
  **Next** and **After this** messages can include captured text attachments and up to 5 images; slash commands cannot be queued.
  Pending transcript presentation is memory-only, public pending previews are capped at 1,000 characters per message, and pending/recovered attachment snapshots are memory-only and capped at 30 MiB.
- Debug capture supports paused `node` and `pwa-node` js-debug sessions only; it does not evaluate expressions or mutate debugger state.

Read [Security and Privacy](SECURITY.md) for trust boundaries and safeguards.
[Workflow Validation](WORKFLOW_VALIDATION.md) records historical validation evidence and deferred checks; it is not the source for current commands.

## Extension bridge

The Pi bridge extension bundled in the VSIX and the VS Code extension communicate over an authenticated local bridge:

```mermaid
flowchart LR
    V[VS Code extension] -->|authenticated events| P[Bundled Pi bridge extension]
    P -->|bounded requests| V
    P <-->|pi.events| E[Other Pi extensions]
```

The bridge provides `vscode_context`, `vscode_code_context`, `vscode_open_file`, and `vscode_notify` for sidebar sessions and **Open in Terminal** handoffs.
The additional `vscode_annotate` tool is restricted to the foreground sidebar session and requires separate private authorization.

A new ordinary integrated terminal inherits the authenticated bridge environment and bridge path, but plain `pi` does not load the bridge.
The following commands require a separately available external Pi; the bundled runtime does not add `pi` to PATH.
Load the bridge explicitly when you need these tools:

```bash
pi --extension "$PI_VSCODE_BRIDGE_EXTENSION"
```

In PowerShell, use `pi --extension $env:PI_VSCODE_BRIDGE_EXTENSION`.

Other Pi extensions can use `pi.events` to send an allowlisted `vscode:request` and receive a correlated `vscode:response` or `vscode:event`.

Session replacement and resource reload close the outgoing event subscription and cancel its pending event-bus requests before Pi invalidates the old extension API.
Late callbacks cannot send events or responses through that API or into the replacement session.
Intentional cleanup does not emit `vscode:disconnected`; active connection failures still do.
Requests are not replayed.

`vscode_code_context` accepts `definition`, `references`, `callers`, `callees`, or `documentSymbols`, a workspace path and optional one-based line/column.
It returns metadata only, with zero-based ranges; source text requires a separate read.
The tool is not loaded by independent background/worktree agents.

VS Code extensions in the same Extension Host can activate `narumi.narumi-pi` and call its exported `broadcast(event, data)` API.
Event names and payloads are validated and bounded.
