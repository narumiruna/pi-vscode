# Changelog

## 0.5.2

### Patch Changes

- ca87a42: Show submission blockers beside the composer. Add latest-output navigation, capability-aware file hints, stable accessible message headings, grouped native session actions, and a transcript code-wrapping toggle.
  
  Add bounded, local conversation search and earlier/latest history browsing without model calls or changes to permission and edit guards.
- ca87a42: Add opt-in, bounded workspace text draft recovery with explicit Restore and Discard. Keep attachments and extension dialogs out of draft storage, and prevent recovery from sending requests or replacing newer composer text.
- b6a8a86: Keep the Sessions composer available after accepted local reload and compaction commands, and resume saving newer draft text after acceptance or rejection. Keep the decorative Pi mark out of screen-reader heading navigation. Clarify text draft storage using verified desktop-profile and web-remote browser storage paths.

## 0.5.1

### Patch Changes

- e78c52c: Reduce CPU work for fragmented RPC and bridge frames. Avoid rebuilding hidden session lists during streamed responses. Keep frame limits, session controls, and security checks unchanged.
- 1ab54de: Fix the Pi editor-title button appearing black on dark themes. Use separate light and dark SVG icons with explicit foreground colors.

## 0.5.0

### Minor Changes

- a58195d: Add approved idle-composer direct shell for the verified Pi 1.3.0 public contract. Show bounded inert output, context/history labels, shell-specific cancellation, and non-restorable checkpoint coverage. Reject attachments, queues, stale approval, and conflicting operations; disconnect without replay when completion is uncertain.
- d0896c8: Add approved resource reload and controlled restart, bounded session tree browsing with fork/clone and no-summary navigation, and explicit policy-preserving terminal ownership handoff. Reject stale or conflicting controls and disconnect uncertain outcomes without replay. Document the RPC/TUI compatibility boundary.
- 39e3286: Add isolated Pi 1.3.0 provider authentication, validated same-workspace JSONL import and active-branch export, and inspected non-public GitHub gist sharing. Keep credentials in Pi/gh, preserve full-tree HTML export, and leave Radius sharing explicitly blocked pending a public transport.
- f298d62: Add local workspace file suggestions to the sidebar composer. Select an `@` result to capture an inspectable attachment snapshot, or use Tab on a visible path suggestion to insert a path without reading file contents. Completion is bounded, cancellable, workspace-bound, and does not send a model request.
- f3d36f0: Add separate native Pi settings and MCP configuration controls with scoped revision-checked file edits, explicit runtime/global-save controls, and approved bounded MCP CLI diagnostics. Keep passive views process-free, authentication in Pi's controlled terminal, and saved-versus-active state separate. Document public API limits instead of claiming live scoped-model or authoritative MCP state support.
- d4c4aa4: Show bounded Pi extension status text and keyed text-array widgets above or below the composer. Keep extension content separate from host status, warnings, and Stop controls, and clear it when its foreground runtime or session changes.
- 9b3b6d6: Show provider-visible thinking in collapsed Thinking sidebar disclosures during streaming and history refresh. Keep redacted content labeled, signatures excluded, and thinking bounded and separate from answers, proposals, and VS Code workspace storage.

### Patch Changes

- 1a52a31: Support native multiline Pi extension editors with per-use non-secret privacy confirmation and owned Submit/Cancel commands. Bind dialog replies to their originating process and session, enforce bounded requests and local deadlines, and keep timed confirmations reviewable in read-only native documents.
- adbb5fb: Fix session transfers when temporary directories use path aliases. Keep large image validation within the supported limits without regex stack errors. Let native settings and MCP controls ignore missing unrelated files while keeping configuration editor checks.
- 2c5d2d9: Align native settings labels and internal Bash, authentication-helper and session-transfer names with Pi core terminology. Keep extension views and controllers distinct from SDK types. Preserve command IDs, settings, stored keys and protocol fields.

## 0.4.0

### Minor Changes

- 92911ff: Add a Pi Settings editor tab with General, Permissions, and Editor categories, explicit User/Workspace saves, scope-specific reset, inherited values, and external-change checks. Open it from the Command Palette or the Pi view-title gear without starting Pi. Launch setting changes leave running sessions unchanged. Align VS Code types with the existing 1.106.0 minimum so VSIX packaging retains its compatibility checks.

### Patch Changes

- 3f7704c: Add a retry action for failed automatic settings saves. Return an error when the settings queue is full so rejected saves and resets do not leave rows disabled.
- e356b3a: Launch standard Windows npm Node shims without a shell, preserve literal arguments, and use the final child PATH and working directory. Reject unsupported batch wrappers and report bounded process-cleanup uncertainty instead of treating shell exit as Pi termination. Keep foreground cleanup warnings visible during session deletion and failed startup cleanup.
- 6b83219: Improve Marketplace discovery with keywords for editing, reviews, diagnostics, documentation, and test workflows. Replace the Programming Languages and Machine Learning categories with Testing to match the extension's features.
- 7912c8a: Clarify sidebar attachments, model and thinking settings, runtime notices, and in-flight actions. Add visible Next and After this controls, contextual submission help, copyable session details, full-image thumbnails, and responsive reading and composer layouts.

## 0.3.1

### Patch Changes

- 3df5fa3: Remove unused prompt and file-version code, share transcript transformations, and simplify background startup without changing behavior.

## 0.3.0

### Minor Changes

- f681af5: BREAKING: Rename settings, commands, views, storage keys, and virtual document schemes from `picode` to `pi`. Remove the `piCodingAgent` settings fallback. Rename bridge and permission environment variables and prompt markers to `PI_VSCODE_*`, and rename bundled Pi resources.
  
  Update settings, custom keybindings, and bridge consumers, then reload VS Code and create a new integrated terminal. Cached extension state does not migrate; persistent Pi session files are unchanged. Old transcript markers remain plain text. Exact legacy global bridge cleanup paths remain supported. The package name and extension ID are unchanged.

### Patch Changes

- a22d44d: Avoid repeated prefix scans for escaped math delimiters. Keep Markdown formatting after unmatched currency amounts.
- 9e31170: Keep the compact thinking picker and Send button inside narrow sidebar composers.

## 0.2.0

### Minor Changes

- 04ca99b: Render Markdown tables and task lists, highlighted code, LaTeX math, and bounded Mermaid flowcharts and sequence diagrams in the session panel using bundled offline assets and safe source fallback.
- af34e2f: Add slash-command suggestions to the chat composer. Run extension commands, prompt templates, skills, and `/compact` without prompt wrappers.
  
  Treat handled commands as successful requests without an assistant response. Disable Retry after completion, finish change tracking, and keep history recovery separate from command execution.

## 0.1.0

### Minor Changes

- 14061fc: Add trusted language-provider context attachments and the foreground-only `vscode_code_context` bridge tool. Review staged, unstaged, working-tree and branch changes as immutable snapshots with captured findings in Problems and guarded Ask/Fix actions. Repair selected workspace diagnostics through bounded multi-file proposals with hunk selection, native diffs, one explicit workspace edit and observational diagnostic feedback. Existing staged-review commands and VS Code 1.106 compatibility are preserved. Semantic lookup retains attributable checkpoint coverage; semantic context and diagnostic repair support workspace-root aliases without allowing nested symlink targets or retargeted repair roots. Finding fixes preserve aliased editor buffers and reject content changes during writable preflight. Semantic results use numeric source-coordinate order before result and excerpt limits. Worktree snapshot reads reject changed parent directories and revalidate canonical containment and opened-file bounds before reading.

### Patch Changes

- 5de3da6: Add Changesets-based versioning and release metadata while preserving all pending release notes:

  - Add a top-level workspace **Sessions** list with quick switching, a searchable **View all** browser, a composer that starts a new session, and a separate conversation detail layer with **Back to Sessions**.
  - Show composer image attachments as compact, labeled thumbnail cards with preview and remove actions.
  - Keep submitted context chips and validated image thumbnails on their user turn across history refresh and session restore, with labeled unavailable placeholders when image bytes cannot be recovered.
  - Add bounded one-shot transcript image delivery, newest-first aggregate history processing limits, browser-rejection memory, responsive thumbnail grids, and a keyboard-accessible modal preview without persisting Base64 image payloads.
  - Place foreground tool activity after its response in the conversation scroller, compact the empty composer, normalize inline-code sizing, preserve scroll position as images decode, and consolidate cancellable/status/error UI.
  - Keep remote conversations intact when Trash is unsupported and require a second modal confirmation before permanent deletion.
  - Move the Pi connection, session, and context status below the composer.
  - Show the active Pi thinking level in the Chat header and allow direct changes between model-supported levels.
  - Add confirmed read-only staged Git review with immutable finding navigation, stale-index detection, and explicit skipped-file coverage.
  - Add deterministic hunk selection, revision-bound Preview, and single-Apply partial proposals without applying the remainder.
  - Record isolated-task origin/base metadata; preview actual committed, uncommitted and untracked results and import selected text files with stale/dirty/path gates and recoverable partial reports.
  - Add exact attachment inspection, edit/redact, explicit refresh, memory-only pins, heuristic estimates and revision-safe draft/attachment consumption.
  - Add approved process-based failed-test repair with inspected/redacted evidence, read-only proposals and at most two approved reruns.
  - Replace tool-notification-time capture with bounded pre-prompt request checkpoints, conservative coverage reports, dependency checks and dirty/stale-safe historical restore.
  - Add session/policy-bound keyboard-only Steer and Follow Up, bounded queue feedback, clear-before-abort cancellation and uncertain-draft recovery without replay.
  - Show Pi-style pending steering/follow-up text and move each confirmed delivery into the transcript at Pi's user-message start, preserving duplicate order and attachment labels.
  - Add explicit bounded Node.js debug snapshots, variable selection/redaction, pause/frame invalidation and read-only questions; no evaluate or recursive requests.
  - Serialize foreground request/session operations, bind resumed sessions to their working directory, bound subprocess cleanup, and explicitly disable unapproved project resources.
  - Compile against exactly VS Code 1.106 declarations rather than newer APIs. Record automated workflow evidence and explicitly deferred interactive/remote validation in `docs/WORKFLOW_VALIDATION.md`.
  - Add a confirmed **Delete Session** button that moves the current persistent Pi session to Trash and starts a new session.
  - Bundle the Pi bridge in the VSIX and load it process-locally with authenticated request/event communication and `pi.events` interoperability.
  - Export a same-host VS Code API for broadcasting bounded events to connected Pi sessions.
  - Install only the VSIX, remove exact legacy global bridge filenames during installer or extension activation upgrades, and avoid creating Pi configuration files on clean installs.
  - Add **Fix with Pi** quick fixes for red and yellow diagnostics through VS Code's lightbulb menu, the editor toolbar, and Ctrl/Cmd+I, with contextual diff previews and inline-edit fallback away from diagnostics.
  - Support Pi Inline Edit for both selections and the current line at the cursor as the Ctrl/Cmd+I fallback when no diagnostic is targeted.
  - Redesign Pi Chat around a compact header, native Quick Pick secondary actions, attachment chips, explicit reconnect, cancellation, history-recovery states, serialized submission, retry-safe composer drafts, and narrow Sidebar layouts.
  - Route editor context-menu questions and edit requests through the persistent Pi Chat session for continuous follow-up, with absolute editor-resource context for multi-root workspaces.
  - Add safe Ctrl/Cmd+V image attachment with client and extension-host MIME, Base64, count, size, and model-capability checks, and hold submission until pasted images finish loading.
  - Add in-chat edit proposal cards that enforce structurally trusted read-only generation, retain live previews, release terminal callbacks, bound terminal history, require Preview before Apply, reject stale document versions, and serialize Apply across all live proposals.
  - Add an authenticated local bridge with fail-closed bounded framing and Pi tools for reading VS Code editor context, opening files, and showing requested notifications.
  - Load the bundled bridge in foreground chat runtimes and Pi terminal handoffs, expose its path for explicit ordinary-terminal use, and keep bridge-only tools and credentials out of independent background profiles.
  - Capture each request's authoritative assistant response from its event stream across compaction, keep session actions locked through post-processing, and honor cancellation before delayed startup submits a prompt.
  - Preserve composer edits and attachments added while a background or worktree agent starts.
  - Move the Pi Chat view's default location to the Secondary Sidebar.
  - Add a Pi button to the editor title toolbar for opening Chat.
  - Require VS Code 1.106 or newer for Secondary Sidebar view contributions.
  - Add a `just dev` recipe for compiling and launching the Extension Development Host.
- 3aa3fac: Restore diagnostic repair for decodable VS Code encoding aliases, including Shift JIS, EUC-JP/KR, KOI8-R/U, Mac Roman and Big5. Keep strict decoding, safe snapshot equality and rejection of unsupported codecs.
- 0da5577: Prevent workspace diagnostic repair from sending file contents loaded through a raced symlink. Bind newly loaded and clean document text to safely captured disk bytes while preserving existing dirty buffers, workspace aliases and native Preview/Apply/Undo.
- a5bc72a: Fix failed-test repair in workspaces opened through filesystem aliases, including macOS temporary paths. Preserve the selected editor URI and reject a workspace alias that changes targets during evidence capture, Preview, or Apply. Obtain save/rerun approval and revalidate before applying the repair, so cancellation or rejected aliases leave no dirty repair to save later.

## 1.0.0

- Add packaged Pi per-tool permission gate with off, dangerous, and all-mutating policies.
- Add `Pi: Suggest Next Edit` with whole-file diff preview and stale-safe explicit apply.
- Add safe Markdown rendering for headings, lists, emphasis, inline code, and fenced code blocks.
- Add complete reference-extension feature matrix, security guidance, onboarding, and troubleshooting.
- Complete packaged-extension, real Pi, concurrent-session, worktree, security, and clean-install audits.

## 0.7.0

- Add Pi-discovered extension command, prompt-template, and skill picker.
- Add bounded PNG, JPEG, GIF, and WebP image attachments through native Pi RPC image transport.
- Add explicit terminal-selection context attachment.
- Add Pi session HTML export and open workflow.
- Document project trust, AGENTS.md, skills, prompts, extensions, and MCP-through-Pi-extension behavior.

## 0.6.0

- Track Pi edit/write tool changes with bounded before/after checkpoints.
- Add changed-file Diff, Open, stale-safe Revert, and Source Control actions.
- Add multiple independent streaming background Agent tasks with cancellation and resumable Pi sessions.
- Add optional detached Git worktree isolation with open and cleanup controls.
- Add Plan-to-Agent handoff and foreground-composer Background/Worktree actions.

## 0.5.0

- Add cancellable, debounced, cached Pi inline ghost-text completions.
- Add focused Inline Edit, Explain, Fix, Review, Document, and Generate Tests commands.
- Preview all generated edits in VS Code diff UI and require explicit Apply confirmation.
- Add bounded current-file, selected-code, diagnostics, and file-picker context attachments.
- Add editor keybindings and inline-completion configuration.

## 0.4.0

- Replace one-shot sidebar requests with a persistent streaming Pi RPC runtime.
- Add Ask, Edit, Plan, and Agent modes with explicit tool policies.
- Stream assistant text, thinking status, retries, compaction, and tool activity.
- Add model, thinking-level, session naming, new/resume session, compaction, and terminal controls.
- Restore Pi session messages and recover from stale saved sessions or unexpected process exits.
- Bridge Pi extension UI requests to native VS Code dialogs and notifications.

## 0.3.0

- Add a dedicated Pi conversation view in the VS Code Activity Bar.
- Persist bounded conversation history in workspace state.
- Add explicit current-selection attachment, cancellation, and new-chat controls.
- Protect the webview with a restrictive content security policy and text-only rendering.

## 0.2.0

- Add the native `@pi` VS Code Chat participant.
- Add `/explain`, `/review`, and `/fix` chat commands.
- Include bounded conversation history and file or selection references in chat requests.
- Add `Pi: Open Chat` and Husky pre-commit verification.

## 0.1.0

- Add an editor context menu for asking Pi about selected code.
- Add a safe selection-replacement command for Pi-generated modifications.
- Add Pi executable, provider, model, and thinking-level settings.
