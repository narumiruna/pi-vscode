# Native annotation thread validation

## Current outcome

Production `vscode_annotate` now adds initially expanded, read-only native comment threads below marked passages. Whole-line highlights and literal hovers remain available. Messages with the same end line share one thread in input order. Tool parameters, limits and `{ count, visible }` results are unchanged.

The user explicitly accepted native Comments panel opening and editor layout, visible-range and scroll changes during expansion, replacement and removal. These effects are no longer a feasibility failure. The extension does not open documents/tabs, change selections, request focus, issue reveal/scroll commands or override user settings. Native controls follow VS Code behavior; a removed Comments panel row cannot retain DOM focus.

The revised production and prototype fixtures pass on Linux x64 with VS Code **1.140.0** and **1.143.0**. This does not establish macOS, Windows, remote-host, accessibility or live-provider behavior.

## Production implementation

`src/editorAnnotations.ts` owns one lazy stable-API `pi.annotations` controller and retains its thread handles with decoration state. Threads have the label **Pi annotation**, author **Pi**, preview-mode literal bodies and `canReply = false`. No commenting-range provider, reaction handler or mutation commands are registered.

The controller validates complete lines, trust, workspace/file identity, document versions, request revisions, foreground authorization and retention limits before preparing native threads. A failed partial replacement disposes its new handles and keeps the earlier accepted state. Final authorization/content checks and the state commit are synchronous. Existing edit, close, clear and runtime invalidation paths now dispose threads as well as remove decorations. Save-only events and ordinary visible-editor changes retain handles and user collapse state.

`count` counts accepted input annotations, not grouped threads. `visible` means that the document has a visible text editor; user comment visibility settings can hide its native widgets.

## Revised validation

Environment: Linux x64, Node.js **26.8.2**, npm **11.19.1**, Xvfb, local Playwright Chromium and disposable VS Code profiles. Existing locked dependencies were used. No live provider, extension installation or publication was involved.

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

Production native checks establish real code/Markdown highlights, below-end-line placement, complete literal and multiline Chinese messages without links/images/Markdown/reply actions, same-anchor grouping, collapse retention after tab changes, inactive tabs, four themes, EOF without a trailing newline, modified-side diff rendering, Comments panel entries and cleanup. They also check source editor focus/selection/tab/buffer/file preservation, forged/stale request rejection and cleanup on edits, Undo, last-tab closure, empty replacement, manual clear, resource reload, session clone and disconnect/client replacement.

The separate test-owned prototype also checks native collapse/reopen, replacement/removal, Chinese wrapping in a narrow editor and controller disposal. It does not validate production authorization or runtime lifecycle handling. Prototype code remains under `src/test/`; tests and scripts are excluded from the VSIX.

Fixture state comparisons retain source tabs, active editor, selections, versions, dirty state and full buffer/file text. They deliberately do not compare visible ranges or pixel geometry. Source editor snapshots exclude VS Code-owned `comment://` input editors. Explicit fixture navigation represents user inspection, not production annotation behavior. Narrow Markdown geometry uses the last wrapped source segment. Comments panel assertions normalize native non-breaking spaces. Disposal focus is checked from the source editor, not from the panel row being removed.

Logs for this run are local, outside source control, under `/tmp/pi-annotation-revised-*.log`. Prototype before/expanded screenshots use `pi-annotation-prototype-<selector>-annotations-prototype-{before,expanded}.png` in the system temporary directory. `stable` is a selector; logs record the actual VS Code version. Disposable workspaces/profiles are removed by the runner.

## Historical initial gate

The initial draft retained only a test-owned prototype and stopped production integration. On Linux arm64/Xvfb, both VS Code **1.140.0** and **1.143.0** automatically opened the previously hidden Comments panel. Editor geometry and visible ranges changed. Below-anchor placement, literal/Chinese text and duplicate-anchor ordering passed before the original no-navigation assertion failed. Later native scenarios were not reached in those runs.

Those runs remain failures against the original contract; they are not retroactively passing results. The accepted design revision removed that blocker, and the revised fixtures were run again as recorded above.

Initial local verification used macOS arm64 with Node.js 26.10.0/npm 11.19.1 and a Linux arm64 container with Node.js 24.18.1/npm 11.16.0. The serial macOS full suite passed **87 files, 1,297 tests, 3 skipped**; default-concurrency attempts had unrelated RPC/fixture timing failures. The initial locked install reported three dependency advisories. Neither dependency changes nor RPC timing changes are part of this feature.

## Remaining validation handoff

- Maintainers with macOS/Windows and remote-host environments must check native rendering and cleanup. Linux local Extension Host checks are not remote-host evidence.
- Accessibility reviewers must check native keyboard/screen-reader behavior and coexistence with another comment provider. These checks remain unverified.
- Comment visibility-setting combinations are not exhaustively checked; the extension must not override them.
- No standalone rich-content browser test, package installation, publication or live-provider test was run for this change. Native UI tests use Playwright to inspect the actual Electron workbench with fixture Pi responses.

These are separate platform/usability checks, not evidence that the former panel-opening blocker remains in effect.
