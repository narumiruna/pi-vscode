# Native Pi parity validation

## Checked environment

Integrated checks ran on Linux on 2026-10-18 with Node.js 26.8.2 and npm 11.19.1. `npm ci` installed the locked dependencies with Husky enabled. Dependency manifests and lockfiles are unchanged.

The minimum VS Code version is 1.106.0; the checked stable release is 1.142.0. The Node workspace Extension Host, stable API declarations and trust/virtual-workspace boundaries are unchanged. Pi 1.3.0 is an explicit external validation reference, not an Extension Host dependency or a new general minimum.

## Build, unit and browser checks

| Check | Result |
| --- | --- |
| `npm test` | Passed: 70 files; 627 passed tests, 3 platform-specific skips. Host/browser TypeScript and bundled assets compile. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed with no errors, 656 warnings and 24 informational diagnostics. This is not warning-free lint. |
| `node scripts/test-rich-content.mjs` after compilation | Passed renderer/CSP/lifecycle, 72 interface layouts, four image cases, eight phases, 144 extension-UI layouts, completion, shell and thinking fixtures across four themes. |
| `node scripts/test-thinking-picker.mjs` | Passed 64 browser layout cases. |
| `node scripts/test-settings.mjs` | Passed scopes, reset, stale conflicts, drafts, keyboard, 12 layouts/themes, CSP and teardown. |
| Changed JavaScript syntax and `git diff --check` | Passed. |

Browser IPC is simulated. Browser results alone do not establish native dialog or remote behavior.

## Native Linux checks

All runs use disposable profiles/workspaces and deterministic Pi responses. No installed user profile or extension was changed.

| Command after compilation | Result |
| --- | --- |
| `xvfb-run -a node scripts/test-native.mjs 1.106.0` | Passed trusted Extension Host assertions. |
| Same command with `1.106.0 untrusted` | Passed Restricted Mode launch guards. |
| Same commands with `stable` and `stable untrusted` | Passed on 1.142.0. |
| `xvfb-run -a node scripts/test-native-ui.mjs 1.106.0` | Passed complete native UI suite. |
| Same UI command with `stable` | Passed complete suite on 1.142.0. |
| Same UI command with `1.106.0 alias` | Passed with a workspace-root directory alias. Transfer files use canonical selected paths; unsafe linked file paths remain rejected. |
| Same UI command with `1.106.0 packaged` | Passed against the locally packaged VSIX installed only in the disposable test profile. |
| Same UI command with `1.106.0 editor` and `stable editor` | Passed focused multiline-editor and timed-confirmation fixtures. |

The full UI runs cover:

- Provider thinking, redacted/thinking-only responses, keyboard disclosures and authoritative history after reload.
- Keyed extension status/widgets, host warning/Stop separation, text safety and native zoom geometry.
- Multiline LF/CRLF/empty/Unicode values, edited revisions, privacy decline, Submit/Cancel, close/discard, timeout, read-only confirmation review and process replacement.
- Local file completion, dirty snapshots, inspection, path-only insertion, failed capture, stale drafts and exactly one explicit Send.
- Shell modal rejection/approval, inclusion/exclusion labels, inert correlated results and attachment rejection.
- Settings scopes/reset/drafts; native settings save/reset, dirty-buffer rejection, normal Save recovery and passive secret-free MCP metadata.
- Repeated reload, clone, no-summary navigation, fork, retained drafts and terminal ownership across Extension Host reload.
- Native export format/Save dialogs, exclusive-file collision, full-tree HTML, import Open/modal cancel/approve, configured-directory retention, unchanged source and verified imported history.
- Read-only sharing inspection, masked redaction, mandatory reinspection and upload cancellation.
- Authentication provider/method and host/store approval, masked cancellation/fake success, browser-approval cancellation and unsupported helper handling.
- Existing review scopes, Problems actions, proposal Preview/Apply/Undo, queue/Stop/recovery and deletion confirmation.

Authentication/transfer preparation records ordinary model prompts unchanged at 0 → 0. A disposable fail-closed `gh` stub is never invoked. Fake credential success does not authenticate or create a real credential store. Browser and upload approvals are cancelled.

Terminal recovery checks stop only the captured disposable fixture writer before explicit Return. Linux process command-line identity is checked before a manual fixture stop. An exited zombie is not a running writer. Terminal handles can change across reload; neither closing a terminal nor this test proves arbitrary descendant termination.

## Actual Pi public-contract references

These commands use an explicitly installed Pi 1.3.0 and disposable HOME/agent/workspace directories:

```bash
node scripts/test-pi-control-reference.mjs /explicit/pi/dist/cli.js
node scripts/test-shell-contract.mjs /explicit/pi/dist/cli.js
node scripts/test-isolated-sdk.mjs /explicit/pi-executable
node scripts/test-native-mcp-reference.mjs /explicit/pi/dist/cli.js
```

The local CLI reference was `/home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`; the explicit executable was `/home/narumi/.bun/bin/pi`. These paths are not runtime defaults.

1. Control reference passed three reloads, abandoned/first-turn forks, clone, null-leaf rejection, no-summary navigation, missing-command protection and unchanged session identity. Empty sessions reload, expose bounded import-location metadata without creating a header, and reopen the assigned path with a non-durable ID.
2. Shell reference passed actual `user_bash` throw/invalid-result fail-closed behavior, replacement-result semantics, packaged RPC approval/denial and context inclusion/exclusion with retained history. Only harmless local `printf` commands run.
3. Isolated SDK discovery/export/import passed with an empty isolated store, active leaf export excluding an abandoned branch, complete-tree import and unchanged source bytes. An external same-cwd source proves `getSessionDir()` is independent of its parent; its digest matches persisted entries.
4. Native MCP reference passed actual local stdio tools/resources with direct, deferred/search, codemode, hidden and per-tool exposure; disabled/replacement ownership; malformed connection errors; two reloads; focused read-only mutation denial; and exit of all 11 fixture processes. Provider responses are fixed in-process, not live model responses. No external server is used.

## Final regression review

Independent read-only review checked all 13 matched plans and found no remaining blocking P1/P2 defect. Integration fixes have focused regression coverage for:

- Imported history under held operation ownership without overwriting a newer request, execution or history generation.
- Unsaved-session shell, import-location reads and controlled restart/return, while saved/foreign headers still fail closed.
- Actual versus cached session identity before restart and disconnect after uncertain shell identity.
- Disposal, changed launch settings and canonical-root checks during startup preparation.
- Mandatory native TUI shell confirmation independent of tool mode, without reusing RPC approval.
- Completion/error notifications that do not keep completed native commands pending.

The original feature-worktree validation documents retain historical counts. This document records the integrated results.

## VSIX

`npm run package` passed and produced `pi.vsix`: 163 files, approximately 2.74 MB. Contents inspection confirmed all packaged bridge/policy/control/helper resources, host controllers and bundled renderer/settings assets. Source tests, fixture scripts, plans, skills and `node_modules` are excluded. The final documentation-only rebuild matches all 156 runtime/resource/manifest files from the VSIX used by the passing packaged UI run. The archive and temporary screenshots are not committed.

## Unverified and unsupported boundaries

- Remote SSH/WSL/container behavior, Windows/macOS native UI, assistive technology and real hot-exit backup cleanup were not tested.
- Real provider/device/manual redirects, live authentication, external MCP servers, actual GitHub upload and real interactive Pi TUI behavior were not tested.
- Native TUI policy has handler fixtures; the actual Pi reference proves RPC contracts. Neither is a visual interactive-TUI check.
- Arbitrary terminal components/themes remain in Pi's terminal. No PTY/browser component protocol was added.
- Radius sharing, authoritative live MCP state, retry-enabled reads, general live scoped-model application and verified setter disk durability remain unavailable without public upstream contracts.
- Unknown execution, authentication, switching and upload outcomes never trigger automatic replay. Cleanup does not establish that escaped or Windows descendants stopped.

## Existing dependency advisories

`npm ci` and `npm audit` report two pre-existing transitive development advisories:

1. Moderate `qs@6.15.3`, through `@vscode/vsce` / `typed-rest-client`.
2. Critical `shell-quote@1.10.0`, through `@changesets/cli` / `launch-editor`.

These tooling dependencies are not shipped as VSIX `node_modules`. No dependency update or automatic audit fix is included in this feature change. Passing build/package checks are not a clean dependency-audit claim.
