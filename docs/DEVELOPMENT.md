# Development and release

Run commands from the repository root.
See the [user guide](USER_GUIDE.md) for installation alternatives and the [overview](../README.md) for normal Marketplace installation.

## Install from source

Building from source requires Node.js 22.19 or newer, npm, and a POSIX shell available as `sh`.
On Windows, install Git for Windows and add its `sh` command to `PATH`.

```bash
npm ci
npm run install:extension
```

`npm run install:extension` packages and installs the VS Code extension, then removes the exact legacy global bridge filenames created by older releases.
It does not install a Pi extension under `${PI_CODING_AGENT_DIR:-~/.pi/agent}`.
The extension ID is `narumi.narumi-pi`.

Use `npm run install:vsix` to package and install without the legacy global bridge cleanup.
`npm ci` installs the locked project dependencies, including the exact production dependency `@earendil-works/pi-coding-agent@1.5.2`; it does not install the VS Code extension.
Bundled Pi is the default runtime and does not require a global Pi or Node.js command at runtime.
Source development and build commands still require Node.js 22.19 or newer.
The minimum VS Code version is 1.146.0, matching the pinned `@types/vscode` declarations.

Run **Developer: Reload Window** after installation.
Use **More… → Open in Terminal** for an automatically bridged Pi session.
For an ordinary integrated terminal, see [Extension bridge](USER_GUIDE.md#extension-bridge).

## Development

Use Node.js 22.19 or newer and install the locked dependencies:

```bash
npm ci
npm test
npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources
```

### Build and package

| Command | Purpose |
| --- | --- |
| `npm run compile` | Check host and browser TypeScript; build bundled renderer and settings assets. |
| `npm run watch` | Watch host TypeScript only; see [Build order](#build-order). |
| `npm test` | Compile, then run the Vitest suite without a live model. |
| `npm run package` | Run the full test suite, create or overwrite `pi.vsix`, and run the extracted bundled-runtime smoke check. |
| `npm run test:bundled-runtime` | Extract local `pi.vsix` outside the checkout and check its actual runtime offline without PATH Pi/Node lookup. |

#### Build order

Rerun `npm run compile` after renderer or style changes when using `npm run watch`.
Run compile-based commands sequentially.
Their shared generated assets can conflict when multiple builds run at the same time.

The `package.json` override restricts `@vscode/vsce` to patched `minimatch` 11.0.8 or newer within major version 11.
It avoids the vulnerable 10.x dependency without changing the bundled Pi dependency tree.
Remove the override when `@vscode/vsce` requires a patched version directly.

### Listing screenshots

After compilation, capture the README images with the installed Playwright Chromium:

```bash
node scripts/capture-readme.mjs
```

This overwrites the two PNG assets in `resources/screenshots/`.
The script uses the current sidebar HTML, sample conversation and attachment data, simulated VS Code IPC, and blocked network requests.
It checks that Preview is enabled, Apply is disabled before preview, and the Preview button sends the expected action.
It does not start Pi, request a model, open a native diff, or apply an edit.
The screenshots show the sidebar renderer, not the complete VS Code workbench.
Review both images after changing the renderer or capture data.

### Browser checks

Install local Playwright Chromium before running browser checks:

```bash
npm exec -- playwright-core install chromium
npm run test:rich-content
npm run test:thinking-picker
npm run test:settings
```

The rich-content check tests the sidebar document, CSP, rendering, themes, overflow, and asynchronous lifecycle.
It also runs deterministic interface fixtures for responsive actions, attachments, queue submissions, session details, status, and scroll preservation.
Extension status/widget fixtures check keyed ordering, removal, text safety, keyboard order, four themes, 224 narrow/short layouts, and host warning/Stop visibility.
Run it after renderer changes.
Run the thinking-picker check after thinking-picker changes.
The settings check tests controls, scopes, reset, external-change conflicts, draft recovery, keyboard navigation, themes, layout, and CSP using the bundled assets.
None of these checks uses a live model.
The rich-content, thinking-picker, settings, native Extension Host, and native UI launchers use `scripts/test-browser-platform.mjs` to detect WSL through `WSL_DISTRO_NAME`, `WSL_INTEROP`, or a case-insensitive `microsoft` kernel match.
They add `--ozone-platform=wayland` on WSL, including automated Chromium launches.
Check WSL before any other Chromium/VS Code launch and pass that argument when applicable.
These launcher changes affect test launches, not bundled Pi runtime assets.

Fixed-status regressions check the permanent composer parent, Sessions parity, reserved idle geometry, message priority, neutral empty input, long text and recovery-button wrapping, unchanged recovery checks, focus, scroll preservation, and no duplicate DOM live announcements.
Unit/browser checks and full Linux native UI suites passed on VS Code 1.106.0 and 1.142.0.
Real screen-reader, remote, and Windows/macOS UI checks were not rerun for this relocation; see [Composer behavior and validation](COMPOSER_UX.md) for evidence and coverage limits.

Composer completion fixtures cover attachment capture, path-only insertion, failed capture, stale replies, IME, keyboard focus, and narrow layouts without a model.

Thinking fixtures check thinking-only and redacted responses, disclosure keyboard access, live focus and scroll preservation, and authoritative history replacement without a provider.

Direct-shell fixtures check explicit composer guards, context labels, inert cards, and terminal-control removal.

### Isolated Pi public-SDK check

After compilation, run `node scripts/test-isolated-sdk.mjs <configured-pi-executable>` to verify the packaged helper against an explicit Pi 1.3.0 or 1.5.2 installation.
The helper accepts only these exact versions, not a range.
This check uses disposable directories and a fixture session.
It verifies static provider discovery, active-branch export, complete-tree import and unchanged source bytes without authentication, model calls, or uploads.
No installed Pi path is embedded in the extension.

### Bundled runtime validation

Pi 1.5.2 public API compatibility is statically verified.
The Linux x64 extracted-runtime smoke passed; see [current evidence](BUNDLED_RUNTIME_VALIDATION.md#pi-152-regression-checks) for the separate platform and validation limits.
Retained Pi 1.3.0 and VS Code 1.140.0 / 1.143.0 results are historical, not evidence for the updated dependencies.
No live-provider or remote compatibility is verified by this update.

The universal VSIX retains the production dependency closure, public package exports, lazy chunks, image/codemode workers, WASM, themes/export assets, and all six native prebuilds for Linux, Windows, and macOS arm64/x64.
The unused GPL Doom example is excluded; verified supplemental notices are packaged under `resources/runtime-licenses`.
Do not infer platform compatibility from a Linux-built tree or asset presence.
Do not prune required runtime assets without testing the extracted archive.

Run the final gates sequentially after `npm ci`:

```bash
npm test
npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources
npm run test:settings
npm run package
npm run test:bundled-runtime
```

On macOS, the retained baseline uses `TMPDIR=/private/tmp npm test -- --maxWorkers=1` to avoid temporary-directory symlink rejection and concurrent-fixture timeouts.
The final command above can rerun smoke verification against the same archive without rebuilding it.
The smoke check uses disposable stores/workspaces, the extracted CLI and public exports, no global Pi/Node lookup, and no provider or model requests.
It checks runtime startup, RPC/policy ownership, helper discovery, session transfer, required assets, harmless shell behavior, updater refusal, and fail-closed missing assets.
No extension installation or publication is part of these commands.

After compilation, use the dedicated real-runtime native runner on an authorized desktop test host:

```bash
node scripts/test-bundled-native.mjs 1.146.0
node scripts/test-bundled-native.mjs stable
node scripts/test-bundled-native.mjs 1.146.0 untrusted
node scripts/test-bundled-native.mjs stable untrusted
```

On headless Linux, prefix each native command with `xvfb-run -a`.
The runner preserves the GUI process's real HOME, uses disposable VS Code profiles and Pi stores, verifies the installed build's in-memory secret-storage bypass before launch, and disables built-in authentication and Copilot extensions.
Do not fabricate GUI HOME on macOS: an earlier probe triggered a login Keychain prompt and was stopped without a reset.
Stop on any Keychain or credential-store prompt; do not accept a reset or repair command.
Native results must identify actual VS Code, Electron, Node.js, OS and architecture versions.
Report these results separately from extracted-archive smoke, browser fixtures, remote hosts, and live-provider checks.

[Bundled runtime validation](BUNDLED_RUNTIME_VALIDATION.md) retains discovery, exact local evidence, pending release gates, and the external handoff.
Unresolved distribution/runtime requirements must be resolved before release, not silently waived.
No model request, login, live MCP service, installation into an existing profile, or publication is authorized by the offline checks.

### Sidebar concurrency validation

The current contract is one Sidebar over retained independent conversation controllers, with one Primary plus eight additional runtimes shared across Sidebar and editor surfaces.
The minimum supported VS Code version is 1.146.0 and bundled Pi is 1.5.2.
Dated quick-switch and editor-panel evidence does not validate concurrent Sidebar selection or the shared pool.

Prepare locked dependencies, local Chromium, and VS Code test artifacts before network-disabled fixture execution.
Use a disposable sandbox with isolated stores/profiles, no host credentials or home mounts, and only the required toolchain.
Record sandbox setup failures separately from test results; a missing prerequisite leaves the gate pending, not waived.
Compile-based commands share generated assets and must run sequentially.
After preparation, run:

```bash
npm run compile
npm test
npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources
npm run test:rich-content
npm run test:thinking-picker
npm run test:settings
xvfb-run -a npm run test:native -- 1.146.0
xvfb-run -a npm run test:native -- 1.146.0 untrusted
xvfb-run -a npm run test:native-ui -- 1.146.0
xvfb-run -a npm run test:native -- stable
xvfb-run -a npm run test:native -- stable untrusted
xvfb-run -a npm run test:native-ui -- stable
```

Resolve and record the actual stable version and native Electron/Node.js/OS/architecture versions.
On a desktop Linux host, omit `xvfb-run -a` only when an available display is intended.
Check the WSL launch argument described under [Browser checks](#browser-checks); local Linux under WSL is not Remote WSL validation.
The focused native `session-switch` selector is available for iteration, not a substitute for final full native UI runs.
No runtime artifact or distribution change is required for this feature; packaging is not part of this validation unless separate asset inspection becomes necessary.
Do not install into an existing profile, authenticate, call a live provider, or publish a package to validate these scenarios.

#### Manual and native scenarios

Use deterministic Pi fixture responses and disposable profiles for the following checks.
Use the verification table below to distinguish automated coverage from the remaining platform and human review.

1. **Two ordinary Sidebar requests.**
   Start A, select an already live B through Sessions, submit in B, and return to A while both run.
   Repeat through View all, native Switch Session, and Previous/Next.
   Verify independent streams, equal-text queued instructions with different attachment snapshots, drafts, model/thinking choices, history windows, and Stop.
   Stop A and verify B continues; selection must not send RPC `switch_session` or abort to A.
2. **Open saved or new work during A.**
   While A runs, open a previously unloaded saved B, then create C from New Session and the Sessions composer.
   Repeat Resume Session and local `/new`/`/resume` without attachments/prepared actions.
   Confirm **Open Session**, verify separate writers and captured composer transfer, then cancel an opening and verify unchanged selection/draft.
   Exercise editor-owned file reveal, shared capacity with editor panels, cancelled Close Session, verified cleanup, and retained writer/slot/root quarantine on uncertain cleanup.
3. **Authoritative Sessions activity.**
   Observe Running through startup/tools/retry/compaction/queue settlement, Waiting for input during source-labelled input/approval, and Completed/Failed/Stopped after their distinct outcomes.
   Select B while A waits and respond to A's dialog; verify the reply and Stop remain A-bound, including equal request IDs in B.
   Keep connection/delivery/cleanup warnings separate from activity and do not infer Completed from saved history.
4. **Unread settled results.**
   Let hidden A settle while B or Sessions is displayed; verify A has an accessible unread marker.
   Select A with earlier history or paused following and verify it stays unread.
   Render its exact result in visible latest-following detail and verify acknowledgement.
   Race a newer result against an older acknowledgement, hide/re-resolve the Sidebar, and test stale/cross-session acknowledgements without clearing the newer result.
5. **Primary-only boundaries and lifecycle.**
   Verify **Primary** remains the service-owner label as selection changes.
   Select an auxiliary entry and exercise ordinary controls; confirm its privileged actions are omitted or rejected and global editor/review/repair/settings/authentication routes still target Primary.
   Check terminal environment/handoff/recovery, restart, annotations, primary restore/cache keys, and public bridge broadcast without focus-based retargeting.
   Verify actual RPC session/resource mutations, direct shell, Apply/import/restore, and background gates remain exclusive while display selection remains available.
   Test canonical aliases/duplicate writers, changed headers/workspaces/trust/policy, checkpoint overlap, keyboard/focus, narrow themes, CSP, and unexpected network requests.
   Reload without auxiliary restart, queue replay, durable status/unread, or additional persistent transcript keys; retain existing consent and aggregate draft-store limits.

#### Current verification

Validation on 2026-11-17 used network-disabled `bwrap` copies, isolated stores/profiles, Node.js 26.8.2, and a private Wayland compositor with a virtual input seat.
See [the feature matrix](FEATURE_MATRIX.md#concurrent-sidebar-sessions) for exact scenario evidence and retained external handoff.
Native fixtures wait for completed file-watcher reloads and current picker transitions, without replaying writes or weakening production guards.
Reload tests explicitly select retained Primary before its controls; Sessions remains an independent launcher.
The full native UI lane runs the new concurrency fixture last so earlier exact prompt/history assertions remain intact.

| Gate | Result |
| --- | --- |
| Compile and full unit suite | Passed: 114 files, 1,940 tests passed, three existing skips. |
| Documented Biome 2.5.13 check | Passed with warnings/information; no errors. |
| Full rich-content, thinking-picker, and settings browser suites | Passed, including single-document concurrency, editor compatibility, and 864 thinking-picker layout cases. |
| Minimum VS Code 1.146.0 trusted/untrusted Extension Host and full UI | Passed with deterministic fixtures. |
| Resolved current stable trusted/untrusted Extension Host and full UI | Passed; independently verified stable 1.146.0, commit `69047191fc427f2f92828279aae1d90d8eeda7ab`; network-disabled launchers used the matching cached artifact. |

macOS/Windows native cleanup and shortcuts, actual Remote SSH/WSL/container targets, real assistive-technology announcements, and live providers need separate evidence.
Do not infer those results from Linux/WSL, DOM, or earlier editor-panel checks.

### Session quick switch validation

This section records historical validation before the Pi 1.5.2 and VS Code 1.146.0 update, not reruns with the new dependencies.
Local validation on 2026-10-22 used Node.js 26.8.2 and a Linux x64 Extension Host under a WSL2 kernel.
These local Linux runs do not verify VS Code Remote WSL.

| Check | Result |
| --- | --- |
| `npm test` | 101 files passed; 1,585 tests passed and 3 skipped. |
| Documented Biome 2.5.13 check | Passed with warnings and informational diagnostics; no errors. |
| `xvfb-run -a npm run test:native -- 1.140.0` and `stable` | Passed; stable resolved to 1.143.0. |
| The same Extension Host commands with `untrusted` | Passed; all three navigation handlers reject Restricted Mode before process launch. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0` and `stable` | Full suites passed, including session search, authoritative history, three-session cycling, editor/composer chords, terminal/Quick Pick exclusion, and changed-workspace rejection. |
| `npm run test:rich-content` | Passed, including clipboard success/failure IPC and lifecycle assertions. |
| `npm run package` | Passed full tests and extracted bundled-runtime smoke; ZIP inspection confirmed all three commands and guarded shifted chords. |

The current native UI runner accepts `session-switch` after the version for focused iteration over retained Sidebar sessions.
Default native UI runs include the current assertions; see [Sidebar concurrency validation](#sidebar-concurrency-validation) for current results and limits.
Generated native default-keybinding JSON confirmed no Linux built-in conflicts for the shifted chords.
Static checks of VS Code 1.140.0 and 1.143.0 bundles found conflicts with the original unshifted Git and macOS editor-group chords; the final chords avoid these known conflicts.

Full-suite validation corrected stale fixture expectations without changing production rendering or native settings behavior.
The dirty-native-settings picker timeout was reproduced from unmodified `origin/main` at `1affb5a`; the fixture now checks rejection before scope selection and verifies retained editor text through an explicit save.
Clipboard assertions now read the actual VS Code host clipboard instead of replacing the unused browser API; deterministic failure coverage remains in unit and browser tests.
Composer navigation consumes prior fixture output before testing blocker-only changes, and message-heading assertions include the existing Tool role.
An initial 1.143.0 run timed out while reopening the existing More picker; two later full runs passed without a code change for that timeout.

Windows/macOS maintainers need a disposable native VS Code profile and the fixture build to verify OS-level shortcut dispatch and platform-specific conflicts.
Expected behavior is the same searchable selection and stable cycling without capturing terminal input or another Quick Pick.
Remote-host maintainers need an existing authorized Remote SSH, WSL, or container environment to verify session discovery on that host and canonical workspace rejection.
Windows/macOS dispatch, remote deployment, and live-provider behavior remain unverified by this change.
Do not claim those paths are verified until their results are recorded; the local agent checks do not establish release readiness or subjective usability acceptance.
No live-provider request, login, upload, user-profile installation, release, or publication was part of these checks.

### Native VS Code checks

| Command | Purpose |
| --- | --- |
| `npm run test:native -- 1.146.0` | Isolated Extension Host assertions against the minimum supported VS Code version. |
| `xvfb-run -a npm run test:native-ui -- 1.146.0` | Linux UI checks for Sidebar session selection, attachments, image preview/focus, queue controls, status/Stop, session details, deletion confirmation, review confirmations, Problems actions, proposals, multi-file Apply/Undo, and reload. |

On headless Linux, also prefix `test:native` with `xvfb-run -a`.
Replace `1.146.0` with `stable` to check the current VS Code release.

1. Append `untrusted` to the `test:native` command for Restricted Mode.
2. Append `alias` to the `test:native-ui` command to test a workspace opened through a directory symlink.
3. Append `packaged` to the `test:native-ui` command to install and test the local `pi.vsix`.

The current settings entry-point contract uses the Pi view title's native **⋯** overflow menu.
**Extension Settings** (`pi.openSettings`) and **Pi Configuration** (`pi.openPiConfiguration`) appear directly in the same configuration group, in that order.
Both commands use category **Pi**, so their Command Palette names are **Pi: Extension Settings** and **Pi: Pi Configuration**.
There is no standalone settings gear or settings submenu, and composer **More…** retains session and work actions without duplicate entries.
Extension Settings retains the native Settings route; Pi Configuration retains its singleton panel and uses **Open Extension Settings** for its cross-link.
Setting values, defaults, scopes, trust checks, and save behavior are unchanged.
Focused Linux x64 native UI checks passed on VS Code 1.140.0 and 1.143.0 for the ordered menu entries, keyboard opening/Escape, both destinations, and the renamed panel cross-link.
Both commands declare gear icons, but the tested native overflow menus render text labels without icons.

Append `settings` to `test:native-ui` for focused native Settings and Pi Configuration UI checks.
This mode supports Linux and macOS with disposable profiles, native configuration controls, and fixture-only file edits.
Passive settings routes are checked before opening Sessions and must not start Pi.
The title-menu checks then open Sessions, which initializes one fixture Pi runtime, and verify that settings actions start no additional process or model request.
On macOS, run `TMPDIR=/private/tmp npm run test:native-ui -- 1.146.0 settings` and repeat with `stable`.
The checks cover all 11 native settings, array edits, category labels, User/Workspace save-on-edit and Reset, plus Pi Configuration singleton, draft recovery, row menus, explicit Save/Reset, and field focus.
Actual remote-user targets and native virtual workspaces are not covered by this local mode.
The other native UI modes remain Linux-only.

Append `transfer` to `test:native-ui` for native export/import/sharing/authentication dialogs only.
These fixtures use fake credentials, cancel browser/upload approval, and never contact a provider or GitHub.

The current annotation contract uses `pi.annotations.initialState`:

- `collapsed` (default) leaves `CommentThread.collapsibleState` unset, using the API's collapsed default.
- `expanded` explicitly sets `CommentThreadCollapsibleState.Expanded`.

**VS Code Settings → Pi → Editor → Annotation initial state** affects only newly created or replaced annotations, not existing handles or user state on redraw.
No global VS Code comments settings are written.

Append `annotations` to `test:native-ui` to check the production editor-annotation workflow in isolation.
The fixture checks:

- The collapsed default and click-to-open behavior.
- Pi Settings initial-state selection/reset without changing retained state or restarting Pi.
- Whole-line code/Markdown highlights and literal hovers.
- Expanded read-only native comments below range end lines, grouped explanations and Comments panel entries.
- Collapse preservation on redraw, inactive tabs and theme colors.
- Stale-input rejection, clearing and session/client cleanup.

The loopback requests originate in the fixture foreground Pi process; registered-tool execution is checked separately in unit tests.
Native panel opening and layout or visible-range/scroll changes are permitted, not failures of the revised contract.

Append `annotation-prototype` to `test:native-ui` for the separate test-only native-thread fixture.
Its earlier no-navigation gate failed when VS Code opened the Comments panel; that requirement is now relaxed by explicit user authorization.
A prototype result does not validate production authorization or lifecycle handling.
See [Native annotation thread feasibility](ANNOTATION_THREAD_FEASIBILITY.md) for current evidence, reproduction and unverified paths.

The initial-state production fixture passed on Linux x64 with VS Code 1.140.0 and 1.143.0.
Earlier separate prototype results cover initially expanded threads; that fixture was not rerun for this setting change.
Source tabs, selections, buffers, files and editor focus remain checked; explicit tab/selection/focus/reveal/scroll operations and settings overrides remain prohibited.
Use [Native annotation thread validation](ANNOTATION_THREAD_FEASIBILITY.md) for commands, historical failures and remaining platform/accessibility checks.
Report browser, native, remote, platform and live-provider results separately.

Append `selection` to `test:native-ui` to check **Ask About Selection** before the sidebar has opened.
This fixture uses the real editor command and question input, then checks the visible conversation and a single read-only request without source changes.

Append `editor` to `test:native-ui` for the isolated multiline-editor and timed-confirmation fixtures only.
They cover exact text, keyboard Submit/Cancel, close/discard, privacy decline, read-only review, timeouts, and process replacement.

Native checks download a VS Code test build into the system temporary cache and use disposable profiles and workspaces.
UI checks use a deterministic Pi RPC fixture; Playwright connects only to the disposable profile's loopback debugging endpoint.
These checks do not use a live model, your VS Code profile, or your workspace.

### Operation diagnostics validation

Append `output-diagnostics` to `test:native-ui` for the isolated **Show Output** fixture.
It injects malformed stdout and private stderr into the offline RPC child, then checks the real Sidebar, Pi log file and Output panel.
It checks that the short recovery summary remains visible, no raw sentinel reaches the webview or log, no modal/panel/notification or editor-focus change occurs before explicit action, and native Tab/Enter selects **Output → Pi** without taking focus.
It also checks that no model prompt or process restart occurs.
This selector uses a source development profile, not an installed VSIX.

Historical checks on Linux x64 with Node.js 26.8.2 on 2026-10-21, before this dependency update, ran sequentially:

| Check | Result |
| --- | --- |
| `npm test` | 92 files passed; 1,391 tests passed, 3 Windows-only tests skipped on Linux; see [Unit coverage](#unit-coverage). |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed with no errors; 875 warnings and 24 informational diagnostics. |
| `npm run test:rich-content` | Passed with local Playwright Chromium, including Show Output keyboard/focus and retained-notice fixtures. |
| `xvfb-run -a npm run test:native -- 1.140.0` | Passed, VS Code 1.140.0. |
| `xvfb-run -a npm run test:native -- stable` | Passed, resolved VS Code 1.143.0. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 output-diagnostics` | Passed, VS Code 1.140.0. |
| `xvfb-run -a npm run test:native-ui -- stable output-diagnostics` | Passed, resolved VS Code 1.143.0. |

#### Unit coverage

The recorded `npm test` run includes logging, activation, privacy, notices, deletion/recovery and runtime/RPC regressions.

Initial checks found outdated constructor/action fixtures and a narrow-panel tab selector; these were corrected before the passing runs.
Diff review also found missing history-generation correlation and a late settlement-refresh rejection that could warn a replacement client.
History now captures its originating generation, RPC commands use the active request ID when applicable, runtime request diagnostics receive the Sidebar retry contract, and stale refresh failures are discarded with Debug metadata for the old client.
Regression tests and all required checks passed after these fixes.
Native Output checks use the active **Pi - Output** document and channel selector because narrow panels can collapse the Output tab into **Additional Views**.
No package publication, extension installation or live-provider validation was performed.

Logging ownership is bounded:

- Activation owns channel/stage records.
- Runtime owns lifecycle, deletion/recovery, request and warning records.
- RPC owns allowlisted command timing/failure records.
- Sidebar owns UI-action, history/storage and permanent-confirmation records.
- Inline completion owns response/invocation/cancellation records.

`src/test/logging.test.ts`, `loggingActivation.test.ts`, `inlineCompletionLogging.test.ts`, `piRpcDiagnostics.test.ts`, `piRuntimeLogging.test.ts` and `sidebarDiagnostics.test.ts` cover metadata projection, warning suppression, disposal/failure isolation, late clients, completed-operation/refresh-failed outcomes and sentinel privacy.
Runtime warnings are not logged again by notices.

Release-maintainer handoff: Windows/macOS and Remote SSH/WSL/container routing, log levels and focus behavior remain unverified.
In each environment, use an isolated profile and offline failure to confirm that the Pi channel belongs to the workspace Extension Host, logging does not reveal Output or change focus, and explicit Show Output selects Pi while the Sidebar warning remains visible.
Do not infer these results from the Linux checks or claim cross-platform/remote validation before those checks pass.
No live-provider check is needed for these deterministic diagnostics.

### Remote draft storage check

After compilation, supply a VS Code Server **web** build and local Playwright Chromium:

```bash
npm run test:remote-drafts -- /path/to/vscode-server-web/bin/code-server
```

The runner uses a loopback-only, token-authenticated server, a remote Node Extension Host, and a disposable Chromium profile.
It checks consent, the actual draft envelope in client IndexedDB, absence from the server's active storage rows, reload/Restore, and Disable.
It uses a synthetic Pi executable with no model calls.
It accepts the supplied server build's license terms through `--accept-server-license-terms`; supply only a build whose terms you accept.
Test homes, profiles, tokens, processes, and files are isolated and removed.
This checks the web-remote topology, not Remote SSH, WSL, containers, or a cross-machine network.

### Real screen-reader check

On Linux x64, supply an extracted compatible Orca dependency prefix, system Python GI, `uv`, `dbus-run-session`, Xvfb, system AT-SPI services, and `xdotool` from that prefix.
Compile the prefix's schemas first with `glib-compile-schemas /path/to/orca-prefix/usr/share/glib-2.0/schemas`:

```bash
npm run test:screen-reader -- /path/to/orca-prefix 1.146.0
npm run test:screen-reader -- /path/to/orca-prefix stable
```

Run screen-reader checks sequentially; Orca does not support concurrent copies in this environment.
The runner starts real Orca with a private display, D-Bus session, home, and VS Code profile.
It checks structural heading navigation and file-hint announcements through actual Orca-generated speech text.
It does not replace speech/navigation functions or use an accessibility-tree snapshot as screen-reader evidence.
Speech Dispatcher, audible output, and human usability are not tested.
Bounded synthetic diagnostic evidence is retained under the printed temporary path.
No live model or file attachment capture is required.

### Bridge lifecycle public contract check

Run this historical reference check with an explicit Pi 1.3.0 CLI path:

```bash
node scripts/test-bridge-lifecycle-reference.mjs /path/to/pi-coding-agent/dist/cli.js
```

The check uses an authenticated loopback fixture and disposable home, configuration, workspace, and session directories.
It checks session transitions, resource reload, fresh subscriptions, event delivery, pending-request cancellation, and clean shutdown without credentials or model calls.
This is a Pi RPC check, not a native VS Code UI or macOS validation.

### Direct-shell public contract check

After compiling, run this historical reference check with an explicit Pi 1.3.0 CLI path:

```bash
node scripts/test-shell-contract.mjs /path/to/pi-coding-agent/dist/cli.js
```

This check uses disposable HOME/config directories, offline mode, no MCP servers, no credentials, and no model calls.
It verifies actual `user_bash` failure/result contracts, read-only enforcement, and public context conversion with harmless local `printf` commands.
It is a separate explicit-installation reference check; the default runtime is the pinned bundled production dependency.

The integrated Linux results, exact checked versions, packaging evidence, and unverified platform/provider limits are in [Native parity validation](NATIVE_PARITY_VALIDATION.md).
These are historical records; earlier tool/shell approval results do not describe the current permission behavior.

### Local installation and debugging

These commands run local processes or change the installed extension; they are not isolated checks:

- `npm run dev` rebuilds and installs the extension, removes legacy bridge files, then opens the current directory in a new VS Code window.
- `npm run dev:pi` starts Pi with `resources/pi-bridge.ts` in the current terminal.

## Release

1. Add a repository Actions secret named `PAT_TOKEN`.
   Use a fine-grained personal access token with **Contents: Read and write** and **Pull requests: Read and write** access to this repository.
2. Create a [Trusted Publishing policy][marketplace-trusted-publishing] for publisher `narumi` in [Visual Studio Marketplace](https://marketplace.visualstudio.com/manage).
   - **Policy name:** `Pi release`
   - **Repository owner:** `narumiruna`
   - **Repository:** `pi-vscode`
   - **Workflow:** `publish.yml`
   - **Environment:** Leave blank because the publishing job does not use a GitHub environment.
3. For each release-worthy pull request, run `npm run changeset` and commit the generated `.changeset/*.md` file.
4. Merge the pull request into `main`.
   The [Publish workflow](../.github/workflows/publish.yml) creates or updates a Version PR when pending changesets exist.
5. Review and merge the Version PR to publish the release.

The workflow runs on each push to `main`.
The Version PR applies pending changesets, updates `CHANGELOG.md`, `package.json`, and `package-lock.json`, and removes the consumed changesets.
A push without a version change only checks for a Version PR; it does not publish a release.
If the previous revision or its `package.json` is unavailable, the workflow also checks for a Version PR without publishing because it cannot verify a version change.
When the Version PR merges, the workflow checks the version and lockfile, checks that no changesets remain, runs the tests, and packages and verifies the VSIX.
Bundled-runtime release verification must pass against that extracted artifact before upload or publication.
Review [bundled runtime release gates](BUNDLED_RUNTIME_VALIDATION.md#release-gates-and-external-handoff), target coverage, dependency/license findings, archive size, and runtime update ownership before release.
The `release` job builds and uploads the verified VSIX; `verify-runtime` checks that same artifact on Linux, Windows, and macOS.
After those checks pass, `github-release` creates a `v<version>` GitHub release with `pi.vsix` attached.
The separate `publish` job publishes the same artifact to Visual Studio Marketplace without rebuilding it, so retrying Marketplace publication does not recreate the release.
`PAT_TOKEN` authenticates Version PR updates and GitHub release creation.
The `publish` job uses GitHub Actions OIDC to authenticate to the Marketplace without `VSCE_PAT`.

If Marketplace publication fails, the GitHub release remains available.
If the original workflow already uses OIDC, use **Re-run failed jobs** to retry `publish` after correcting the policy, while the VSIX artifact is still available in that run.
[A re-run uses the original workflow revision][github-rerun], so it cannot apply later workflow changes.
If the original workflow still used a PAT, you can upload the verified `pi.vsix` from the existing GitHub release to the extension's Marketplace listing without creating another release.

[marketplace-trusted-publishing]: https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing
[github-rerun]: https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs
