# Tool activity UI verification

Base: `origin/main` at `8f8b442`. Branch: `narumi/feat/tool-activity-ui`.

## Behavior and payload evidence

| Payload | Verified presentation |
| --- | --- |
| read, edit, write arguments | `path` supplies the summary. Input retains the bounded serialized arguments. |
| bash arguments | `command` supplies the summary. Control characters and whitespace become spaces in the summary only. |
| codemode and unknown arguments | Neutral `Tool operation` summary; no source-code inference. |
| Pi read, edit, bash, and streamed results | `content` arrays of text blocks supply output with real line breaks. |
| codemode printed results | Decode one serialized text-result envelope or the verified bash `{output, exit_code, wall_time_seconds, truncated}` shape. Do not parse recursively. |
| Tool errors | Display supplied output before Input and Output. Do not infer a cause or claim a later success repaired the call. |
| Unknown, mixed, or invalid content | Retain readable JSON or ordinary text. Preserve literal backslashes. |

The installed Pi tool implementations (`core/tools/read.js`, `edit.js`, `bash.js`) and codemode `extensions/codemode/execute.js` supplied the shape evidence. Repository fixtures are in `scripts/fixtures/tool-activity.cjs`; helper assertions are in `src/test/toolPresentation.test.ts`.

The host still retains at most 30 calls and 8,000 characters per Input/Output value. Summaries use original arguments and have a 240-character limit. Host and known tool truncation have explicit notices. Full-content disclosure and copy expose retained text only.

Tool rows use status icons with accessible names, tool names, and ellipsized operation summaries. The group has a neutral call count with separate running/failure indicators. Only the failure indicator and failed rows receive error emphasis. Details retain labeled Input and Output, an empty-output state, six-line/600-character previews, full retained text, and copy feedback. Background-task styles are unchanged.

## Checks

- `npm test`: **373 tests in 45 files passed**, including compilation. Coverage includes missing/long/untrusted arguments, wrapped/unknown/invalid output, literal backslashes, HTML-like text, truncation, status combinations, empty/partial output, disclosure transitions, insertion, removal, reset, and scroll following with full output open.
- `npm run test:native-ui`: passed on Linux, VS Code **1.106.0**, with deterministic RPC responses and no provider calls. Existing attachment, review, Problems, Preview/Apply/Undo, cancellation, and reload checks also passed.
  - Eleven collapsed tool rows measured **264px**, below the 275px acceptance limit.
  - Enter/Space disclosure, visible keyboard focus, bounded previews, full retained output, Input/Output copy, safe text, manual opening through settlement, and reader scroll preservation passed in the actual webview.
  - The actual webview clipboard returned `Output copied`. Controlled clipboard implementations also proved successful copying of both values and visible rejection feedback without changing permissions.
  - Headless Chromium rendered snapshots of the native DOM at **640px and 320px**, in actual VS Code dark, light, and high-contrast themes. Both compact and expanded layouts had no page-level horizontal overflow. Scripts and external requests were disabled for these static snapshots; interaction assertions ran in the native webview.
- `npm run test:rich-content`: passed, including CSP, rendering, overflow, asynchronous lifecycle, and reader scroll regressions.
- Biome 2.5.13 checks on changed source/test scripts: no errors. Existing-style warnings remain.
- `git diff --check`: passed.

The native UI runner requires Linux, a usable display, VS Code test assets, and the local Playwright Chromium installation already used by `test:rich-content`.

## Screenshot evidence

Screenshots are retained in [tool-activity-ui/](tool-activity-ui/). Each pair shows the compact list and one expanded call.

| Theme | Width | Compact list | Details |
| --- | --- | --- | --- |
| Dark | 640px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-dark-640.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-dark-640-details.png) |
| Dark | 320px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-dark-320.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-dark-320-details.png) |
| Light | 640px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-light-640.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-light-640-details.png) |
| Light | 320px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-light-320.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-light-320-details.png) |
| High contrast | 640px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-high-contrast-640.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-high-contrast-640-details.png) |
| High contrast | 320px | [List](tool-activity-ui/pi-tools-1.106.0-vscode-high-contrast-320.png) | [Details](tool-activity-ui/pi-tools-1.106.0-vscode-high-contrast-320-details.png) |

## Final review

All six UI findings have evidence: meaningful summaries, compact rows, scoped failure emphasis, readable output, separate Input/Output, and preserved manual disclosure.

Correctness, security, lifecycle safety, compatibility, regressions, and scope were reviewed. Tool content uses `textContent`, not executable HTML. No permissions, CSP, execution, retry, message ordering, settings, manifest, or host placement changed. Stable rows remain attached during streaming and oldest-call removal; manual intent is separate from automatic disclosure and resets with activity. Output uses the conversation scroll surface rather than nested vertical scrollbars.

Live providers, Windows/macOS UI, remote hosts, packaged installation, and screen-reader speech were not rerun. These are unchanged-platform paths, not claims of verification. Unknown result shapes intentionally remain plain text or JSON. No package publication, version tag, or release workflow was performed.
