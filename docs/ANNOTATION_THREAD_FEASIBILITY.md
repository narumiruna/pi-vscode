# Native annotation thread feasibility

## Disposition

**Blocked. Do not integrate or release the native-thread display.**

On 2026-10-21, the test-only prototype failed the no-navigation contract on Linux arm64 with Xvfb, on VS Code **1.140.0** and **1.143.0** (`stable`). Creating an expanded thread opened the native Comments panel without a user action. The panel was hidden before creation. Editor focus stayed in the editor, but its visible range changed from zero-based lines 20–59 to 20–32.

VS Code [1.140.0 comment configuration](https://github.com/microsoft/vscode/blob/1.140.0/src/vs/workbench/contrib/comments/browser/comments.contribution.ts) defines `comments.openView` with the default `firstFile`. The disposable profiles did not override comment settings. Changing user settings or closing the panel after creation is not an accepted fix for this plan.

Production `EditorAnnotations`, authorization, runtime invalidation, bridge schema, limits and results are unchanged. The existing whole-line highlight and hover remain the supported display. No capability documentation or patch changeset is added because this change supplies tests and a failed feasibility result, not a released capability.

## Prototype boundary

`src/test/annotationThreadPrototype.ts` owns one lazy stable-API controller. It groups literal explanations by end line and creates expanded, read-only threads labelled **Pi annotation**, with **Pi** as author. It disposes a failed partial replacement while retaining earlier handles. The native fixture invokes it directly through the disposable test coordinator, not through `vscode_annotate`.

This prototype is not an authorized workflow. It does not implement production origin/content validation or document/runtime event handling. The coordinator disposes it on exit. All prototype code is under `src/test/`; `out/test/` and scripts are excluded from the VSIX. No production command, setting, dependency or bridge route is added.

Mock tests establish ownership and API inputs, not native placement or navigation safety.

## Recorded checks

Local host: macOS arm64, Node.js **26.10.0**, npm **11.19.1**. Linux container: arm64, Node.js **24.18.1**, npm **11.16.0**, Xvfb, disposable profiles. Both environments used `npm ci` with the unchanged lockfile.

| Check | Result |
| --- | --- |
| `npm run compile` | Passed. |
| Focused prototype and existing annotation unit tests | 113 passed, including 16 prototype cases. |
| `TMPDIR=/private/tmp npm test -- --maxWorkers=1` | Full runs passed: 87 files; 1,297 tests passed, 3 skipped. |
| Default four-worker macOS `npm test` / pre-commit | Failed: RPC `get_state` and fixture-PID observation timeouts, including a failed pre-commit attempt and a separate full retry. The initial agent run also had an RPC timeout. No RPC code/assertion was changed. Serial runs pass; default-concurrency timing remains unresolved on this host. |
| `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Exit 0; warnings and informational diagnostics remain. |
| `xvfb-run -a npm run test:native -- 1.140.0` | Passed; native Extension Host, Linux. |
| `xvfb-run -a npm run test:native -- stable` | Passed; native Extension Host, Linux, actual version 1.143.0. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 annotations` | Passed; unchanged production annotation UI and lifecycle. |
| `xvfb-run -a npm run test:native-ui -- stable annotations` | Passed; unchanged production annotation UI, actual version 1.143.0. |
| `xvfb-run -a npm run test:native-ui -- 1.140.0 annotation-prototype` | **Failed**, exit 1: creation opens Comments panel. |
| `xvfb-run -a npm run test:native-ui -- stable annotation-prototype` | **Failed**, exit 1, actual version 1.143.0: same panel-opening failure. |

The prototype native checks established below-anchor geometry, one widget for duplicate end-line anchors, ordered full literal lines, multiline Chinese text, and no links, images, model Markdown formatting or reply editor in the rendered bodies. `MarkdownString.appendText` renders line breaks as paragraphs; the fixture compares full literal paragraph text rather than paragraph-spacing differences in `innerText`.

The gate stops at the panel-opening assertion. Later assertions for replacement/removal navigation safety, native collapse/reopen, inactive threads, EOF without a newline, diff views, four themes, narrow layout and Comments panel cleanup are prepared but **not reached or verified**. Native visibility-setting interactions, other comment providers, keyboard and screen-reader behavior are also unverified. The unchanged production annotation fixture does not establish these prototype properties.

No browser renderer, native macOS/Windows, remote-host or live-provider checks were run for this prototype. Linux in a local container is not remote Extension Host coverage. No live provider, installed-extension change, package publication, version tag or release workflow was used.

`npm ci` reported three dependency advisories (one moderate, one high, one critical). Dependency changes are outside this feasibility work.

## Reproduce and retain evidence

Use Linux with a graphical display or Xvfb, Node.js 22.19 or newer, locked dependencies and the repository's native UI prerequisites. No provider is required.

```sh
npm ci
xvfb-run -a npm run test:native-ui -- 1.140.0 annotation-prototype
xvfb-run -a npm run test:native-ui -- stable annotation-prototype
```

Both commands currently fail; do not treat a failed assertion as a passing gate. The runner prints `PI_ANNOTATION_PROTOTYPE_PLACEMENT` with the actual version, focus/panel visibility and visible ranges. Screenshots remain outside source control in the system temporary directory:

1. `pi-annotation-prototype-<version>-annotations-prototype-before.png`
2. `pi-annotation-prototype-<version>-annotations-prototype-expanded.png`
3. `pi-native-ui-<version>-annotations-prototype-failure.png`

For the `stable` selector, screenshot filenames use `stable`; the log records its actual version. In a container, copy screenshots and logs out before removing it. Disposable workspaces and profiles are removed by the runner.

## Required next decision

The maintainer must select a revised design that preserves the existing no-navigation contract before production integration can continue. Do not override comment settings, add reveal/scroll commands, silently accept panel opening, or substitute hover-only output as completion of the below-code goal.

After an accepted revision, rerun the gate on minimum and current VS Code and complete every unreached assertion. Only a passing gate permits production integration. Production lifecycle/security tests, capability documentation and a changeset then remain required. macOS, Windows, remote-host and accessibility checks remain separate handoffs.
