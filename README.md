# Pi for VS Code

Use your existing [Pi](https://pi.dev) providers, models, and tools in VS Code. Ask about code in a persistent sidebar or native `@pi` chat. Attach editor context, review Git changes, and use focused edit workflows with Preview and Apply.

**Permission boundary:** Focused edit workflows generate proposals under a read-only policy and require explicit Apply. Ordinary agent sessions can run tools and change files without Preview and Apply. Pi and installed extensions own tool and shell permissions; without a permission policy, actions can run with no confirmation.

[Install](#install) · [Get started](#get-started) · [Workflows](#focused-workflows) · [Settings](#settings) · [Security](#security-and-limits) · [Documentation](#documentation)

## See the workflow

### Attach context and ask

![Pi sidebar with a sample file attachment and a question ready to send](resources/screenshots/attach-and-ask.png)

Choose **Attach**, inspect the captured context, and enter your question. The model control selects the model and thinking level.

### Review a focused edit

![Pi sidebar with a sample edit proposal, Preview available, and Apply disabled until preview](resources/screenshots/review-proposal.png)

Run **Pi: Modify Selection (Preview)** for a focused change. Choose **Choose Hunks** if needed, then **Preview** to open the native diff editor. **Apply** becomes available after preview; changing the hunk selection requires another preview.

These screenshots use the current sidebar renderer with offline sample data. They do not show a live provider response or the native diff editor.

## Requirements

1. VS Code **1.140 or newer**.
2. A configured [Pi](https://pi.dev) provider for model requests.
3. A trusted, file-backed workspace for process-launching and mutation workflows.

The extension bundles **Pi 1.3.0** and uses it by default without a separate Pi or Node.js installation.
An unset, empty, or whitespace-only `pi.executablePath` selects bundled Pi.
Any nonempty value selects external Pi, including an explicitly saved `pi` command; existing overrides are not rewritten.
Reset removes only the selected scope's override, so another effective override can still select external Pi.
After an upgrade, a missing remembered session file offers **Start New Session** before Pi starts.
Cancel keeps the restore reference; confirmation starts fresh without changing existing session files.
Unsaved session paths are no longer kept for restore after reload.

Pi runs as a subprocess on the workspace Extension Host, including in Remote SSH, WSL, and container windows.
Bundled Pi reuses that host's existing Pi configuration, credentials, resources, provider environment, and sessions without migration or separate user stores.
Configure providers on that host.
Extension releases own bundled runtime updates; ordinary terminals and external Pi installations remain unchanged.
Missing or invalid bundled assets fail without PATH fallback or automatic operation replay.
See [Runtime selection and recovery](docs/USER_GUIDE.md#runtime-selection-and-recovery) and [validation coverage](docs/BUNDLED_RUNTIME_VALIDATION.md) for compatibility limits and unverified targets.

| Capability | Pi compatibility |
| --- | --- |
| Sidebar chat and focused edit requests | Use Pi's public RPC interface with bundled **1.3.0** by default; no broader external version range is verified. |
| **Pi: Sign In to Provider** / **Pi: Sign Out of Provider** | The isolated helper accepts **1.3.0 only**. Other versions must use Pi's own authentication flow. |
| JSONL session export, import, and GitHub sharing | The isolated helper requires **1.3.0**. JSONL export covers the active branch, not the complete tree. |
| Direct shell (`!` / `!!`) | Requires **1.3.0** compatibility verified through read-only sentinel version metadata. Other versions leave this feature unavailable. |
| Resource reload and session-tree controls | Require verified packaged-command ownership metadata, checked against **1.3.0**. Unsupported routes fail without sending a model prompt. |

External Pi on Windows supports native executables and standard npm Node shims, not custom batch wrappers.
See [Windows process launches](docs/USER_GUIDE.md#windows-process-launches) for lookup and cleanup limits.

## Install

The extension ID is `narumi.narumi-pi`. If the old `narumi.pi-coding-agent-vscode` extension is installed, complete the [upgrade steps](#upgrade-from-the-old-extension-id) first.

1. Open [Pi on Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=narumi.narumi-pi) and choose **Install**, or find `narumi.narumi-pi` in VS Code's Extensions view.
2. Run **Developer: Reload Window** after installation or an update.

If the VS Code `code` command is available, you can install from a terminal instead:

```sh
code --install-extension narumi.narumi-pi
```

Marketplace installation does not require `curl` or a POSIX shell. For manual VSIX installation or the optional release script, see [installation alternatives](docs/USER_GUIDE.md#installation-alternatives).

## Get started

1. Open your project and run **Pi: Open Sessions** from the Command Palette. Choose a saved session, or send from the Sessions composer to start one.
2. Choose **Attach** to add a selection, file, diagnostics, or image. Inspect or redact snapshots through **Attach → View attachments**. Choose your model and thinking level from the composer model control.
3. Enter a request and send it. For a review-first change, select code and run **Pi: Modify Selection (Preview)**. Review the proposal with **Preview**, then choose **Apply**.

When new messages arrive, the panel preserves text selection in messages that remain in the current window. Tool input/output **Copy** buttons use the VS Code clipboard. Pasting text with an image keeps both. After Enter, the draft stays until Pi accepts it; **Sending this message** shows this pending state. Rejected submissions keep the text, and acceptance does not clear a newer draft or move focus from the transcript.

Use **Pi: Switch Session** to search saved sessions in the current workspace, or **Pi: Previous Session** / **Pi: Next Session** to cycle through them.
Default shortcuts use **Ctrl+K**, then **Ctrl+Alt+Shift+S / Left / Right**; on macOS use **Cmd+K**, then **Cmd+Alt+Shift+S / Left / Right**.
Cycling keeps its order while sessions are updated; switching requires idle Pi without pending queues or dialogs.
See [session switching](docs/USER_GUIDE.md#switch-sessions) for discovery limits and recovery behavior.

Use `@pi` in VS Code's native Chat view if you prefer that interface. Native Chat history is separate from sidebar sessions. **More…** provides session management, terminal handoff, repair tools, checkpoints, and background agents. See the [user guide](docs/USER_GUIDE.md#get-started) for controls and shortcuts.

## Focused workflows

| Task | Entry point |
| --- | --- |
| Review Git changes | **Pi: Review Changes**; choose staged, unstaged, working-tree, or branch scope. Open captured findings with **Pi: Show Review Findings**. |
| Review staged changes | **Pi: Review Staged Changes**, then **Pi: Show Staged Findings**. |
| Repair diagnostics | **Pi: Fix Workspace Diagnostics (Preview)**. |
| Repair a failed test | **Pi: Repair Failed Test (Preview)**; approve a command or inspect an existing log. |
| Ask about paused debug values | **Pi: Ask Debug Context**; supports paused Node.js debug sessions. |
| Import isolated-agent results | **More… → Review Results → Apply Selected** on an inactive worktree agent. |
| Inspect or restore request checkpoints | **More… → Request Checkpoints**; memory-only file recovery, not a Git rewind. |

See [workflow instructions and limits](docs/USER_GUIDE.md#focused-workflows) and the [feature matrix](docs/FEATURE_MATRIX.md). Responses support Markdown, highlighted code, math, and supported Mermaid diagrams with bundled rendering assets. Tool calls appear in conversation order between responses, each collapsed by default. Expand a call to inspect its input, output, and status. History navigation keeps responses accessible when tool calls reach a window limit.

The foreground sidebar agent can add [temporary passage annotations](docs/USER_GUIDE.md#temporary-passage-annotations): whole-line highlights, literal hovers and read-only native comments below the marked code or text. Comments start collapsed by default. Set `pi.annotations.initialState` to `expanded` in **VS Code Settings → Pi → Editor → Annotation initial state** to expand newly created or replaced annotations; existing threads and user state on redraw are unchanged. VS Code may open the Comments panel and change editor layout or scroll position; source files remain unchanged. Use **Pi: Clear Annotations** to remove them.

## Settings

Run **Pi: Open Settings** (`pi.openSettings`) or use the gear in the Pi view title to open native VS Code Settings filtered to `@ext:narumi.narumi-pi`.
**General**, **Permissions**, and **Editor** group the existing 11 `pi.*` settings without changing their IDs, defaults, bounds, scopes, or runtime behavior.
Use native scope selection, validation, save-on-edit, search, configured-value indicators, and Reset menus.

Run **Pi: Open Pi Configuration** (`pi.openPiConfiguration`), also in the Pi view's secondary title actions, to open the separate **Pi Configuration** panel.
Repeated invocation reveals the same panel.
It has only **Global Pi / Project Pi** file scopes, with no User/Workspace selector, and one **Open VS Code Settings** action.
Its controls edit startup provider, model, thinking level, ordered model patterns, steering mode, follow-up mode, automatic compaction, and automatic retry.
Each row shows override, inherited/default value, and source; saved overrides and unsaved drafts have separate indicators.
**Save** appears only for a draft, pending operation, or unresolved save error; it is disabled while pending or stale and hides after success.
Checkboxes and selects remain drafts until explicitly saved.
A compact row actions menu contains **Reset override** and **Reload row**; stale drafts also show an inline **Reload row** recovery action.
**Reload configuration** reads saved values, preserves unrelated drafts, and does not reload Pi resources.
There is no Save All or Reset All.
Configured MCP servers expose safe metadata and inline enabled/exposure edits and resets, not transport or credentials; connection state remains **unknown**.
Server creation, transport editing, authentication, diagnostics, and advanced editing remain in existing native management interfaces.
**Pi: Open Native Pi Settings** (`pi.openNativeSettings`) and **Pi: Manage Native MCP Configuration** (`pi.openNativeMcp`) keep their existing dialog behavior.

Global Pi uses the Extension Host's `~/.pi/agent` or `PI_CODING_AGENT_DIR`.
Project Pi uses the launch workspace's `.pi` (the first workspace folder, not a multi-root selector).
Native controls require a trusted, file-backed workspace; unapproved project values are labelled **inactive**, not active runtime settings.
Opening, reading, or switching never creates files.
The first explicit override save creates only the needed file and missing Pi directories; resetting an absent override creates nothing.
Saving does not apply runtime settings, restart Pi, approve project resources, or connect MCP servers.
Provider, model, thinking level, and executable overrides apply at process startup.
Reconnect does not restart Pi.
The webview receives validated common-setting values, safe MCP metadata, and opaque revision tokens, not raw native files or MCP transport/authentication fields.
Full snapshots stay in Extension Host memory; native draft persistence contains only bounded validated common-setting drafts.

1. `pi.executablePath` defaults to empty, which selects bundled Pi **1.3.0**.
   Set a nonempty command or path to use compatible external Pi on the workspace Extension Host.
   Opening Settings does not start or validate either runtime.
2. `pi.approveProjectResources` defaults to `false`.
   Enable it only for trusted project-local Pi resources.
3. `pi.inlineCompletions.enabled` defaults to `false`.
   Manual inline completion remains available.

See the [settings reference](docs/USER_GUIDE.md#settings) and [native Pi settings and MCP controls](docs/USER_GUIDE.md#native-pi-settings-and-mcp).

## Security and limits

Ordinary agent sessions are not a sandbox. Pi and installed extensions own tool and shell permissions; pi-vscode adds no built-in tool or shell confirmation policy. Without a permission policy, tools and commands can run with no confirmation. Pi-requested dialogs continue to be displayed unchanged.

Focused edit generation uses a read-only policy. Applying proposals, importing worktree results, rerunning tests, and restoring checkpoints require explicit user action. Preview checks do not protect unrelated ordinary-agent tool calls.

The selected provider receives prompts and approved context under its own data policy. Inspect attachments before sending; sensitive-filename warnings are best-effort. Stop or process exit does not prove that every detached descendant stopped. Inspect remaining work before repeating an uncertain command.

Short operation results and recovery instructions stay in the Sidebar. Choose **Show Output** on a diagnostic notice to open **Output → Pi** without taking editor focus. The shared log uses VS Code log levels and records safe technical categories, not conversation content or credentials. Use VS Code's built-in log-level controls for Debug/Trace command timing. VS Code log files can outlive the window; review them before sharing.

Read [Security and Privacy](docs/SECURITY.md) for trust and logging boundaries, and [operational limits](docs/USER_GUIDE.md#security-and-limits) for attachment, review, repair, and history bounds.

## Upgrade from the old extension ID

Do not keep both extension IDs installed. Stop old work and preserve sessions and worktree results before removing the old extension. Follow the [complete migration instructions](docs/USER_GUIDE.md#upgrade-from-the-old-extension-id), including settings and bridge identifier changes. Persistent Pi session files remain separate from VS Code extension state.

## Documentation

1. [User guide](docs/USER_GUIDE.md): conversation controls, session transfer, authentication, rendering, and operational limits.
2. [Extension bridge](docs/USER_GUIDE.md#extension-bridge): editor tools in sidebar sessions and terminal handoffs.
3. [Pi terminology](docs/PI_TERMINOLOGY.md): Pi core and extension naming boundaries.
4. [Development and release](docs/DEVELOPMENT.md): source builds, tests, validation limits, and publishing.
5. [Issues](https://github.com/narumiruna/pi-vscode/issues): report defects and request changes.

## Development

See [Development and release](docs/DEVELOPMENT.md) for build, test, screenshot-capture, and release commands. No installation or publication is required to run the offline tests.

## License

[MIT](LICENSE)
