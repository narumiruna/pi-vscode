# Foreground Control Validation

This record describes the feature worktree at handoff.
Completed integrated checks are recorded as historical evidence in [Native parity validation](NATIVE_PARITY_VALIDATION.md).
For current guidance, see [requirements](../README.md#requirements), [development commands](DEVELOPMENT.md), and [security limits](SECURITY.md).
Counts and pending items below are historical, not current integration status.

## Checked contract

The external Pi reference is `@earendil-works/pi-coding-agent` 1.3.0.
The Extension Host does not import Pi or depend on a second runtime.
Runtime resources use public `ExtensionAPI`, `ExtensionCommandContext.reload()`, `navigateTree()`, read-only session APIs, and the documented input/UI protocols.
Public declaration and implementation discovery confirmed:

- Extension commands run before input handlers.
  A handled command does not require `agent_settled`.
- Command exceptions can produce `extension_error` with a successful handled response.
  Handled alone is insufficient.
- `get_commands` provides canonical resource-path ownership metadata.
  Missing, duplicate, and shadowed commands are not dispatched.
- An independent packaged input policy consumes the reserved control prefix when the command disappears.
  It does not send control data to a model.
- Pi 1.3.0 fork discovery and execution include abandoned user entries, despite the RPC reference's active-branch wording.
- Clone copies the selected active position.
  A null active leaf is rejected before mutation.
- Navigation of a user entry selects its parent and returns the user text for a draft.
  The packaged command requests no summary.
- Unsummarized navigation alone does not persist its selected leaf across process restart.
  Fork/clone create separate sessions.
- An empty Pi session has an assigned path but no saved header.
  Resource reload works without a model call.
  Pi can reopen that path, but its pre-save session ID is not durable.
  Ownership records bind an unsaved session to its path/root, and bind saved sessions to path/root plus ID.
- RPC does not transport arbitrary terminal components, renderer callbacks, terminal input, overlays, or Pi theme changes.
  This task explicitly accepts terminal fallback rather than a PTY or new component protocol.

Required ownership checks compare the actual client object, session ID/file, a transition generation, canonical workspace binding, trust, idle/queue/dialog state, and launch policy.
Native approval callbacks hold the canonical operation gate and revalidate after UI.
Branch Quick Picks hold the foreground owner for their full interaction.
Cold file/configuration operations use the same guard without starting Pi.

## Deterministic checks

Run from the control worktree with Node.js 26.8.2 and the main checkout's locked dependency symlink.
No dependency installation was performed.

1. `npm test`
   - Compiles host/browser code and builds renderer assets.
   - Passed: 51 files, 451 tests passed and 3 skipped.
     The commit hook reruns the complete suite.
   - Control tests cover discovery conflicts, handled/error/timeout/disconnect, missing-policy refresh, stale approval, busy/queue/dialog/trust/virtual guards, branch identity/cancellation, canonical lock retention, restart, and uncertain terminal cleanup.
2. `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources`
   - Passed: no errors, 474 warnings and 17 informational diagnostics.
     No global lint cleanup was performed.
3. `npm run test:rich-content`
   - Passed Chromium interface/rich-content fixtures: 72 layout cases, four image cases, eight foreground phases and four themes.
   - New checks verify local reload owns its alias, internal command metadata is not exposed as composer commands, and stale branch drafts cannot overwrite a newer draft.
4. `node scripts/test-pi-control-reference.mjs <installed-pi-1.3.0>/dist/cli.js`
   - Passed with an isolated temporary HOME, agent directory, working directory and session files, minimal environment, explicit offline mode, no discovered extensions/MCP, and no provider credentials.
   - Three reloads preserve session identity/history and expose one command per packaged control/bridge/policy resource without extension errors.
   - Fork accepts abandoned and first-turn user messages.
     Clone succeeds at a selected position and rejects a null leaf.
     Fixture history includes images, compaction and duplicate labels.
   - No-summary navigation moves the leaf, and a new process restores the persisted position rather than that temporary selection.
   - Missing-control input is handled by the independent policy.
     No `agent_start` or model call occurs.
   - A separate empty-session fixture confirms reload without a saved header and safe reopening of the assigned unsaved path with a new, non-durable ID.
   - Reference result: `reloads=3`, `forkAbandoned=true`, `firstTurnFork=true`, `clone=true`, `emptyCloneRejected=true`, `navigationDurableWithoutNewEntry=false`, `missingControlBlocked=true`, `modelCalls=0`.

The reference script requires an explicit external CLI path and checks its package version.
It is not a new installed runtime dependency or an automatic capability probe.

## Native and packaged checks still open at branch handoff

Native fixtures were extended, but were not run in this worktree:

- `nativePiControl.ts`: real native command registrations, trust, file URI/canonical ownership, dialog and busy guards using an inert client.
- Native UI fixture: repeated reload modals, clone, no-summary navigation, fork, draft preservation and separation from ordinary prompt records.
  Terminal handoff then reloads the Extension Host and asserts that no second RPC process starts until the fixture terminal is stopped and explicit Return is confirmed.
- Main integration must run minimum/current native host/UI, untrusted, alias, package inspection and packaged native UI variants after merging shared runtime/sidebar changes.

Remote, Windows/macOS terminal behavior, assistive technology, terminal descendant inspection, real provider requests, real MCP servers, and authentication were not tested.
No live model, authentication, upload, installation, release, or external service was used.
Terminal cleanup uncertainty remains an explicit inspection/ownership decision, not a passing descendant-termination claim.

## Integration notes

- Merge the editor agent's origin-bound pending-dialog registry in place of the temporary runtime Set.
  Keep `hasPendingExtensionDialogs` and invalidate dialogs before transitions.
- Merge the widget agent's `resetExtensionUi()` implementation.
  Reload/branch transitions call it before dispatch, never after new `session_start` UI is re-emitted.
- The shell agent can add public VERSION capability metadata to the existing permission/read-only discovery markers.
  Do not register duplicate markers or dispatch them as probes.
- Ownership metadata survives disposal and is restored before automatic startup.
  Unit reconstruction tests verify that Return confirmation is required and corrupt metadata does not resume an unknown session.
- Host methods at the original handoff: `initializeControlOwnership`, `withWorkspaceOperation`, `withForegroundOperation`, `reloadResources`, `restartResources`, `getSessionTree`, `chooseSessionBranch`, `branchSession`, `openInTerminal`, and `returnFromTerminal`.
  The internal restart method is now `restartSessionProcess`; the `pi.restartResources` command ID is unchanged.
  See [Pi terminology](PI_TERMINOLOGY.md).
- No plan files were changed or deleted.
  Required integrated checks remain open until their separate evidence exists.
