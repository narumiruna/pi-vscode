# Provider authentication and session transfer validation

This record describes the feature worktree at handoff.
Completed integrated checks are recorded as historical evidence in [Native parity validation](NATIVE_PARITY_VALIDATION.md).
For current guidance, see [requirements](../README.md#requirements), [development commands](DEVELOPMENT.md), and [security limits](SECURITY.md).
Counts and pending items below are historical, not current integration status.

## Contract

The supported reference at handoff was Pi 1.3.0, loaded from the configured executable through the public extension loader and public package root.
No installed SDK path is a runtime dependency.
The VS Code baseline at handoff was 1.106, with a Node workspace Extension Host and trusted file-backed workspace requirements.

The isolated helper handles built-in provider authentication and public SDK session import/export.
GitHub sharing uses the independent public `gh gist create --public=false --filename pi-session.jsonl -` CLI contract.
Radius sharing remains blocked: no public artifact-upload contract was established.
A non-public gist is link-readable, not confidential storage.

## Passing checks in the auth-transfer worktree

- Node.js 26.8.2; existing locked dependencies supplied through the main worktree's `node_modules` symlink.
  No dependency or installation changes.
- `npm test`: 56 test files passed; 487 tests passed, 3 skipped.
  Compilation and bundled browser assets passed.
  This includes helper protocol, fake authentication, transfer validation, command approval, retained import, stale history, same-leaf content mismatch, canonical session directory, and snapshot-query regressions.
- `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources`: passed with 514 warnings and 20 informational diagnostics; no errors.
  Existing warnings were not treated as passing clean lint.
- `npm run test:rich-content`: passed.
  Evidence: 72 layout cases, 4 image cases, 8 phases, four themes, keyboard checks, status announcements, rich rendering, and asynchronous lifecycle checks.
  These existing fixtures do not prove native auth/transfer dialogs.
- `node scripts/test-isolated-sdk.mjs /home/narumi/.bun/install/global/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`: passed against the explicit local reference only.
  Disposable directories and fixture data verified static provider discovery, active leaf `b` export excluding abandoned leaf `c`, complete-tree public runtime import with Pi initialization metadata, and unchanged source bytes through helper export/import.
  - The same command starts an isolated ordinary RPC process with the packaged control and independent read-only gate.
    After resuming an external same-cwd file, `getSessionDir()` differs from that file's parent.
    The read-only command returns a handled, bounded location/digest response.
    Its SHA-256 digest matches all parsed persisted entries, including abandoned branches.
    Active-leaf verification is separate from the entry digest.
    No `agent_start` occurred.
  - Source entry hashing uses `JSON.stringify(entry)` followed by LF for each entry, with at most 50,000 entries and 32 MiB of serialized bytes.
    The RPC response is at most 16 KiB and contains no entry bodies.
  - No real authentication, provider request, model call, upload, server, or external credential-store write was performed.
    A synthetic selected-store credential file remained unchanged during discovery.

## Dependency overlays and commit integration

Tests used the exact control foundation from `40ee22d6117812b032172fa3cabf14fff8b2e351`, plus the native path resolver series ending at `4358176`.
Temporary copies, `.control-overlay`, generated output, `node_modules`, and `.husky/_` are excluded from auth commits.
Husky remains enabled.

The auth commit contains only its narrow runtime import/history/snapshot wrappers, not a copied control foundation.
The separate snapshot commit changes the packaged control resource and adapter against the committed foundation.
Integrate both together after the control and native-resolver dependencies.
Reconcile shared manifest, sidebar, activation and native test registrations with the independent feature changes.
Do not replace those files wholesale.

## Required checks not run here

- Minimum/current native Extension Host, Restricted Mode, native UI, alias and packaged UI matrix: delegated to main integration, not claimed passed.
  `src/test/nativeAuthTransfer.ts` supplies deterministic command/helper fixtures, not complete native-dialog coverage.
- VSIX packaging and contents inspection: delegated to main integration, not run here.
- Windows, macOS, remote authorization, real browser/provider/device approval, actual credential synchronization and real uploads: not run.
  Fixture coverage does not establish all-provider native support.
- Thinking-picker and settings browser checks: not run; their implementation was not changed.

Provider-specific private configuration prompts can require Pi's own terminal UI.
No authentication terminal fallback is added by this change.
Cancellation and uncertain completion never replay authentication, session switching, or upload.
Retained import copies are not deleted as compensation.
Feature plans remain unchanged and open until the required integration checks pass or their support limits are explicitly accepted.
