# Security and Privacy

## Process Boundaries

The extension starts the configured Pi executable with `shell: false`.
Prompts, source code, terminal text, and image payloads are written to Pi over stdin rather than process arguments.
Pi provider authentication remains in Pi's credential store or provider environment variables.
The VS Code bridge listens on a random loopback TCP port in the same extension-host environment.
Each bridge request and event subscription requires a random per-window token passed to Pi processes and future integrated terminals.
Oversized or malformed bridge frames fail closed and terminate their socket.
Processes in an authenticated terminal can inherit that token, so requests remain allowlisted and expose no arbitrary command execution or file mutation method.
The bridge exposes bounded editor context, file opening, notifications, and JSON-safe events from same-host VS Code extensions.

## Modes and Tools

Ask and Plan modes only enable `read`, `grep`, `find`, and `ls`.
Edit mode enables file read/write tools but not shell execution.
Agent mode enables the complete Pi coding toolset and requires an explicit confirmation when selected.
Background and worktree buttons also require explicit confirmation.

## Per-Tool Permissions

The packaged `resources/pi-vscode-permission-gate.ts` extension runs inside Pi before mutating tools execute.
The `piCodingAgent.agent.confirmToolCalls` setting supports `off`, `dangerous`, and `all`.
`dangerous` confirms dangerous shell patterns and writes to sensitive or out-of-workspace paths.
`all` confirms every bash, edit, and write call.
A missing RPC permission UI blocks gated tools instead of allowing them.

## Project Trust

Project-local Pi settings, extensions, skills, and prompts are not approved by default.
Enable `piCodingAgent.approveProjectResources` only for a trusted workspace. RPC launches explicitly pass `--no-approve` when this setting is disabled, rather than relying on inherited global Pi approval.
New workflow processes and mutations reject untrusted or virtual workspaces in the host, not just disabled UI. Foreground actions and resumed session headers must match Pi's canonical working directory. Cross-worktree sessions must be opened in the matching workspace window.
The standalone `pi-vscode` extension is installed globally and executes with the user's permissions.
Pi extensions must be reviewed before installation.

## Change Safety

Deleting a conversation requires modal confirmation and moves its persistent session file to Trash before starting a replacement session.
Focused editor edits enter the persistent Pi Chat session as edit proposals.
A packaged read-only policy gate recognizes only extension-controlled prompt-prefix metadata, narrows active tools, and blocks every non-read-only tool while Pi generates a proposal, regardless of the current Chat mode.
Apply remains disabled until the user opens Preview for the current hunk selection. Selection changes invalidate Preview. The host computes hunks from captured text, validates IDs, checks document version immediately before one workspace edit, and finishes the proposal without applying the remainder.

Checkpoint capture completes before submitting the foreground prompt; late tool-start notifications never establish the before-image. Coverage requires pre-captured existing regular text and an unambiguous supported edit/write announcement whose expected result matches final disk text. This is conservative coverage, not proof of every external writer's identity. Dirty buffers, unsupported files, creations/deletions and ambiguous attribution are excluded. Shell/custom-tool requests and process exits without settlement are non-restorable. Capture is bounded to 10,000 entries / 20 MiB. History is memory-only, capped at 20 requests, 2 MiB per file side and 20 MiB retained before/after bytes; unresolved restore failures retain recovery data and may prevent new history from being retained.

Restore preflights all selected paths/content/dirty buffers and later checkpoint dependencies, then rechecks each write. Proposal/import/restore and active Pi work in the same canonical directory share an operation gate. Successful and partial restore attempts invalidate dependent previews. This gate cannot serialize another VS Code window or an external process. No operation promises filesystem-wide atomicity or rolls back arbitrary shell/service effects. Checkpoints never rewind the transcript or index; Source Control review and backups remain required.

## Webview Safety

The Pi conversation webview uses a nonce-based Content Security Policy.
Assistant Markdown is escaped before supported formatting is added.
User, model, tool, and persisted text cannot inject raw scripts or HTML.

## Data Bounds

Text attachments are limited per item and in aggregate.
Image attachments are limited by count, MIME type, canonical Base64 encoding, decoded byte size, and active-model capability.
Clipboard images are validated in both the webview and Extension Host, and SVG payloads are rejected.
RPC JSON lines, bridge requests and responses, editor selections, diagnostics, tool output, persisted messages, completion context, change snapshots, and background-task output are bounded.

## Workflow Snapshots

Staged review uses fixed Git argument vectors, no shell, no external diff/textconv, no optional index writes, bounded output, and cancellation deadlines.
HEAD, index entries, and repository identity are revalidated before results are used.
Findings are validated against captured text and cannot open invented working-tree paths.
Source snapshots are sent only after confirmation; existing Pi history and later tool reads remain separate context. Git read paths disable hooks, fsmonitor, external diff and textconv; result capture disables configured clean/smudge/process filters, and inherited `GIT_*` overrides are removed. Non-UTF-8 path records reject capture. Unsafe paths and binary/symlink/submodule files are excluded rather than interpreted as model-selected filesystem targets. Task import also excludes executable-bit changes/additions instead of silently losing mode changes.

Isolated-task metadata records the exact detached base and originating repository identity. Import revalidates task inactivity, source revision, destination identity, clean affected buffers and base-or-already-imported content before writes. Legacy or interrupted tasks with unverifiable inactivity cannot import. PID reuse fails closed. Import never stages, resets, changes branches, or deletes the source worktree; partial I/O failures report exact applied/skipped/failed paths for recovery. Explicit worktree removal is destructive and separately confirmed. Missing or unowned cleanup paths fail closed.

## Context and Test Evidence

Attachment inspection shows exactly the queued snapshots, not all provider context. Pins are bounded in-memory text, expire with session/reload, and never refresh silently. Redaction creates a new revision; accepted sends remove only the consumed unpinned IDs. Filename/secret warnings and log redaction are best-effort, not guaranteed detection. Attachment editing uses a normal untitled editor that VS Code may back up for hot exit; close/discard it after use. Debug/test redaction uses password-masked literal replacement and fresh read-only inspection instead of an untitled copy. This extension does not persist raw debug snapshots/checkpoint text; normal user-approved provider transmission and Pi history have their usual retention.

Test commands are user-supplied executable/argument vectors, not model output or shell expressions. Each run displays the working directory and requires explicit trust/approval; it executes workspace code with the user's privileges and may have side effects. Runs are capped at 60 seconds / 256 KiB output and own a POSIX process group. Timeout/cancellation kills owned processes; escaped descendants and Windows descendants are not guaranteed stopped. A hard pipe deadline returns an explicit cleanup-unverified result instead of hanging. Each observed run is bound to the selected clean source version and disk contents, checked before and after execution and before proposing a repair. A mismatch requires fresh evidence; external writers can still race checks. Existing logs are explicitly selected bounded UTF-8 files (100,000 bytes), preserving multiline content without creating another hot-exit-backed editor. Test output is inspected/redacted before a read-only repair request. Preview, Apply and approved save/rerun are separate actions, with at most two repair attempts. Only observed process results count as test evidence; supplied logs and background model summaries are labelled accordingly.

## In-Flight Instructions

Only ordinary composer requests own a text queue in the current mode/session. Callback-owned editor, review, repair and debug requests cannot accept continuations. Queue state is validated and bounded to 10 messages / 50,000 characters. `agent_settled`, not a model-turn end, closes the request/checkpoint. Cancellation clears pending instructions before abort. Unsupported commands, missing queue-state acknowledgement or ambiguous delivery stop/disconnect Pi and preserve bounded uncertain drafts; nothing is replayed automatically. Review history before resending. Draft insertion and accepted-send clearing check the composer revision.

## Debugger Inspection

Only explicit paused `node`/`pwa-node` js-debug capture is enabled. Stable VS Code 1.106 APIs bind the selected frame to a tracked pause generation; continue, step, restart, frame changes and termination invalidate capture. Requests are limited to `stackTrace`, `scopes` and one non-expensive local `variables` scope: 20 frames, 50 candidates, 1,000 characters/value, 20,000 total characters and a five-second deadline. No evaluate, mutation, memory, recursive or lazy-value requests are sent. Custom description/property generators and automatic getter expansion must be disabled. Configuration is resolved against the debug session's workspace URI and rechecked before DAP reads. The checked adapter read path can still perform adapter-specific inspection work; this is not a promise of inert evaluation across debugger versions. Raw launch configuration/environment are excluded, and source excerpts require clean bounded regular files inside the workspace. Capture and variable selection are local; only a second inspected/redacted snapshot plus an explicit question can reach Pi. Debug snapshots cannot be pinned.

## External Services

The selected Pi provider receives prompts and context according to its own privacy policy.
Git hosting, SSH, cloud agents, MCP servers, and other Pi-extension services are separate external dependencies with their own authentication and data policies.
