# Thinking transcript validation

## Protocol and boundaries

The reference is the installed Pi 1.3.0 public `docs/json.md`, `docs/message-types.md`, `docs/rpc.md`, `docs/rpc-commands.md`, and the matching exported declarations. This is reference evidence, not a new Pi minimum or runtime dependency. No Pi package is imported into the Extension Host.

The implementation accepts indexed thinking start/delta/end events and authoritative assistant messages. It ignores malformed block updates and unknown fields. Missing thinking or signatures do not cause an error. Answer-only fixtures cover runtimes that expose no thinking. Redacted text and opaque signatures are not retained by the presentation adapter.

Thinking remains separate from answer extraction, prompt construction, images, and edit proposals. The shared retained transcript budget is 100 messages and 250,000 text characters. Stream maps retain at most 128 text/thinking blocks; history retains at most 128 thinking blocks per message. Thinking is memory-only in the extension and is recovered from Pi history, not VS Code workspace storage. Existing cached messages remain valid.

Assistant timestamps and occurrence numbers preserve disclosure identity through normal history replacement, including repeated timestamps. Missing timestamps use a temporary live ID; history replacement can reset that disclosure. Disclosure choices are not persisted. Content is plain text in native HTML disclosures, with the existing webview CSP unchanged.

## Executed checks

Local Linux checks used Node.js 26.8.2 and the shared, already-installed dependencies. No package installation, live provider, authentication, upload, or release operation ran.

| Command | Result |
| --- | --- |
| `npm test` | Passed: 51 files, 426 passed tests, 3 skipped tests. Compile includes host/browser TypeScript and bundled renderer assets. |
| `npm exec --offline --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed with zero errors; 471 warnings and 17 informational diagnostics. The offline option uses the existing pinned package cache. |
| `npm run test:rich-content` | Passed: existing interface/rich-content/CSP/lifecycle checks and new thinking browser fixtures. |
| `node --check scripts/fixtures/native-pi.cjs` | Passed. |
| `node --check scripts/fixtures/thinking.cjs` | Passed. |
| `node --check scripts/test-native-ui.mjs` | Passed. |
| `node --check scripts/test-rich-content.mjs` | Passed. |
| `node --check scripts/thinking-fixture.mjs` | Passed. |
| `git diff --check` | Passed. |

Unit fixtures cover multiple indexed blocks, authoritative end replacement, thinking-only and redacted responses, absent signatures, malformed/control/HTML/oversized content, character and block limits, tools, retry, abort, settlement, process exit, session changes, and stale history responses. An isolated Node subprocess runs the native Pi fixture and verifies history recovery in a replacement fixture process. This is not a VS Code Extension Host check.

Browser fixtures use the real sidebar document and bundled renderer with simulated VS Code IPC. They verify Enter/Space disclosure operation, four theme classes, 200-pixel panels, inert HTML-like thinking, signature exclusion, live disclosure/focus retention, off-bottom reading position, disconnected/connected state updates, and history replacement without duplication.

## Pending integration checks

The minimum and current VS Code native UI runs have not run on this branch. The shared native UI harness now includes thinking stream disclosures, authoritative history replacement, keyboard access, thinking-only/redacted content, and recovery after a real window reload with fixture history. Run these commands after integrating the other sidebar branches:

1. `xvfb-run -a npm run test:native-ui -- 1.106.0`
2. `xvfb-run -a npm run test:native-ui -- stable`

The thinking-level picker and settings page are unchanged, so their separate browser checks are not applicable. No VS Code API, trust, canonical-path, bridge, packaged resource path, or dependency contract changed. Alias, Restricted Mode, and packaged checks remain part of the integration owner's broader matrix where applicable.

Remote hosts, Windows/macOS UI, assistive technology, live providers, and packaged VSIX behavior are unverified here. No plan completion or platform support claim is based on these pending checks.

## Integration notes

`SidebarAssistantStream` owns one bounded assistant reconstruction. `sidebar.ts` handles only event ownership, message replacement, and synchronization generation checks. `sidebarState.ts` budgets thinking but excludes it from workspace persistence. `sidebarHtml.ts` adds disclosures through DOM APIs without changing the composer or thinking-level control.

Preserve indexed `contentIndex` values when merging event fixtures. The existing queued-delivery host fixture and native tool fixture now include that public field. Keep the thinking browser call in `test-rich-content.mjs` and the native thinking scenario at the end of `test-native-ui.mjs`; the native fixture writes only disposable fixture history. The feature plan and aggregate plan remain unchanged and open for the native integration evidence.
