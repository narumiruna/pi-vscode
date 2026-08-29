# Pi Coding Agent for VS Code

Use Pi in VS Code through a dedicated conversation view, the native `@pi` chat participant, and focused editor actions.

## Features

- Stream persistent Pi sessions in Ask, Edit, Plan, or Agent mode.
- Attach selections, files, diagnostics, terminal text, and images as bounded context, including image paste with Ctrl/Cmd+V.
- Send editor context-menu actions into the persistent Pi Chat session so follow-up questions retain the conversation.
- Preview generated edits in Pi Chat before explicitly applying or rejecting them, and safely review tracked file changes.
- Run inline completions, predicted next edits, and parallel background or worktree agents.
- Use Pi models, thinking levels, commands, prompt templates, skills, and extensions.
- Let Pi read the active VS Code editor context, open source locations, and show requested notifications through a local authenticated bridge.

## Requirements

- VS Code 1.106 or newer.
- [Pi](https://pi.dev) installed and authenticated.

Confirm that Pi is available in the VS Code environment:

```bash
pi --version
```

## Install

```bash
code --install-extension ./pi-coding-agent.vsix --force
```

Run **Developer: Reload Window** after installation or an update.

## Use

1. Open **Pi: Open Chat** from the Command Palette or select **Pi** in the Secondary Sidebar.
2. Choose Ask, Edit, Plan, or Agent mode.
3. Use **Add context** or paste a supported image into the composer with Ctrl/Cmd+V.
4. Enter a request and review any proposed changes before applying them.
5. Press Ctrl/Cmd+I with a selection or cursor to request a focused inline edit, then preview and apply the proposal in Pi Chat.
6. Select code and use the editor's **Pi** context menu; its request and result appear in Pi Chat for continued follow-up.
7. Use `@pi` in the native Chat view when VS Code's native participant workflow is preferred; its history remains separate from the Pi Sidebar session.
8. Ask Pi to inspect the active editor or open a file when the VS Code bridge tools are useful.

Use **More…** for session resume, thinking level, commands, compaction, export, terminal handoff, and background or worktree agents.
The packaged Pi extension exposes `vscode_context`, `vscode_open_file`, and `vscode_notify` to foreground chat sessions and terminal handoffs opened from the Pi view.
Automatic inline completions are disabled by default and can be enabled with `piCodingAgent.inlineCompletions.enabled`.

## Key Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `piCodingAgent.executablePath` | `pi` | Sets the Pi executable or absolute path. |
| `piCodingAgent.defaultMode` | `ask` | Selects the mode for new conversations. |
| `piCodingAgent.agent.confirmToolCalls` | `dangerous` | Controls approval for mutating tools. |
| `piCodingAgent.approveProjectResources` | `false` | Allows trusted project-local Pi resources. |
| `piCodingAgent.inlineCompletions.enabled` | `false` | Enables automatic inline completions. |

## Security

Ask and Plan are read-only, Edit can modify files without shell access, and Agent enables the complete coding toolset after confirmation.
Generated edits use a diff preview and require explicit application.
Project-local Pi resources remain disabled until the workspace is trusted and the setting is enabled.
Prompts and context are sent to the Pi subprocess through standard input rather than command-line arguments.

## Development

```bash
npm install
npm test
npm run package
```

Use `just dev` to compile and launch an Extension Development Host.

## License

MIT
