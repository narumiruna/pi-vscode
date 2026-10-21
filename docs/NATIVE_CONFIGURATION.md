# Native Pi configuration contract

The reference implementation is Pi 1.3.0. This is not a new minimum Pi version. The extension does not import Pi in the Extension Host. Unsupported RPC commands fail instead of falling through to a model prompt. Native file controls implement the documented strict JSON format, not an independent Pi settings database.

## Targets and effects

| Control | Read source | Write target | Active effect |
| --- | --- | --- | --- |
| Pi Settings: General, Permissions, Editor | VS Code configuration | Selected User/Workspace `pi.*` override | Existing launch/editor behavior; no Pi process |
| Pi Settings: Pi Files | Global Pi/Project Pi card | Fixed-scope host-native `settings.json` or `mcp.json` dialogs | Navigation only; no inline file content, new configuration keys or duplicate schema |
| Native startup provider/model/thinking | Global Pi/Project Pi `settings.json` | Selected Global Pi/Project Pi member | Next controlled restart; launch overrides and resumed session state can take precedence |
| Ordered `enabledModels` | Global Pi/Project Pi `settings.json` | Selected file member | Startup/cycling preferences, not model access control; no supported live setter |
| Queue grouping files | Global Pi/Project Pi `settings.json` | Selected file member | Later restart; runtime controls are separate |
| Compaction/retry files | Nested `enabled` member | Selected file member | Later restart; sibling tuning members remain unchanged |
| Native runtime controls (requires an already running Pi; opening never cold-starts it) | `get_state` for queue modes/compaction; retry read unavailable | Public `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry` | Idle foreground runtime plus a Global Pi persistence request; not session-only |
| MCP configuration | Global Pi/Project Pi `mcp.json` | Selected server/metadata member | Save alone does not connect; explicit resource reload is separate |
| MCP CLI diagnostic | Explicit `pi mcp list --json` | No extension-owned persistent result | Separate temporary connections; not evidence of current-session connections |

Pi queues Global Pi settings persistence separately. An RPC setter acknowledgment does not prove that the disk write succeeded. Pi 1.3.0 has no public flush/error-drain RPC and no authoritative retry-enabled state read. The UI reports the acknowledgment and unverified persistence, not a verified durable save. It does not reorder or clear queued messages.

## Resolution and approval

The Global Pi agent directory is `PI_CODING_AGENT_DIR` from the Extension Host environment, or the host home directory's `.pi/agent`. A leading `~/` expands to that home directory; a relative override resolves against Pi's launch directory. In remote windows these are remote host paths, not browser/client paths.

Project Pi files live in the current launch workspace's `.pi`, using the existing first workspace folder behavior. There is no multi-root folder selector. Pi loads project resources only under the existing project-resource approval policy. Passive inspection marks unapproved project overrides inactive. The fixed-scope Project Pi MCP editor includes these inactive project entries even when approval is off; editing does not activate them. Saving does not change VS Code trust, native Pi trust, project-resource approval, runtime settings, packages or installed extensions.

Common settings use project-over-global inheritance; nested objects merge. Resource lists have different combination semantics and are not edited by common controls. `enabledModels` retains order and Pi pattern syntax (exact/fuzzy/provider/glob/thinking suffix). No model catalog is fetched, no zero-match result is invented, and no match is represented as an access restriction.

MCP project transport entries replace global entries. A project entry without `command`, `url` or `type` overrides only `enabled`, `exposure` and `toolExposure` and inherits the global transport/credentials. Removing a project override leaves the global server and auth intact. Server names differing only in `-` and `_` cannot be added in the same file.

## Editing boundaries

**Pi Settings → Pi Files** has **Global Pi** and **Project Pi** cards, each with **Edit … settings.json** and **Edit … mcp.json** buttons. These route to existing host-native dialogs with the card's fixed scope. Command Palette native management remains available. Native controls require a trusted, file-backed workspace, including for Global Pi. No native file content, URL, environment value, header, OAuth object or credential command is sent to the browser. MCP projections expose only validated name/type/source/enabled/exposure and unknown connection state. No `auth.json` or `mcp-auth.json` is read by management code.

Opening, reading, or switching categories/scopes never creates files or directories. Only the first explicit override save creates the required `settings.json` or `mcp.json` and missing Pi directories under the validated ancestor. Reset of an absent override creates nothing; saving one file does not create the other.

Each file is limited to 128 KiB, UTF-8, a strict JSON object, maximum depth 32. Known controls have type/enum bounds; model patterns allow 100 entries of 256 characters. Duplicate object keys and unsafe keys are rejected in edited object paths. Unknown keys remain unchanged. Existing member replacements/resets preserve unrelated member bytes and ordering. Insertions use the existing newline/indent convention where detected. JSONC comments and invalid syntax are not rewritten.

Regular single-link files and canonical directories are required. Workspace-root aliases resolve to the canonical root; nested links and agent-directory links are rejected. Reads bind descriptors to named paths/ancestor identities. Writes recheck content hashes, file identity, byte limits, dirty buffers, writable mode, origin, trust and launch policy. Up to 1,000 file-backed editor URI/version/dirty snapshots are captured before dialogs; canonical identities are resolved and rechecked before writing, including supported workspace aliases and later-opened buffers. Retargeted aliases, unverifiable editor paths and changed/dirty matching documents fail closed. No hidden canonical editor bypasses an aliased dirty buffer. The runtime workspace gate and canonical configuration-file gate serialize extension-owned operations. Known external edits require reopening the native surface; no old file is restored over newer content. These checks are not filesystem-wide atomicity against external processes or other VS Code windows. An I/O error can leave a partial write or newly created file; inspect the file before retrying.

The explicit advanced native editor opens an existing `settings.json` or `mcp.json` through VS Code after warning. It is not a credential form or a schema-validation service. Normal editor Save is independent of the bounded common controls and has VS Code's ordinary backup and save behavior. Create a common override first if the file does not exist.

## MCP execution and authentication

Opening either native surface starts zero Pi processes and connections. A saved stdio executable, resource, package, header command or environment command is not executed by saving.

The explicit connection diagnostic requires modal approval for ALL enabled file-configured servers, credential commands and network access. It uses an argument array with no credentials, a 30-second deadline, cancellation, a combined 128 KiB stdout/stderr bound and bounded process cleanup. Raw transport/error/stderr text is not retained or displayed. Diagnostic metadata is memory-only and bound to the captured canonical workspace, agent directory, approval and file revisions. A file change during the check rejects its result; a later workspace/configuration change marks the retained result stale. It remains distinct from configured state; active-session connection state is unknown. POSIX group cleanup cannot establish that escaped descendants or remote effects stopped; Windows descendant cleanup is not guaranteed.

Pi 1.3.0's MCP CLI consults saved native Pi project trust, not the VS Code project-resource switch. The extension does not write native trust. It blocks diagnostics if a project MCP file exists while project-resource approval is off. With approval on, the CLI can still skip a project not trusted in native Pi; the diagnostic is not proof that every configured project entry was checked. CLI operations do not load replacement extensions.

Before offering terminal management, the active command catalog must contain exactly one extension command `mcp` with `sourceInfo.path` equal to `builtin:mcp`. Missing, duplicate or third-party ownership is not verified native support. The action uses the controlled Pi terminal handoff; no `/mcp` text is injected. The user performs sign-in, sign-out and reconnect in Pi. Pi owns URLs, remote redirects, token storage and cancellation. Signing out deletes Pi's stored auth, not provider-side revocation. Returning from the terminal does not prove authentication succeeded.

No dedicated public MCP management/current-connection-state RPC exists in Pi 1.3.0. Arbitrary `/mcp` text output is not parsed into verified native state. Full in-panel OAuth and authoritative live connection/tool/resource inventory are not implemented without public upstream contracts. The offline Pi reference fixture verifies direct/deferred/codemode/hidden and per-tool exposure, resource list/read, disabled/replacement ownership, connection errors and focused read-only denial against local stdio fixtures. The extension does not add an MCP client. Direct/deferred/codemode/hidden and per-tool exposure remain Pi semantics; common controls set server exposure while advanced per-tool configuration remains native Pi configuration. Server annotations are unverified hints. Pi and installed extensions own tool permissions, including MCP permissions; pi-vscode adds no tool-confirmation policy. Focused read-only enforcement remains unchanged.

## Apply and recovery

**Apply Saved Native Configuration (Reload Resources)** is a separate explicit idle foreground action. It rechecks trust, canonical workspace, active generation and launch policy through the shared runtime control gate. Saved resources and MCP servers can execute/connect when applied. Save does not invoke Apply. Background agents are unchanged. A failed reload retains saved files and reports saved-versus-active uncertainty; retry is deliberate. Startup defaults/scoped models are not claimed live-applied. Use **Pi: Restart Pi (Current Launch Policy)** explicitly to restart the same session and load startup preferences. Resumed model/thinking state can still take precedence. Restart approval and cleanup inspection belong to the shared runtime lifecycle; saving never calls it. No private scoped-model mutation or second session writer is added.

## Validation and support limits

Existing validation covers minimum/current Linux native Quick Picks, passive MCP metadata, scoped writes/reset, dirty-buffer rejection, workspace aliases and packaged behavior. This evidence does not validate the new Pi Files entry points or advanced MCP editor. The actual Pi 1.3.0 local stdio reference verifies inherited tools/resources and exposure. See [Integrated validation](NATIVE_PARITY_VALIDATION.md).

1. Structured authoritative live MCP state, retry-enabled reads, general native settings/live scoped-model apply and durable setter results need public upstream contracts before equivalent in-panel claims.
2. Interactive MCP authentication remains in Pi. Terminal ownership/recovery is tested; real sign-in, redirects and provider-side cancellation are not.
3. Remote hosts, Windows/macOS native behavior, live providers and external MCP servers were not tested. Local stdio fixtures are not external-server evidence.
