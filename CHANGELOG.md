# Changelog

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
