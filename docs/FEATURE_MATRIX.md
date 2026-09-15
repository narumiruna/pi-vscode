# PiCode Feature Matrix

This matrix maps the capabilities advertised by the four requested reference extensions to the PiCode workflow implemented in this repository.
Vendor-owned hosted services cannot be reproduced by a local extension, so those rows name the external dependency and the available Pi-local alternative.

| Reference capability | PiCode workflow | Status / evidence |
| --- | --- | --- |
| Staged Git review | Confirm bounded staged snapshots and navigate immutable before/after findings | `gitSnapshots.ts`, `gitReview.ts`; temporary Git and host-controller tests. Unstaged/branch/PR review excluded. |
| Selective application | Choose deterministic hunks, preview the combined selection, Apply once | `editHunks.ts`, `editProposals.ts`, `editorActions.ts`; selected-preview/one-workspace-edit and stale-version tests. No automatic rebase. |
| Context inspection | Exact snapshots, explicit edit/redact/refresh, bounded memory-only pins | `contextInspector.ts`, `sidebarAttachments.ts`; revision-safe consumed-item tests. Estimates exclude Pi history/instructions/future reads; image usage unknown. |
| Failed-test repair | Explicit process command or supplied failure log, read-only proposal, approved save/rerun | `testRepair.ts`, `testRepairController.ts`; real failing Node test repaired/rerun with fixture response. Two attempts, one source file; no private Test Explorer API. |
| Request checkpoints | Bounded pre-prompt snapshots, coverage report, preview and guarded restore | `checkpointHistory.ts`, `changeTracker.ts`; immediate-write subprocess boundary and stale/dirty/dependency tests. Memory-only; no creations/deletions/shell rollback. |
| In-flight instructions | Enter-to-Steer, platform Follow Up shortcut, pending counts and recovered drafts | `piRpcClient.ts`, `piRuntime.ts`, `sidebarHtml.ts`; deterministic RPC/lifecycle/keyboard fixtures. Ordinary text-only composer requests; unsupported/uncertain queue delivery disconnects without replay. Pi queue grouping settings remain native. |
| Debug-context questions | Explicit bounded paused Node.js capture, variable selection, inspection/redaction, read-only question | `debugContext.ts`, `debugContextController.ts`; fake DAP/host invalidation tests. Only checked js-debug read paths; no evaluate/recursive capture. |
| Codex side-by-side chat panel | Dedicated PiCode Secondary Sidebar conversation view | Implemented in `src/sidebar.ts` and `src/sidebarHtml.ts`. |
| Codex context from open files and selections | Selection, current file, file picker, diagnostics, terminal text, and image attachments | Implemented with item, size, and total bounds. |
| Codex edit and preview changes | Editor actions use the persistent PiCode Chat session, create proposal cards, generate virtual-document diffs, and require Preview before Apply | Implemented in `src/editorActions.ts` and `src/sidebar.ts`. |
| Codex cloud delegation | Independent background and detached-worktree PiCode agents with streamed tracking | Local equivalent implemented; OpenAI-hosted Codex Cloud remains an OpenAI service dependency. |
| Codex cloud task review locally | Inspect actual isolated-task results and explicitly import selected files into the originating worktree | `backgroundResults.ts`, `backgroundAgents.ts`; Git, partial-failure and metadata/reload tests. Legacy tasks without verified origin cannot import; model test claims are not evidence. |
| GitHub Copilot inline completion | Manual or opt-in automatic VS Code ghost-text completion | Implemented with cancellation, debounce, cache, and bounded context. |
| GitHub Copilot next edit suggestion | `PiCode: Suggest Next Edit` predicts one focused whole-file change and opens a diff preview | Implemented local equivalent; Copilot's proprietary ranking model is a GitHub service dependency. |
| Copilot Chat conversational assistance | Dedicated PiCode view plus native `@picode` Chat participant and slash commands | Implemented. |
| Copilot inline chat | `PiCode: Inline Edit` targets the selection or current line, routes into persistent PiCode Chat, preserves follow-up context, and previews edits | Implemented with `Ctrl/Cmd+I`. |
| Copilot Ask/Edit/Plan/Agent modes | Pi-default conversation without extension-defined modes | Deliberately uses Pi's default tools and extension-contributed tools instead of recreating Copilot modes or fixed allowlists. |
| Copilot autonomous multi-step agent | Persistent Pi RPC conversation reads, edits, runs commands, tests, retries, and self-corrects | Implemented using Pi's default coding toolset. |
| Copilot central session management | New, name, resume, compact, export, terminal handoff, foreground, and background sessions | Implemented in the PiCode conversation view. |
| Copilot Plan-to-implementation handoff | Plan and build welcome actions create ordinary prompt drafts in the same Pi-default session | No special mode transition or runtime restart is required. |
| Copilot change review and revert | Tool activity beside the active response, changed-file cards, request history, Source Control, diff, open, and stale/dirty-safe revert | Foreground tool activity stays in the conversation flow; proposals, changed files, and background agents remain in the workflow area. Covered pre-captured regular edit/write files only; shell and uncertain effects require Source Control review. |
| Copilot custom instructions | Pi global/project AGENTS.md and Pi system/settings resources | Implemented through normal Pi resource discovery and explicit project trust. |
| Copilot skills and custom agents | Pi skills, prompt templates, extension commands, contributed tools, and background agents | Implemented and discoverable through `Commands…`; tool discovery is not restricted by a fixed allowlist. |
| Copilot MCP and external tools | Tools supplied by installed Pi extensions, including third-party MCP bridges | Supported through Pi's extension system; each external server/bridge remains its own dependency. |
| Claude Code editor awareness | Current file, selection, diagnostics, files, images, and terminal context, plus Pi-callable `vscode_context` and `vscode_open_file` bridge tools | Implemented through an authenticated loopback bridge and standalone Pi extension. |
| Claude Code autonomous file/terminal work | Foreground and background sessions use Pi's default edit/write/bash tools | Implemented. |
| Claude Code permission prompts | Packaged Pi tool-call gate supports off, dangerous, or all mutating confirmations | Implemented through RPC extension UI. |
| Claude Code subagents | Multiple independent foreground/background/worktree Pi RPC clients | Implemented local equivalent. |
| Claude Code custom slash commands | Pi extension commands, prompt templates, and skills from `get_commands` | Implemented. |
| Claude Code terminal-style interface | Open the active Pi session in an integrated terminal | Implemented. |
| Claude Code subscription/model choice | Pi's provider authentication, subscription OAuth, API keys, model catalog, and thinking levels | Implemented by reusing Pi; provider subscriptions remain provider dependencies. |
| Image-aware chat | Bounded PNG, JPEG, GIF, and WebP RPC image payloads from file selection or Ctrl/Cmd+V paste, with model-capability checks | Submitted images remain on the consuming user turn as responsive thumbnails with keyboard preview. Stable content IDs merge local labels after history refresh; bounded one-shot caches keep Base64 out of routine state/storage, and missing bytes degrade to labeled placeholders. |
| Session export | Pi RPC HTML export and open action | Implemented. |
| Hosted pull-request agent | Foreground/worktree sessions can use installed `git` and `gh` tools to create branches, commits, pushes, and PRs | Local orchestration implemented; GitHub credentials and hosted repository access are external dependencies. |
| Cross-machine cloud synchronization | Exported sessions and Git/remote-provider workflows | Requires an external storage or hosted-agent service; no vendor-neutral synchronization service exists in this local extension. |
