# Native Pi configuration contract

The reference implementation is Pi 1.3.0.
This is not a new minimum Pi version.
The extension does not import Pi in the Extension Host.
Unsupported RPC commands fail instead of falling through to a model prompt.
Native file controls implement the documented strict JSON format, not an independent Pi settings database.

## Targets and effects

| Control | Read source | Write target | Active effect |
| --- | --- | --- | --- |
| Pi: Extension Settings / Pi view title ⋯ → Extension Settings | Native VS Code Settings filtered to `@ext:narumi.narumi-pi`; General, Permissions, Editor group the existing 11 keys | Native configuration target allowed by each setting's declared scope | Native save-on-edit and validation; existing launch/editor behavior; no Pi process |
| Pi: Pi Configuration / Pi view title ⋯ → Pi Configuration | Validated common settings and safe MCP metadata at its Global Pi/Project Pi selector | Selected allowlisted `settings.json` or `mcp.json` member through shared guarded writes | Explicit row save/reset only; no live apply, new configuration keys or duplicate schema |
| Native startup provider/model/thinking | Global Pi/Project Pi `settings.json` | Selected Global Pi/Project Pi member | Next controlled restart; launch overrides and resumed session state can take precedence |
| Ordered `enabledModels` | Global Pi/Project Pi `settings.json` | Selected file member | Startup/cycling preferences, not model access control; no supported live setter |
| Queue grouping files | Global Pi/Project Pi `settings.json` | Selected file member | Later restart; runtime controls are separate |
| Compaction/retry files | Nested `enabled` member | Selected file member | Later restart; sibling tuning members remain unchanged |
| Native runtime controls (requires an already running Pi; opening never cold-starts it) | `get_state` for queue modes/compaction; retry read unavailable | Public `set_steering_mode`, `set_follow_up_mode`, `set_auto_compaction`, `set_auto_retry` | Idle foreground runtime plus a Global Pi persistence request; not session-only |
| MCP configuration | Global Pi/Project Pi `mcp.json` | Selected server/metadata member | Save alone does not connect; explicit resource reload is separate |
| MCP CLI diagnostic | Explicit `pi mcp list --json` | No extension-owned persistent result | Separate temporary connections; not evidence of current-session connections |

Pi queues Global Pi settings persistence separately.
An RPC setter acknowledgment does not prove that the disk write succeeded.
Pi 1.3.0 has no public flush/error-drain RPC and no authoritative retry-enabled state read.
The UI reports the acknowledgment and unverified persistence, not a verified durable save.
It does not reorder or clear queued messages.

## Resolution and approval

The Global Pi agent directory is `PI_CODING_AGENT_DIR` from the Extension Host environment, or the host home directory's `.pi/agent`.
A leading `~/` expands to that home directory; a relative override resolves against Pi's launch directory.
In remote windows these are remote host paths, not browser/client paths.

Project Pi files live in the current launch workspace's `.pi`, using the existing first workspace folder behavior.
There is no multi-root folder selector.
Pi loads project resources only under the existing project-resource approval policy.
Passive inspection marks unapproved saved Project overrides inactive, not inherited Global values.
The Project Pi form has one warning above the sections and a **Review project approval setting** button.
That button only opens native Settings filtered to `pi.approveProjectResources`; it changes no approval, trust, or runtime state.
The form and native dialogs include inactive project settings and MCP entries even when approval is off; editing does not activate them.
Saving does not change VS Code trust, native Pi trust, project-resource approval, runtime settings, packages or installed extensions.

Common settings use project-over-global inheritance; nested objects merge.
Resource lists have different combination semantics and are not edited by common controls.
`enabledModels` retains order and Pi pattern syntax (exact/fuzzy/provider/glob/thinking suffix).
No model catalog is fetched, no zero-match result is invented, and no match is represented as an access restriction.

MCP project transport entries replace global entries.
A project entry without `command`, `url` or `type` overrides only `enabled`, `exposure` and `toolExposure` and inherits the global transport/credentials.
Removing a project override leaves the global server and auth intact.
Server names differing only in `-` and `_` cannot be added in the same file.

## Editing boundaries

The Pi view title's native **⋯** overflow menu lists **Extension Settings** then **Pi Configuration**, directly in the same configuration group.
There is no standalone settings gear or settings submenu.
Composer **More…** retains session and work actions without duplicate entries for these commands.
**Pi: Extension Settings** (`pi.openSettings`) opens real native Settings, not a custom `pi.*` form.
VS Code owns validation, configuration scopes, incomplete-input behavior, array controls, and save-on-edit.
The former custom page's 4,096-character string, 100-item list, and 16 KiB serialized-list edit limits do not apply to native Settings.
Runtime trust and project-resource guards remain independent of native Settings editability.

**Pi: Pi Configuration** (`pi.openPiConfiguration`) opens one dedicated panel; repeated invocation reveals it.
It is also available directly in the Pi view title's native overflow menu.
The panel's **Save to** selector has **Global Pi / Project Pi** scopes, with no General/Permissions/Editor form or User/Workspace selector.
Project Pi shows **First workspace folder · .pi**.
One **Open Extension Settings** action opens extension settings.
The **Model**, **Behavior**, and **MCP** sections use level-two headings.
Model contains provider, model, thinking level, and ordered patterns; Behavior contains steering, follow-up, compaction, and retry.
The secondary **Advanced** menu contains **Open Pi settings dialog…** and **Manage MCP servers…**, not direct JSON editor actions.
**Pi: Open Native Pi Settings** (`pi.openNativeSettings`) and **Pi: Manage Native MCP Configuration** (`pi.openNativeMcp`) retain their command IDs and existing native dialog behavior.
The Pi Configuration form uses the eight existing `nativeSettingControls` descriptors and their validation:

| Setting | Control |
| --- | --- |
| `defaultProvider` | Manual Provider ID text input for startup |
| `defaultModel` | Manual Model ID text input for startup |
| `defaultThinkingLevel` | Startup thinking level select with existing supported values |
| `enabledModels` | Ordered multiline patterns, one pattern per line |
| `steeringMode` | Select: `one-at-a-time`, `all` |
| `followUpMode` | Select: `one-at-a-time`, `all` |
| `compaction.enabled` | Automatic compaction checkbox |
| `retry.enabled` | Automatic retry checkbox |

Provider and model inputs are explicitly manual; no cached choices, catalog fetch, model-discovery RPC, helper, or credential read is added.
See the manual-entry decision in [Current-change implementation evidence](#current-change-implementation-evidence).
An inherited row shows a read-only value and one source label in `.meta`: **Inherited from Global** or **Pi default**.
**Set global override** or **Set project override** opens a local draft initialized from the displayed value without writing a file or creating directories.
A saved override remains editable with **Global override** or **Project override** metadata, separate from the unsaved-draft indicator.
Only an unapproved saved Project override has inactive source metadata; inherited Global values are not flagged inactive.
**Save** stays visible in editable rows and is disabled without a draft, while pending, or when stale.
After a successful override save it stays visible but disabled until another edit.
Select, checkbox, and MCP metadata changes only create drafts; editing alone sends no save or reset.
A value equal to an inherited value can still represent an explicit selected-scope override.
**Discard changes** clears only the local draft, without a file operation or removal of a saved override.

The row actions menu contains **Remove global override** or **Remove project override**, and **Reload row**.
Removal resets only the saved selected-scope member and preserves inherited values; it does not write a copy of the inherited value.
It is disabled without a selected-scope override, or while pending or stale.
Reload discards the row's draft and reads current values when no operation blocks it.
Opening or closing the menu never discards drafts; keyboard access and Escape are supported.
Drafts are separate by scope and key and remain on failed saves and scope changes.
Conflicting drafts show an inline **Reload row** recovery action and require explicit reload before another save.
Secondary **Reload saved values** reads saved values and preserves unrelated drafts; it does not reload Pi resources.
There is no Save All or Reset All.
One shared save/restart explanation replaces repeated row text; expandable help retains file locations and detailed precedence.
Configured and draft values are never labelled as verified active-session values.

The configured MCP list exposes validated name, transport type, source, enabled state, and exposure metadata, with connection state **unknown**.
Enabled and server exposure edits and resets use the selected native scope and explicit save/reset actions.
Project metadata overrides preserve inherited transport and credentials.
Server creation, transport editing, credentials, authentication, diagnostics, and advanced editing remain in existing explicit native interfaces.
Command Palette native management remains available.
Native controls require a trusted, file-backed workspace, including for Global Pi.

The browser receives only validated allowlisted common-setting values, safe MCP metadata, opaque revision tokens, and a host-owned restart action token.
Invalid existing common-setting values produce fixed diagnostics without the raw value.
Raw native file text, unlisted settings, URLs, commands, arguments, environment/header values, OAuth objects, credentials, and raw errors remain host-only.
Full native snapshots are kept only in Extension Host memory.
Native draft persistence is limited to bounded validated common-setting drafts, not complete snapshots or MCP data.
Webview state also keeps one bounded restart request ID and fixed outcome status, never action authority.
The panel retains its latest bounded restart result in host memory and repeats the result on webview readiness; recovery never dispatches a restart.
Panel disposal clears this retained result and suppresses late posts; an already accepted restart can still finish.
Native projections load only when the Pi Configuration panel opens or is explicitly refreshed, not when native VS Code Settings opens.
The Pi Configuration webview has no VS Code configuration save/reset protocol.
The browser cannot select filesystem paths, JSON member paths, command identifiers, or complete native objects.
The host resolves targets and member paths from its allowlists.
No `auth.json` or `mcp-auth.json` is read by management code.

Opening, reading, refreshing, switching Pi file scopes, entering edit mode, or discarding drafts never creates files or directories.
Only the first explicit override save creates the required `settings.json` or `mcp.json` and missing Pi directories under the validated ancestor.
Reset of an absent override creates nothing; saving one file does not create the other.

Each file is limited to 128 KiB, UTF-8, a strict JSON object, maximum depth 32.
Known controls have type/enum bounds; model patterns allow 100 entries of 256 characters.
Duplicate object keys and unsafe keys are rejected in edited object paths.
Unknown keys remain unchanged.
Existing member replacements/resets preserve unrelated member bytes and ordering.
Insertions use the existing newline/indent convention where detected.
JSONC comments and invalid syntax are not rewritten.

The form and native dialogs reuse the same guarded file operations and member-level patches.
Edits bind to the captured workspace, agent directory, native scope, approval/environment state, and relevant file revisions, including inheritance sources.
Common edits reject known unsafe or stale writes.
They do not provide filesystem-wide atomicity against external processes or other VS Code windows.

- Regular single-link files and canonical directories are required.
  Workspace-root aliases resolve to the canonical root; nested links and agent-directory links are rejected.
- Reads bind descriptors to named paths and ancestor identities.
- Writes recheck content hashes, file identity, byte limits, dirty buffers, writable mode, origin, trust and launch policy.
- Shared editor guards capture up to 1,000 file-backed editor URI, version and dirty-state snapshots for native operations.
  - Canonical identities are resolved and rechecked before writing, including supported workspace aliases and later-opened buffers.
  - Retargeted aliases, unverifiable editor paths and changed or dirty matching documents fail closed.
  - No hidden canonical editor bypasses an aliased dirty buffer.
- The runtime workspace gate and canonical configuration-file gate serialize extension-owned operations.
- Known external edits require **Reload row** in the form or reopening native dialogs; no old file is restored over newer content.
- Workspace, approval, or agent-directory changes invalidate retained snapshots.
  Replaced loads, stale origins and disposed panels cannot accept late results.
- An I/O error can leave a partial write or newly created file.
  Inspect the file before retrying.

The explicit advanced native editor opens an existing `settings.json` or `mcp.json` through VS Code after warning.
It is not a credential form or a schema-validation service.
Normal editor Save is independent of the bounded common controls and has VS Code's ordinary backup and save behavior.
Create a common override first if the file does not exist.

## MCP execution and authentication

Opening the form or native dialogs starts zero Pi processes and connections.
A saved stdio executable, resource, package, header command or environment command is not executed by saving.

The explicit connection diagnostic requires modal approval for ALL enabled file-configured servers, credential commands and network access.
It uses an argument array with no credentials, a 30-second deadline, cancellation, a combined 128 KiB stdout/stderr bound and bounded process cleanup.
Raw transport/error/stderr text is not retained or displayed.
Diagnostic metadata is memory-only and bound to the captured canonical workspace, agent directory, approval and file revisions.
A file change during the check rejects its result; a later workspace/configuration change marks the retained result stale.
It remains distinct from configured state; active-session connection state is unknown.
POSIX group cleanup cannot establish that escaped descendants or remote effects stopped; Windows descendant cleanup is not guaranteed.

Pi 1.3.0's MCP CLI consults saved native Pi project trust, not the VS Code project-resource switch.
The extension does not write native trust.
It blocks diagnostics if a project MCP file exists while project-resource approval is off.
With approval on, the CLI can still skip a project not trusted in native Pi; the diagnostic is not proof that every configured project entry was checked.
CLI operations do not load replacement extensions.

Before offering terminal management, the active command catalog must contain exactly one extension command `mcp` with `sourceInfo.path` equal to `builtin:mcp`.
Missing, duplicate or third-party ownership is not verified native support.
The action uses the controlled Pi terminal handoff; no `/mcp` text is injected.
The user performs sign-in, sign-out and reconnect in Pi.
Pi owns URLs, remote redirects, token storage and cancellation.
Signing out deletes Pi's stored auth, not provider-side revocation.
Returning from the terminal does not prove authentication succeeded.

No dedicated public MCP management/current-connection-state RPC exists in Pi 1.3.0.
Arbitrary `/mcp` text output is not parsed into verified native state.
Full in-panel OAuth and authoritative live connection/tool/resource inventory are not implemented without public upstream contracts.
The offline Pi reference fixture verifies direct/deferred/codemode/hidden and per-tool exposure, resource list/read, disabled/replacement ownership, connection errors and focused read-only denial against local stdio fixtures.
The extension does not add an MCP client.
Direct/deferred/codemode/hidden and per-tool exposure remain Pi semantics; common controls set server exposure while advanced per-tool configuration remains native Pi configuration.
Server annotations are unverified hints.
Pi and installed extensions own tool permissions, including MCP permissions; pi-vscode adds no tool-confirmation policy.
Focused read-only enforcement remains unchanged.

## Apply and recovery

**Apply Saved Native Configuration (Reload Resources)** is a separate explicit idle foreground action.
It rechecks trust, canonical workspace, active generation and launch policy through the shared runtime control gate.
Saved resources and MCP servers can execute/connect when applied.
Save does not invoke Apply.
Background agents are unchanged.
A failed reload retains saved files and reports saved-versus-active uncertainty; retry is deliberate.
Startup defaults/scoped models are not claimed live-applied.
The separate **Restart Pi…** button (`native-restart-pi`) routes to **Pi: Restart Pi (Current Launch Policy)** (`pi.restartResources`) to restart the same session and load startup preferences.
Resumed-session values and VS Code launch overrides can still take precedence.
Restart approval and cleanup inspection belong to the existing shared runtime lifecycle; saving or removing an override never calls it.
Cancellation or failure retains saved files and drafts, without rollback or automatic retry.
Failure reports runtime uncertainty rather than successful application.
No private scoped-model mutation or second session writer is added.

The approval route accepts exactly `{ type: "openProjectApproval" }` and opens the host-owned native Settings filter `pi.approveProjectResources`.
The restart route accepts exactly `{ type: "restartPi", id, actionToken }`, using the snapshot's opaque `restartActionToken`.
The token is short-lived host action authority bound to the panel's runtime, workspace, and policy origin, not a browser-selected command.
The host rejects invalid, unavailable, stale, or disposed actions and consumes accepted restart authority before dispatch.
The fixed `{ type: "restartResult", id, status }` response uses a bounded request ID and only `completed`, `cancelled`, `failed`, or `rejected` status.
Existing restart confirmation, trust, canonical workspace, launch-policy, session, ownership, queue, dialog, and cleanup checks remain required.
The sidebar restart command returns an internal Boolean result for this route without changing its existing user behavior.

## Current-change implementation evidence

The configuration usability change keeps native setting descriptors and the guarded member-level writer unchanged.
`src/settingsHtml.ts` owns the shared save/restart explanation, separate restart button, and expandable file help.
`src/webview/nativeSettings.mts` owns Save to, grouped sections, inherited/override/draft states, local discard, saved-override removal, and secondary actions.
`src/settingsPanel.ts`, `src/settingsModel.ts`, and `src/webview/settings.mts` own the fixed approval/restart messages, opaque action authority, and bounded results.
`src/sidebar.ts` returns the existing restart outcome internally; `src/piRuntimeControl.ts` retains the confirmed lifecycle path.

The approved fallback is manual **Provider ID** and **Model ID** entry.
Source verification found that `PiRuntime.refreshState()` assigns `availableModels` without an independent catalog workspace/origin token.
`stopClient()` and disconnect retain the `availableModels` cache, and `currentCwd` reads current invocation settings rather than a captured catalog origin.
A safe owned cached picker would require a new runtime ownership contract, which is outside this change.
No cached catalog projection, catalog fetch, helper, credential read, model-discovery call, or second model registry is added.
Ordered model patterns keep their existing Pi semantics.
Independent diff review found lost restart feedback on webview recreation and an incorrect fallback-value diagnostic.
The fixes add bounded feedback recovery/result replay and distinguish invalid saved/inherited values from the value displayed in a draft.
Regression tests cover both findings, Advanced popup bounds, and invalid launch settings that must disable restart without blocking Settings navigation.
This source evidence explains the implementation choices; test-run evidence follows below.

## Validation and support limits

### Current validation

All checks below were rerun after merging `origin/main` (`37758e4`) and resolving the configuration usability and overflow-menu conflicts.
The merge preserves the direct adjacent menu entries, the Open Extension Settings cross-link, and the revised inherited/override/draft controls.
Validation ran on Linux x64 with local fixtures and no live provider or external MCP server.
`npm ci` installed the locked dependencies without dependency or version changes.
The final checks passed after the restart-recovery, invalid-inheritance diagnostic, and Advanced menu fixes.
A browser fixture rerun exposed a race between synthetic recovery injection and current-document persistence.
The mock now holds injected host recovery for the next document; three consecutive pre-merge `npm run test:settings` runs passed, followed by a successful merged-source run.
The failed attempt is retained in `/tmp/pi-configuration-usability/browser-settings-state-injection-race.log`; repeat logs are `browser-settings-repeat-{1,2,3}.log` in the same directory.

| Check | Result |
| --- | --- |
| `npm test` | 102 test files passed; 1,596 tests passed and three skipped. Includes host action/token guards, malformed launch-setting recovery, result replay, same-value override/reset regressions, and the upstream overflow-menu contract. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed with warnings and informational diagnostics; no errors. |
| `npm run test:settings` | Passed all eight controls and MCP fields at both scopes, inherited/override/draft states, explicit saves/removal, local discard, failures, conflicts, bounded recovery, restart result recovery/replay, DOM status semantics, focus, CSP, and no discovery. |
| Settings layout matrix | 36 row-menu states and 18 Advanced menu layouts passed across light, dark, and high-contrast themes at widths 280, 360, 400, 650, 1100, and 1150. Tests check popup bounds and visible keyboard focus. |
| `npm run test:rich-content` | Passed rich-content, interface, and lifecycle browser fixtures. |
| `xvfb-run -a npm run test:native -- 1.140.0` | Passed isolated trusted Extension Host checks, including native configuration lifecycle/scopes and fixture-only process workflows. |
| `xvfb-run -a npm run test:native -- 1.140.0 untrusted` | Passed Restricted Mode guards before Pi process launch. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 settings` | Passed native Settings and Pi Configuration UI checks on VS Code 1.140.0. |
| `xvfb-run -a npm run test:native-ui -- stable settings` | Passed the same checks on stable VS Code 1.143.0. |

The native UI fixtures exercised all 11 native `pi.*` controls, native arrays, User/Workspace save-on-edit and scoped Reset, and the separate configuration singleton in three native themes.
They also exercised all eight Pi file fields at both scopes, inherited-to-draft editing, local discard, stable Save, scoped removal, keyboard focus, and hide/reveal draft recovery.
Passive Settings and Pi Configuration routes started no Pi process or model prompt.
The subsequent title-menu checks established one fixture-only sidebar startup, then verified adjacent ordered destinations, keyboard opening/Escape, the renamed cross-link, and no extra process or model request.
Host and browser fixtures cover restart outcomes and webview recreation; these are not live-provider restart evidence.
DOM status assertions are not a screen-reader test.
No installed-VSIX, Windows/macOS, remote-host, native virtual-workspace, live-provider, or external-MCP verification is claimed for this change.

Local captures and logs are retained under `/tmp/pi-configuration-usability/`, outside Git:

- `before-project-inactive-inherited-1150x859.png` and `after-project-inactive-inherited-1150x859.png`: matching dark fixture views, Project scope, inherited Global values, inactive approval, 1150 × 859.
- `after-project-draft-360x859.png`: unsaved Project override with inherited Global source and explicit Save/Discard.
- `after-saved-override-360x859.png`: saved Project override marked inactive, with stable disabled Save.
- `after-stale-recovery-360x859.png`: retained stale draft with disabled Save and explicit Reload row.
- `native-{1.140.0,1.143.0}-{vscode-dark,vscode-light,vscode-high-contrast}.png`: native workbench captures in three themes on both versions.
- `browser-settings-final.log`, `native-settings-1.140.0-final.log`, and `native-settings-stable-final.log`: pre-merge browser and native UI command evidence.

Merged-source logs are `/tmp/pi-config-merge-npm-test.log`, `/tmp/pi-config-merge-biome.log`, `/tmp/pi-config-merge-settings.log`, `/tmp/pi-config-merge-rich.log`, `/tmp/pi-config-merge-native.log`, `/tmp/pi-config-merge-untrusted.log`, `/tmp/pi-config-merge-ui-1.140.0.log`, and `/tmp/pi-config-merge-ui-stable.log`.
Fresh native overflow captures are `/tmp/pi-settings-overflow-1.140.0.png` and `/tmp/pi-settings-overflow-1.143.0.png`.
These local temporary artifacts are not durable repository assets or proof of subjective user acceptance.
The external handoff below retains unverified targets and usability review after plan completion.

### Historical evidence

The results below cover earlier native configuration work and the separate upstream overflow-menu change.
They do not validate the revised usability controls, host routes, or merged source.
The first group covers earlier native dialogs and the previous inline form, before the native Settings route and compact Pi Configuration layout.
Earlier Linux native validation covers Quick Picks, passive MCP metadata, scoped writes/reset, dirty-buffer rejection, workspace aliases and packaged behavior.
The previous inline form had offline model/host regressions and local Chromium fixtures for explicit saves, scopes, inheritance, secret exclusion, stale drafts, recovery, keyboard focus, themes, and layout.
The earlier macOS arm64 Extension Host fixture exercised all eight controls at both scopes and MCP metadata inheritance through the production form protocol and cold operation owner on VS Code 1.140.0 and 1.143.0.
Those checks used disposable profiles and files without a live provider or external MCP server.
The earlier local VSIX build passed, and archive inspection confirmed the then-new host modules and bundled settings assets.
The initial default package test run failed under macOS temporary-directory aliases and concurrent fixtures; the documented canonical temporary-directory and single-worker workaround passed.
Those checks did not establish native webview interaction, remote-host behavior, or packaged installation behavior for the previous inline form.
The actual Pi 1.3.0 local stdio reference verifies inherited tools/resources and exposure.
See [Integrated validation](NATIVE_PARITY_VALIDATION.md).

In the historical native Settings route and compact-layout change, the macOS arm64 offline suite passed 99 files with 1,466 tests passed and three skipped.
The standalone Settings browser fixture passed native file scope/inheritance, explicit saves, action menus, stale recovery with field focus, migration and recovery bounds, safe projections, CSP, and 24 width/theme combinations.
The rich-content browser suite also passed.
Native Extension Host checks passed on VS Code 1.140.0 and stable 1.143.0, with separate Restricted Mode checks that rejected untrusted execution.
Focused native UI checks passed on both versions for all 11 native settings, array edits, categories, User/Workspace save-on-edit and scoped Reset, and the dedicated Pi Configuration panel's singleton, three native themes, draft-only edits, keyboard actions, hide/reveal, explicit Save/focus, and Reset.
The final local package and extracted bundled-runtime smoke check passed using a single test worker; an earlier default-concurrency package attempt failed on an existing one-second RPC fixture timeout.
No dependency versions were changed; npm audit reports three existing development-only transitive advisories.
Virtual-workspace rejection is covered by unit tests, not a native virtual-window check.
Full Linux UI and annotation suites, Windows native behavior, actual remote-user scopes, Remote SSH/WSL/container, screen readers, live providers, and external MCP servers were not checked in that historical run.

For the historical upstream overflow-menu change, the Linux x64 offline suite passed 1,494 tests with three skipped across 99 files.
Settings browser and rich-content checks passed.
Focused native Settings UI checks passed on VS Code 1.140.0 and 1.143.0 for direct adjacent menu entries, keyboard opening/Escape, no standalone settings gear, both destinations, and the renamed cross-link.
The command declarations use gear icons, but these native overflow menus render text labels without icons.
Passive settings routes started no Pi process; opening Sessions established one fixture-only startup baseline, and menu actions added no process or model request.
Temporary menu captures are `/tmp/pi-settings-overflow-1.140.0.png` and `/tmp/pi-settings-overflow-1.143.0.png`.
Maintainer visual/usability review remains separate from automated checks.
Remote targets, native virtual workspaces, Windows/macOS, real screen readers, live providers, and installed-package UI were not checked for that overflow-menu change.
Source-development native UI results are not installed-package UI evidence.

1. Structured authoritative live MCP state, retry-enabled reads, general native settings/live scoped-model apply and durable setter results need public upstream contracts before equivalent in-panel claims.
2. Interactive MCP authentication remains in Pi.
   Terminal ownership/recovery is tested; real sign-in, redirects and provider-side cancellation are not.
3. Remote hosts, Windows/Linux native behavior, live providers and external MCP servers were not tested for the inline form.
   macOS native protocol checks are not native UI or remote-host evidence.
   Local stdio fixtures are not external-server evidence.

## External handoff

1. User usability review — product owner or requesting user.
   - Prerequisite: a tested implementation and before/after fixture captures recorded above.
   - Review whether value ownership, Save, discard, saved-override removal, and restart are understandable without detailed file help.
   - Record concrete task feedback; automated assertions do not establish subjective ease of use.
   - User acceptance is unverified; this handoff does not add a mandatory release-approval gate.
2. Additional host and assistive-technology coverage — maintainer with Windows/macOS, remote-host, and screen-reader environments.
   - Prerequisite: passing local fixture suites and a recorded current-change test matrix.
   - Check remote file-scope wording and actions, platform keyboard behavior, and screen-reader announcements without live provider requests.
   - Record evidence for each tested operating system, remote target, and assistive technology separately.
   - Windows/macOS, Remote SSH/WSL/container, and screen-reader behavior remain unverified for this change until those checks are recorded.
   - Local Linux/browser/native results do not establish cross-platform, remote, screen-reader, or installed-package behavior.
3. Live providers and external MCP servers remain outside fixture validation.
   - Obtain explicit approval before a live-provider check and record its scope separately.
   - Do not present configured or fixture state as provider connectivity, credential validity, or current-session MCP connection evidence.
