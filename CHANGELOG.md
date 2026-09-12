# Changelog

## Unreleased

- Add confirmed read-only staged Git review with immutable finding navigation, stale-index detection, and explicit skipped-file coverage.
- Add deterministic hunk selection, revision-bound Preview, and single-Apply partial proposals without applying the remainder.
- Record isolated-task origin/base metadata; preview actual committed, uncommitted and untracked results and import selected text files with stale/dirty/path gates and recoverable partial reports.
- Add exact attachment inspection, edit/redact, explicit refresh, memory-only pins, heuristic estimates and revision-safe draft/attachment consumption.
- Add approved process-based failed-test repair with inspected/redacted evidence, read-only proposals and at most two approved reruns.
- Replace tool-notification-time capture with bounded pre-prompt request checkpoints, conservative coverage reports, dependency checks and dirty/stale-safe historical restore.
- Add session/policy-bound Steer and Follow Up, bounded queue feedback, clear-before-abort cancellation and uncertain-draft recovery without replay.
- Add explicit bounded Node.js debug snapshots, variable selection/redaction, pause/frame invalidation and read-only questions; no evaluate or recursive requests.
- Serialize foreground request/session operations, bind resumed sessions to their working directory, bound subprocess cleanup, and explicitly disable unapproved project resources.
- Compile against exactly VS Code 1.106 declarations rather than newer APIs. Record automated workflow evidence and explicitly deferred interactive/remote validation in `docs/WORKFLOW_VALIDATION.md`.

- Add a confirmed **Delete Conversation** button that moves the current persistent Pi session to Trash and starts a new session.
- Add a standalone global Pi extension with authenticated request/event communication, `pi.events` interoperability, and integrated-terminal discovery.
- Export a same-host VS Code API for broadcasting bounded events to connected Pi sessions.
- Install both the Pi extension and VSIX through `just install`.
- Add **Fix with Pi** quick fixes for red and yellow diagnostics through VS Code's lightbulb menu, the editor toolbar, and Ctrl/Cmd+I, with contextual diff previews and inline-edit fallback away from diagnostics.
- Support Pi Inline Edit for both selections and the current line at the cursor as the Ctrl/Cmd+I fallback when no diagnostic is targeted.
- Redesign Pi Chat around a compact header, native Quick Pick secondary actions, attachment chips, explicit reconnect, cancellation, history-recovery states, serialized submission, retry-safe composer drafts, and narrow Sidebar layouts.
- Route editor context-menu questions and edit requests through the persistent Pi Chat session for continuous follow-up, with absolute editor-resource context for multi-root workspaces.
- Add safe Ctrl/Cmd+V image attachment with client and extension-host MIME, Base64, count, size, and model-capability checks, and hold submission until pasted images finish loading.
- Add in-chat edit proposal cards that enforce structurally trusted read-only generation, retain live previews, release terminal callbacks, bound terminal history, require Preview before Apply, reject stale document versions, and serialize Apply across all live proposals.
- Add an authenticated local bridge with fail-closed bounded framing and Pi tools for reading VS Code editor context, opening files, and showing requested notifications.
- Load the bridge in foreground chat runtimes and Pi terminal handoffs while keeping bridge-only tools out of independent background profiles.
- Capture each request's authoritative assistant response from its event stream across compaction, keep session actions locked through post-processing, and honor cancellation before delayed startup submits a prompt.
- Preserve composer edits and attachments added while a background or worktree agent starts.
- Move the Pi Chat view's default location to the Secondary Sidebar.
- Add a Pi button to the editor title toolbar for opening Chat.
- Require VS Code 1.106 or newer for Secondary Sidebar view contributions.
- Add a `just dev` recipe for compiling and launching the Extension Development Host.

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
