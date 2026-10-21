# Pi terminology

The reference is Pi 1.3.0.
Names follow public `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` contracts where the concepts match.
This does not add an SDK dependency to the Extension Host or change the supported Pi versions.

## Core terms and local boundaries

| Core concept | Extension name | Boundary |
| --- | --- | --- |
| `AgentSession.executeBash()`; `RpcClient.bash()` | `PiRuntimeManager.executeBash()`; `PiRpcClient.bash()` | Trust, read-only policy, ownership and stale-state checks, without extra execution approval; see [Direct shell](#direct-shell). |
| `BashResult`; `BashExecutionMessage` | `BashResultView`, `parseBashResultView()`, `formatBashExecutionText()` | Sanitized, bounded presentation; see [Presentation and metadata](#presentation-and-metadata). |
| `AuthType` | `IsolatedPiAuthType` | The same `api_key` / `oauth` values cross the helper boundary. |
| `AuthPrompt`; `AuthInteraction` | `IsolatedPiAuthPrompt`; `IsolatedPiAuthInteraction` | These are restricted protocol projections with different fields and callbacks, not SDK interfaces. |
| Provider authentication metadata | `IsolatedPiProviderAuthSummary` | IDs and available auth types only; see [Presentation and metadata](#presentation-and-metadata). |
| Public SDK work in a separate process | `runIsolatedPiHelper()`, `IsolatedPiRequest`, `IsolatedPiResult`, `IsolatedPiHelperError` | These belong to this extension's helper protocol, not Pi core. |
| `ModelRuntime`; `AgentSessionRuntime` | `modelRuntime`; `sessionRuntime` in the packaged helper | These variables hold the actual SDK classes. |
| Resource reload versus process restart | `reloadResources()`; `restartSessionProcess()` | Restart stops and starts RPC, not SDK resource reload. |
| Session JSONL and active-branch export | `ValidatedSessionJsonl`, `assertSessionJsonlWorkspace()`, `prepareActiveBranchExport()` | Parsed files and staged exports are not live sessions or `SessionManager` instances. |

### Direct shell

The host checks workspace trust, read-only policy, operation ownership and stale workspace/session/client state.
These checks do not add execution approval and do not provide a sandbox.
Pi and installed extensions own tool and shell permissions.
Without a permission policy, execution can proceed with no confirmation.
See [Direct Shell](SECURITY.md#direct-shell) for the full contract.

### Presentation and metadata

`BashResultView` is a sanitized, bounded presentation.
It omits `fullOutputPath`; it is not the raw SDK type.

`IsolatedPiProviderAuthSummary` contains only IDs and available auth types.
It is not a provider instance or MCP `AuthProvider`.

Native controls use **Steering mode**, **Follow-up mode**, **Startup thinking level**, and **Scoped model patterns**.
The thinking disclosure remains **Thinking**.
Its blocks are projections of `ThinkingContent`, not hidden provider reasoning.

## Names that remain distinct

- `PiRuntimeManager` and `PiRuntimeControl` own VS Code RPC processes, bridge access, policies, dialogs and ownership.
  They are not SDK `ModelRuntime` or `AgentSessionRuntime` classes.
- `PiRpcClient` is an extension-owned bounded transport.
  Its launch, permission and cleanup contracts differ from the exported SDK `RpcClient`.
- **Direct shell**, **Sign In/Sign Out**, and **Global Pi/Project Pi** are also Pi terms.
  They do not need a blanket rename.
  Public settings APIs use global/project scope.
- **Next** and **After this** are composer action labels.
  The corresponding Pi settings are steering mode and follow-up mode.
- Session tree, branch, fork and clone retain their separate meanings.
  A bounded UI tree is not the raw SDK `SessionTreeNode` type.
- Checkpoints, Preview/Apply, ownership and view-state names remain extension concepts.

## Stable identifiers

This alignment changes internal TypeScript names and selected labels only.
Command IDs such as `pi.restartResources`, configuration and storage keys, reserved command names, helper protocol fields, RPC records, event names and resource filenames stay unchanged.
No data migration is needed.

## Public references

- Coding agent: `docs/sdk.md`, `docs/rpc-commands.md`, `docs/message-types.md`, and `docs/settings.md`.
- Coding agent declarations: `core/agent-session.d.ts`, `core/bash-executor.d.ts`, `core/agent-session-runtime.d.ts`, `core/model-runtime.d.ts`, and `modes/rpc/rpc-client.d.ts`.
- Pi AI declarations: `auth/types.d.ts`.
- Pi MCP declarations: `auth-provider.d.ts`; its `AuthProvider` is not a provider-auth summary.

These paths are public reference material from the installed packages.
They are not runtime import paths in the Extension Host.
