# Pi Settings Validation

## Outcome

The Pi Settings editor covers all 11 existing manifest properties in General, Permissions, and Editor categories. It uses native VS Code configuration storage with explicit User/Workspace targets, inherited/effective values, target-specific reset, host validation, and stale-draft checks. It does not start Pi, discover models, reconfigure active sessions, or restart processes.

Implementation base: `ec6dfe8465e7b0a96c18d28270164622fec91a89` (`origin/main`). Validation ran on Linux x64 with Node.js 26.8.2 and locked dependencies installed through `npm ci`. No live provider was used.

## Checks

| Check | Result |
| --- | --- |
| `npm run compile` | Passed with host/browser strict TypeScript and separate local settings assets. |
| `npm test` | Passed: 47 files, 388 tests. Repeated by packaging and the enabled pre-commit hook. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Exit 0; 458 warnings and 17 informational diagnostics remain. No lint or formatting errors. |
| `npm run test:settings` | Passed: all controls, explicit scope writes, target-specific reset, empty lists, zero, invalid edits, failed saves, conflicts, draft recovery/size warnings, keyboard focus, 12 viewport/theme cases, local assets, hostile strings, blocked inline script/network loads, and teardown. |
| `npm run test:rich-content` | Passed: existing rich rendering, CSP, bounded caches, queues, and lifecycle checks. |
| `npm run test:thinking-picker` | Passed: 49 layout cases; chat renderer source was not changed. |
| `xvfb-run -a npm run test:native -- 1.106.0` | Passed, including settings command, singleton/reopen lifecycle, native User/Workspace configuration behavior, existing workflows, and 41 diagnostic encoding cases. |
| `xvfb-run -a npm run test:native -- stable` | Passed on VS Code 1.142.0 with the same assertions. |
| `xvfb-run -a npm run test:native -- 1.106.0 untrusted` | Passed existing trust-guard assertions. This is not a claim that Settings is available in Restricted Mode. |
| `xvfb-run -a npm run test:native-ui -- 1.106.0` | Passed: settings gear, panel reuse, actual host-backed saves/reset, hidden drafts, unchanged Pi PID/prompt logs, and the existing complete workflow fixture. |
| `npm run package` | Passed: 137 VSIX entries, approximately 2.64 MB. |
| `xvfb-run -a npm run test:native-ui -- 1.106.0 packaged` | Passed with a disposable installation of the local artifact; no user profile was changed. |
| VSIX inspection | Settings host modules and `out/settings/settings.js`/`settings.css` are present. No `src/` or `out/test/` entries. |
| Visual inspection | Inspected `/tmp/pi-settings-native-1.106.0.png`: native editor tab, theme integration, scope controls, stacked category layout at a narrow editor width, and Pi gear are visible. Screenshots are not committed. |
| Diff review | Checked correctness, validation/CSP/trust boundaries, disposal and late callbacks, minimum-version types, process/session separation, regressions, and scope. No generated assets or binary artifacts are committed. |

The locally tested VSIX SHA-256 was `a8e4504698347243c4e19b95fd4b21705ce2f6cc0406ef8deaf2022a4d24f589`. Packaging overwrites the ignored local archive; it is not a release artifact.

## Failures Investigated

1. Initial native singleton assertion ran before VS Code published its tab update. Added a bounded wait in the test; minimum and stable native runs then passed.
2. Initial packaging failed because the existing `@types/vscode` 1.140.0 exceeded `engines.vscode` 1.106.0. Pinned types and lockfile to 1.106.0. Compile, tests, native runs, and packaging pass without raising the minimum version or bypassing VSCE checks.
3. An extra full stable native UI run passes all new Settings assertions, then times out in the Git branch-review Quick Pick: the next picker replaces the previous picker without becoming hidden. Reproduced the same timeout on unchanged base commit `ec6dfe8` in a disposable worktree. An experimental test-helper adjustment was reverted; no unrelated fixture behavior was changed. Full stable native UI remains unverified, while the stable Extension Host checks and the complete minimum-version UI checks pass.

## Limits and Remaining Risks

- WSL, SSH, containers, Windows, and macOS were not tested. Runtime resource loading uses webview URIs and message passing, not a local HTTP server.
- Remote User target layering was not verified. The page explicitly directs users to native Settings for local-user versus remote-user distinctions; it does not provide separate controls for those layers.
- Configuration revision checks reject known stale writes but cannot provide atomic compare-and-set across windows or external writers.
- Small drafts survive hide/reveal; drafts above the 32 KiB recovery bound produce a warning, and closing a panel discards drafts. Accepted configuration writes can finish after panel disposal without posting late UI results.
- Permission and launch changes apply only to later process creation. No automatic restart or active-session RPC change was added.
- `npm ci`/`npm audit` report existing transitive advisories for `qs` (moderate) and `shell-quote` (critical). This change does not update those dependencies. Dependency advisory remediation is separate work.
- No package publication, version tag, release workflow dispatch, or live-provider check was performed.
