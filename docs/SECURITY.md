# Security and Privacy

## Process Boundaries

The extension starts the configured Pi executable with `shell: false`.
Prompts, source code, terminal text, and image payloads are written to Pi over stdin rather than process arguments.
Pi provider authentication remains in Pi's credential store or provider environment variables.

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
Enable `piCodingAgent.approveProjectResources` only for a trusted workspace.
Pi extensions execute with the extension-host user's permissions and must be reviewed before installation.

## Change Safety

Focused editor edits open a diff and require explicit Apply.
The original document version is checked before preview and again before apply.
Foreground Pi edit/write tools checkpoint bounded files before execution.
Revert is refused when current content differs from the recorded post-agent hash.
Shell commands can modify files outside checkpoint coverage, so Source Control review remains required.

## Webview Safety

The Pi conversation webview uses a nonce-based Content Security Policy.
Assistant Markdown is escaped before supported formatting is added.
User, model, tool, and persisted text cannot inject raw scripts or HTML.

## Data Bounds

Text attachments are limited per item and in aggregate.
Image attachments are limited by count, MIME type, and byte size.
RPC JSON lines, diagnostics, tool output, persisted messages, completion context, change snapshots, and background-task output are bounded.

## External Services

The selected Pi provider receives prompts and context according to its own privacy policy.
Git hosting, SSH, cloud agents, MCP servers, and other Pi-extension services are separate external dependencies with their own authentication and data policies.
