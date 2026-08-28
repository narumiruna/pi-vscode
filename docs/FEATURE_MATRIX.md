# Pi VS Code Feature Matrix

This matrix maps the capabilities advertised by the four requested reference extensions to the Pi workflow implemented in this repository.
Vendor-owned hosted services cannot be reproduced by a local extension, so those rows name the external dependency and the available Pi-local alternative.

| Reference capability | Pi VS Code workflow | Status / evidence |
| --- | --- | --- |
| Codex side-by-side chat panel | Dedicated Pi Activity Bar conversation view | Implemented in `src/sidebar.ts` and `src/sidebarHtml.ts`. |
| Codex context from open files and selections | Selection, current file, file picker, diagnostics, terminal text, and image attachments | Implemented with item, size, and total bounds. |
| Codex edit and preview changes | Editor actions use the persistent Pi Chat session, create proposal cards, generate virtual-document diffs, and require Preview before Apply | Implemented in `src/editorActions.ts` and `src/sidebar.ts`. |
| Codex cloud delegation | Independent background and detached-worktree Pi agents with streamed tracking | Local equivalent implemented; OpenAI-hosted Codex Cloud remains an OpenAI service dependency. |
| Codex cloud task review locally | Resume a background Pi session, open its worktree, and review Source Control | Implemented. |
| GitHub Copilot inline completion | Manual or opt-in automatic VS Code ghost-text completion | Implemented with cancellation, debounce, cache, and bounded context. |
| GitHub Copilot next edit suggestion | `Pi: Suggest Next Edit` predicts one focused whole-file change and opens a diff preview | Implemented local equivalent; Copilot's proprietary ranking model is a GitHub service dependency. |
| Copilot Chat conversational assistance | Dedicated Pi view plus native `@pi` Chat participant and slash commands | Implemented. |
| Copilot inline chat | `Pi: Inline Edit` and selection smart actions route into persistent Pi Chat, preserve follow-up context, and preview edits | Implemented with `Ctrl/Cmd+Alt+I`. |
| Copilot Ask/Edit/Plan/Agent modes | Four explicit Pi runtime profiles with tested tool allowlists | Implemented in `src/runtimeProfiles.ts`. |
| Copilot autonomous multi-step agent | Persistent Pi RPC Agent mode reads, edits, runs commands, tests, retries, and self-corrects | Implemented using Pi's full coding toolset. |
| Copilot central session management | New, name, resume, compact, export, terminal handoff, foreground, and background sessions | Implemented in the Pi conversation view. |
| Copilot Plan-to-implementation handoff | `Implement Plan` restarts the same persistent session in Agent mode | Implemented. |
| Copilot change review and revert | Tool activity, changed-file cards, Source Control, diff, open, and stale-safe revert | Implemented for bounded edit/write tool files; shell-created changes remain reviewable in Source Control. |
| Copilot custom instructions | Pi global/project AGENTS.md and Pi system/settings resources | Implemented through normal Pi resource discovery and explicit project trust. |
| Copilot skills and custom agents | Pi skills, prompt templates, extension commands, mode profiles, and background agents | Implemented and discoverable through `Commands…`. |
| Copilot MCP and external tools | Tools supplied by installed Pi extensions, including third-party MCP bridges | Supported through Pi's extension system; each external server/bridge remains its own dependency. |
| Claude Code editor awareness | Current file, selection, diagnostics, files, images, and terminal context, plus Pi-callable `vscode_context` and `vscode_open_file` bridge tools | Implemented through an authenticated loopback bridge. |
| Claude Code autonomous file/terminal work | Agent mode and background agents use Pi edit/write/bash tools | Implemented. |
| Claude Code permission prompts | Packaged Pi tool-call gate supports off, dangerous, or all mutating confirmations | Implemented through RPC extension UI. |
| Claude Code subagents | Multiple independent foreground/background/worktree Pi RPC clients | Implemented local equivalent. |
| Claude Code custom slash commands | Pi extension commands, prompt templates, and skills from `get_commands` | Implemented. |
| Claude Code terminal-style interface | Open the active Pi session in an integrated terminal | Implemented. |
| Claude Code subscription/model choice | Pi's provider authentication, subscription OAuth, API keys, model catalog, and thinking levels | Implemented by reusing Pi; provider subscriptions remain provider dependencies. |
| Image-aware chat | Bounded PNG, JPEG, GIF, and WebP RPC image payloads from file selection or Ctrl/Cmd+V paste, with model-capability checks | Implemented. |
| Session export | Pi RPC HTML export and open action | Implemented. |
| Hosted pull-request agent | Agent/worktree mode can use installed `git` and `gh` tools to create branches, commits, pushes, and PRs | Local orchestration implemented; GitHub credentials and hosted repository access are external dependencies. |
| Cross-machine cloud synchronization | Exported sessions and Git/remote-provider workflows | Requires an external storage or hosted-agent service; no vendor-neutral synchronization service exists in this local extension. |
