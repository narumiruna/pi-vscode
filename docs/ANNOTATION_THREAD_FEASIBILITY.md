# Native annotation thread validation

## Current outcome

Production `vscode_annotate` adds read-only native comment threads below marked passages.
`pi.annotations.initialState` accepts `collapsed` (default) or `expanded`, exposed as **Pi Settings → Editor → Annotation initial state**.
`collapsed` leaves `CommentThread.collapsibleState` unset, using the API's collapsed default; `expanded` explicitly sets `CommentThreadCollapsibleState.Expanded`.
This applies only to newly created or replaced annotations, not existing thread handles or user state on redraw.
No global VS Code comments settings are written.
Whole-line highlights and literal hovers remain available.
Messages with the same end line share one thread in input order.
Tool parameters, limits and `{ count, visible }` results are unchanged.

The user explicitly accepted native Comments panel opening and editor layout, visible-range and scroll changes during expansion, replacement and removal.
These effects are no longer a feasibility failure.
The extension does not open documents/tabs, change selections, request focus, issue reveal/scroll commands or override user settings.
Native controls follow VS Code behavior; a removed Comments panel row cannot retain DOM focus.

The production fixture verifies the collapsed default and the initial-state setting on Linux x64 with VS Code **1.140.0** and **1.143.0**.
Earlier expanded-thread and prototype results remain recorded separately below.
These checks do not establish macOS, Windows, remote-host, accessibility or live-provider behavior.

## Production implementation

`src/editorAnnotations.ts` owns one lazy stable-API `pi.annotations` controller and retains its thread handles with decoration state.
Threads have the label **Pi annotation**, author **Pi**, preview-mode literal bodies and `canReply = false`.
No commenting-range provider, reaction handler or mutation commands are registered.

The controller validates complete lines, trust, workspace/file identity, document versions, request revisions, foreground authorization and retention limits before preparing native threads.
A failed partial replacement disposes its new handles and keeps the earlier accepted state.
Final authorization/content checks and the state commit are synchronous.
Existing edit, close, clear and runtime invalidation paths now dispose threads as well as remove decorations.
Save-only events and ordinary visible-editor changes retain handles and user collapse state.

`count` counts accepted input annotations, not grouped threads.
`visible` means that the document has a visible text editor; user comment visibility settings can hide its native widgets.

## Initial-state setting validation

Environment: Linux x64, Node.js **26.8.2**, npm **11.19.1**, local Playwright Chromium, Xvfb and disposable VS Code profiles.
No extension installation, publication or live provider was used.

- `npm test`: **86 files, 1,327 passed, 3 skipped**, including compilation.
- `npm run test:settings`: passed; collapsed/expanded selection, User/Workspace scope, reset/inheritance and existing Settings checks.
- `npm run test:rich-content`: passed; standalone browser renderer regression checks.
- `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources`: exit 0, **809 warnings and 24 informational diagnostics**, no errors.
- After compilation, `env -u ELECTRON_RUN_AS_NODE xvfb-run -a node scripts/test-native-ui.mjs 1.140.0 annotations` and the same command with `stable`: passed; stable resolved to **1.143.0**.
  The first minimum-version launch inherited `ELECTRON_RUN_AS_NODE` and failed before UI startup; removing that variable permitted the native check.
- Script syntax checks and `git diff --check`: passed.

The production native fixture checks default-collapsed glyphs, highlights, literal hover without expansion and click-to-open.
The actual Pi Settings page changes only the disposable Workspace override.
Expanded selection and reset affect replacements, while retained user collapse/expansion survives setting and tab changes.
User settings bytes, shared Comments settings and Pi process identity remain unchanged.
The existing production rendering, authorization and cleanup cases also pass.
The native Extension Host-only and separate prototype suites were not rerun for this setting change.

Main unit, browser, rich-content, lint and stable native logs use `/tmp/pi-annotation-settings-*.log`.
Disposable native profiles are removed by the runner.

## Earlier revised validation

Environment: Linux x64, Node.js **26.8.2**, npm **11.19.1**, Xvfb, local Playwright Chromium and disposable VS Code profiles.
Existing locked dependencies were used.
No live provider, extension installation or publication was involved.

| Command | Result |
| --- | --- |
| `npm run compile` | Passed; host/browser TypeScript and bundled renderer build. |
| `npm test` | Passed: **86 files, 1,320 passed, 3 skipped**. |
| `npm exec -- vitest run out/test/editorAnnotations.test.js` | Passed: **121 controller tests**. |
| `npm exec -- vitest run out/test/annotationTool.test.js` | Passed: **11 tool tests**. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Exit 0; **804 warnings and 24 informational diagnostics**, no error-level findings. |
| `xvfb-run -a npm run test:native -- 1.140.0` | Passed; native Extension Host. |
| `xvfb-run -a npm run test:native -- stable` | Passed; actual version **1.143.0**. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 annotations` | Passed; production authenticated bridge and native UI. |
| `xvfb-run -a npm run test:native-ui -- stable annotations` | Passed; actual version **1.143.0**. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 annotation-prototype` | Passed under the revised contract. |
| `xvfb-run -a npm run test:native-ui -- stable annotation-prototype` | Passed; actual version **1.143.0**. |
| `node --check scripts/annotation-native-fixture.mjs`; `git diff --check` | Passed. |

Production native checks establish real code/Markdown highlights, below-end-line placement, complete literal and multiline Chinese messages without links/images/Markdown/reply actions, same-anchor grouping, collapse retention after tab changes, inactive tabs, four themes, EOF without a trailing newline, modified-side diff rendering, Comments panel entries and cleanup.
They also check source editor focus/selection/tab/buffer/file preservation, forged/stale request rejection and cleanup on edits, Undo, last-tab closure, empty replacement, manual clear, resource reload, session clone and disconnect/client replacement.

The separate test-owned prototype also checks native collapse/reopen, replacement/removal, Chinese wrapping in a narrow editor and controller disposal.
It does not validate production authorization or runtime lifecycle handling.
Prototype code remains under `src/test/`; tests and scripts are excluded from the VSIX.

Fixture state comparisons retain source tabs, active editor, selections, versions, dirty state and full buffer/file text.
They deliberately do not compare visible ranges or pixel geometry.
Source editor snapshots exclude VS Code-owned `comment://` input editors.
Explicit fixture navigation represents user inspection, not production annotation behavior.
Narrow Markdown geometry uses the last wrapped source segment.
Comments panel assertions normalize native non-breaking spaces.
Disposal focus is checked from the source editor, not from the panel row being removed.

Logs for this run are local, outside source control, under `/tmp/pi-annotation-revised-*.log`.
Prototype before/expanded screenshots use `pi-annotation-prototype-<selector>-annotations-prototype-{before,expanded}.png` in the system temporary directory.
`stable` is a selector; logs record the actual VS Code version.
Disposable workspaces/profiles are removed by the runner.

## Historical initial gate

The initial draft retained only a test-owned prototype and stopped production integration.
On Linux arm64/Xvfb, both VS Code **1.140.0** and **1.143.0** automatically opened the previously hidden Comments panel.
Editor geometry and visible ranges changed.
Below-anchor placement, literal/Chinese text and duplicate-anchor ordering passed before the original no-navigation assertion failed.
Later native scenarios were not reached in those runs.

Those runs remain failures against the original contract; they are not retroactively passing results.
The accepted design revision removed that blocker, and the revised fixtures were run again as recorded above.

Initial local verification used macOS arm64 with Node.js 26.10.0/npm 11.19.1 and a Linux arm64 container with Node.js 24.18.1/npm 11.16.0.
The serial macOS full suite passed **87 files, 1,297 tests, 3 skipped**; default-concurrency attempts had unrelated RPC/fixture timing failures.
The initial locked install reported three dependency advisories.
Neither dependency changes nor RPC timing changes are part of this feature.

## Remaining validation handoff

- Maintainers with macOS/Windows and remote-host environments must check native rendering and cleanup.
  Linux local Extension Host checks are not remote-host evidence.
- Accessibility reviewers must check native keyboard/screen-reader behavior and coexistence with another comment provider.
  These checks remain unverified.
- Comment visibility-setting combinations are not exhaustively checked; the extension must not override them.
- No package installation, publication or live-provider test was run.
  Browser Settings/rich-content and native UI checks are separate; native UI tests inspect the actual Electron workbench with fixture Pi responses.

These are separate platform/usability checks, not evidence that the former panel-opening blocker remains in effect.
