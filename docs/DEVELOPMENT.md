# Development and release

Run commands from the repository root. See the [user guide](USER_GUIDE.md) for installation alternatives and the [overview](../README.md) for normal Marketplace installation.

## Install from source

Building from source requires Node.js 22.19 or newer, npm, and a POSIX shell available as `sh`. On Windows, install Git for Windows and add its `sh` command to `PATH`.

```bash
npm ci
npm run install:extension
```

`npm run install:extension` packages and installs the VS Code extension, then removes the exact legacy global bridge filenames created by older releases. It does not install a Pi extension under `${PI_CODING_AGENT_DIR:-~/.pi/agent}`. The extension ID is `narumi.narumi-pi`.

Use `npm run install:vsix` to package and install without the legacy global bridge cleanup. `npm ci` installs the locked project dependencies; it does not install the VS Code extension.

Run **Developer: Reload Window** after installation. Use **More… → Open in Terminal** for an automatically bridged Pi session. For an ordinary integrated terminal, see [Extension bridge](USER_GUIDE.md#extension-bridge).

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
| `npm run watch` | Watch host TypeScript only. Rerun `compile` after renderer or style changes. |
| `npm test` | Compile, then run the Vitest suite without a live model. |
| `npm run package` | Run the full test suite and create or overwrite `pi.vsix`. |

Run compile-based commands sequentially. Their shared generated assets can conflict when multiple builds run at the same time.

### Listing screenshots

After compilation, capture the README images with the installed Playwright Chromium:

```bash
node scripts/capture-readme.mjs
```

This overwrites the two PNG assets in `resources/screenshots/`. The script uses the current sidebar HTML, sample conversation and attachment data, simulated VS Code IPC, and blocked network requests. It checks that Preview is enabled, Apply is disabled before preview, and the Preview button sends the expected action. It does not start Pi, request a model, open a native diff, or apply an edit. The screenshots show the sidebar renderer, not the complete VS Code workbench. Review both images after changing the renderer or capture data.

### Browser checks

Install local Playwright Chromium before running browser checks:

```bash
npm exec -- playwright-core install chromium
npm run test:rich-content
npm run test:thinking-picker
npm run test:settings
```

The rich-content check tests the sidebar document, CSP, rendering, themes, overflow, and asynchronous lifecycle. It also runs deterministic interface fixtures for responsive actions, attachments, queue submissions, session details, status, and scroll preservation. Extension status/widget fixtures check keyed ordering, removal, text safety, keyboard order, four themes, 224 narrow/short layouts, and host warning/Stop visibility. Run it after renderer changes. Run the thinking-picker check after thinking-picker changes. The settings check tests controls, scopes, reset, external-change conflicts, draft recovery, keyboard navigation, themes, layout, and CSP using the bundled assets. None of these checks uses a live model.

Fixed-status regressions check the permanent composer parent, Sessions parity, reserved idle geometry, message priority, neutral empty input, long text and recovery-button wrapping, unchanged recovery checks, focus, scroll preservation, and no duplicate DOM live announcements. Unit/browser checks and full Linux native UI suites passed on VS Code 1.106.0 and 1.142.0. Real screen-reader, remote, and Windows/macOS UI checks were not rerun for this relocation; see [Composer behavior and validation](COMPOSER_UX.md) for evidence and coverage limits.

Composer completion fixtures cover attachment capture, path-only insertion, failed capture, stale replies, IME, keyboard focus, and narrow layouts without a model.

Thinking fixtures check thinking-only and redacted responses, disclosure keyboard access, live focus and scroll preservation, and authoritative history replacement without a provider.

Direct-shell fixtures check explicit composer guards, context labels, inert cards, and terminal-control removal.

### Isolated Pi public-SDK check

After compilation, run `node scripts/test-isolated-sdk.mjs <configured-pi-executable>` to verify the packaged helper against an explicit Pi 1.3.0 installation. This check uses disposable directories and a fixture session. It verifies static provider discovery, active-branch export, complete-tree import and unchanged source bytes without authentication, model calls, or uploads. No installed Pi path is embedded in the extension.

### Native VS Code checks

| Command | Purpose |
| --- | --- |
| `npm run test:native -- 1.140.0` | Isolated Extension Host assertions against the minimum supported VS Code version. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0` | Linux UI checks for attachments, image preview/focus, queue controls, status/Stop, session details, deletion confirmation, review confirmations, Problems actions, proposals, multi-file Apply/Undo, and reload. |

On headless Linux, also prefix `test:native` with `xvfb-run -a`. Replace `1.140.0` with `stable` to check the current VS Code release.

1. Append `untrusted` to the `test:native` command for Restricted Mode.
2. Append `alias` to the `test:native-ui` command to test a workspace opened through a directory symlink.
3. Append `packaged` to the `test:native-ui` command to install and test the local `pi.vsix`.

Append `transfer` to `test:native-ui` for native export/import/sharing/authentication dialogs only. These fixtures use fake credentials, cancel browser/upload approval, and never contact a provider or GitHub.

Append `annotations` to `test:native-ui` for isolated editor-annotation checks: real code/Markdown decorations and literal hovers, inactive tabs, focus/cursor/scroll preservation, theme colors, stale-input rejection, clearing and session/client cleanup. The loopback requests originate in the fixture foreground Pi process; registered-tool execution is checked separately in unit tests.

Append `selection` to `test:native-ui` to check **Ask About Selection** before the sidebar has opened. This fixture uses the real editor command and question input, then checks the visible conversation and a single read-only request without source changes.

Append `editor` to `test:native-ui` for the isolated multiline-editor and timed-confirmation fixtures only. They cover exact text, keyboard Submit/Cancel, close/discard, privacy decline, read-only review, timeouts, and process replacement.

Native checks download a VS Code test build into the system temporary cache and use disposable profiles and workspaces. UI checks use a deterministic Pi RPC fixture; Playwright connects only to the disposable profile's loopback debugging endpoint. These checks do not use a live model, your VS Code profile, or your workspace.

### Remote draft storage check

After compilation, supply a VS Code Server **web** build and local Playwright Chromium:

```bash
npm run test:remote-drafts -- /path/to/vscode-server-web/bin/code-server
```

The runner uses a loopback-only, token-authenticated server, a remote Node Extension Host, and a disposable Chromium profile. It checks consent, the actual draft envelope in client IndexedDB, absence from the server's active storage rows, reload/Restore, and Disable. It uses a synthetic Pi executable with no model calls. It accepts the supplied server build's license terms through `--accept-server-license-terms`; supply only a build whose terms you accept. Test homes, profiles, tokens, processes, and files are isolated and removed. This checks the web-remote topology, not Remote SSH, WSL, containers, or a cross-machine network.

### Real screen-reader check

On Linux x64, supply an extracted compatible Orca dependency prefix, system Python GI, `uv`, `dbus-run-session`, Xvfb, system AT-SPI services, and `xdotool` from that prefix. Compile the prefix's schemas first with `glib-compile-schemas /path/to/orca-prefix/usr/share/glib-2.0/schemas`:

```bash
npm run test:screen-reader -- /path/to/orca-prefix 1.140.0
npm run test:screen-reader -- /path/to/orca-prefix stable
```

Run screen-reader checks sequentially; Orca does not support concurrent copies in this environment. The runner starts real Orca with a private display, D-Bus session, home, and VS Code profile. It checks structural heading navigation and file-hint announcements through actual Orca-generated speech text. It does not replace speech/navigation functions or use an accessibility-tree snapshot as screen-reader evidence. Speech Dispatcher, audible output, and human usability are not tested. Bounded synthetic diagnostic evidence is retained under the printed temporary path. No live model or file attachment capture is required.

### Bridge lifecycle public contract check

Run the offline check with an explicit Pi 1.3.0 CLI path:

```bash
node scripts/test-bridge-lifecycle-reference.mjs /path/to/pi-coding-agent/dist/cli.js
```

The check uses an authenticated loopback fixture and disposable home, configuration, workspace, and session directories. It checks session transitions, resource reload, fresh subscriptions, event delivery, pending-request cancellation, and clean shutdown without credentials or model calls. This is a Pi RPC check, not a native VS Code UI or macOS validation.

### Direct-shell public contract check

After compiling, run the reference check with an explicit Pi 1.3.0 CLI path:

```bash
node scripts/test-shell-contract.mjs /path/to/pi-coding-agent/dist/cli.js
```

This check uses disposable HOME/config directories, offline mode, no MCP servers, no credentials, and no model calls. It verifies actual `user_bash` failure/result contracts, read-only enforcement, and public context conversion with harmless local `printf` commands. It is a validation reference, not another extension runtime dependency.

The integrated Linux results, exact checked versions, packaging evidence, and unverified platform/provider limits are in [Native parity validation](NATIVE_PARITY_VALIDATION.md). These are historical records; earlier tool/shell approval results do not describe the current permission behavior.

### Local installation and debugging

These commands run local processes or change the installed extension; they are not isolated checks:

- `npm run dev` rebuilds and installs the extension, removes legacy bridge files, then opens the current directory in a new VS Code window.
- `npm run dev:pi` starts Pi with `resources/pi-bridge.ts` in the current terminal.

## Release

1. Add a repository Actions secret named `PAT_TOKEN`. Use a fine-grained personal access token with **Contents: Read and write** and **Pull requests: Read and write** access to this repository.
2. Add a repository Actions secret named `VSCE_PAT`. Use an Azure Personal Access Token with **Marketplace (Manage)** scope and access to publisher `narumi`.
3. For each release-worthy pull request, run `npm run changeset` and commit the generated `.changeset/*.md` file.
4. Merge the pull request into `main`. The [Publish workflow](../.github/workflows/publish.yml) creates or updates a Version PR when pending changesets exist.
5. Review and merge the Version PR to publish the release.

The workflow runs on each push to `main`. The Version PR applies pending changesets, updates `CHANGELOG.md`, `package.json`, and `package-lock.json`, and removes the consumed changesets. A push without a version change only checks for a Version PR; it does not publish a release. If the previous revision or its `package.json` is unavailable, the workflow also checks for a Version PR without publishing because it cannot verify a version change. When the Version PR merges, the workflow checks the version and lockfile, checks that no changesets remain, runs the tests, and packages and verifies the VSIX. The `release` job creates a `v<version>` GitHub release with `pi.vsix` attached. `PAT_TOKEN` authenticates Version PR updates and GitHub release creation. The `publish` job then uses `VSCE_PAT` to publish the same verified VSIX artifact to Visual Studio Marketplace without rebuilding it.

If Marketplace publication fails, the GitHub release remains available. Use **Re-run failed jobs** on the same workflow run to retry `publish` without repeating version updates or release creation. The VSIX artifact must still be available in that run.
