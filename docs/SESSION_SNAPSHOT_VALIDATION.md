# Read-only session snapshot validation

This record describes the feature worktree at handoff. Completed integrated checks and current limits are recorded in [Native parity validation](NATIVE_PARITY_VALIDATION.md). Counts and pending items below are historical, not current integration status.

This change extends the control foundation at `40ee22d6117812b032172fa3cabf14fff8b2e351`. It adds only the `session-location` action, its typed host adapter and regression tests. It does not add a general query endpoint, bridge mutation route, transcript response, UI reset, generation change, or resources-reloaded event.

## Passing checks

- `npm test` in `/tmp/pi-parity-worktrees/session-snapshot`: 52 test files passed; 458 tests passed, 3 skipped. The worktree uses the exact committed control foundation and the main locked dependency symlink. Node.js 26.8.2. Husky remains enabled.
- Snapshot regression cases verify the authoritative directory differs from the resumed file's parent, per-entry SHA-256 serialization matches expected bytes, no entry bodies enter the bounded response, malformed/wrong-token/unhandled results disconnect without replay, missing/shadowed commands reject before dispatch, and count/serialized-byte limits fail closed. No UI reset occurs.
- The combined auth-transfer worktree's public-SDK runner passed against an explicit installed Pi 1.3.0 executable. It opened a disposable external same-cwd JSONL session with the actual packaged command, required handled disposition, verified the canonical directory and active-entry digest against persisted data, and observed no `agent_start`. See `docs/AUTH_TRANSFER_VALIDATION.md` in the companion auth commit for the exact command and broader evidence.

The response is capped at 16 KiB. Entry hashing permits 50,000 entries and 32 MiB of serialized bytes, using `JSON.stringify(entry)` plus LF independently for each entry. The host caller must hold its foreground operation and revalidate source bytes, canonical paths, session/leaf identity and entry digest before transfer or upload. Same leaf identity alone is not sufficient.

## Integration and open checks

Apply this snapshot commit after the control foundation. Apply the companion auth/transfer commit with the native path resolver dependency; its runtime wrapper and transfer controller consume this adapter. Neither commit alone establishes end-to-end transfer capability.

Native minimum/current, untrusted, UI, alias, VSIX inspection and packaged UI checks remain delegated to main integration. Remote, Windows/macOS, live authorization, provider calls and uploads were not run. The check used disposable fixture data only; no real credential store or external service was changed.
