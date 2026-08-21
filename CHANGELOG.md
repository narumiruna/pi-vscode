# Changelog

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
