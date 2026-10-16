# Pi identifier rename

## Goal

Replace active PiCode names with Pi names. This is an accepted breaking change for the new `narumi.narumi-pi` package. Keep its package and extension identities unchanged.

## Context

`package.json` contributes 21 `picode.*` commands and 11 settings. Runtime registrations, storage keys, virtual documents, bundled policy extensions, prompt markers, bridge variables, and tests still use the old name. `src/configuration.ts` also reads `piCodingAgent` settings. Historical global bridge cleanup must still recognize `picode.ts` and `pi-vscode.ts`.

## Plan

- [x] Inspect naming boundaries and confirm the breaking-change scope against the manifest, runtime, security documentation, and Git history.
- [x] Rename active identifiers to `pi.*`, internal symbols/assets to Pi/pi, and environment variables/prompt markers to `PI_VSCODE_*`. Remove old configuration and prompt-marker fallback readers. Preserve exact legacy cleanup filenames and historical documents.
- [x] Add regression coverage for current-only settings and prompt parsing; update README, feature matrix, security documentation, and a major changeset.
- [x] Run dependency installation, compile/unit tests, Biome checks, and applicable browser/native fixture checks. Evidence: `npm ci`; package suite (45 files, 388 tests); pre-commit suite after adding the Git hook isolation regression (45 files, 389 tests); Biome (zero errors, 435 warnings, 17 infos); both browser checks (including 49 thinking-picker cases); Linux VS Code 1.106.0 trusted/untrusted Extension Host checks; source and packaged native UI fixture checks. VSIX resource listing contains only current asset names. Remote, other platforms, stable VS Code, and live-provider checks were not run. Dependency installation reported two audit findings; dependency updates are outside this rename.
- [ ] Review the diff and remaining old-name matches, commit intended paths, push a `narumi/refactor/…` branch, and open a pull request.

## Validation discovery

The first pre-commit run exposed an existing release fixture that inherited hook `GIT_*` variables and wrote baseline commits to this branch. Reset only those local test commits with a mixed reset to the original base, preserving all working files. Commit `e7fcb5d` filters the fixture environment and adds a regression with invalid inherited Git paths. The enabled pre-commit hook then passed without changing the branch unexpectedly.

## Risks

Existing settings, custom keybindings, terminal bridge environments, and extension-owned cached state do not migrate. Persistent Pi session files remain separate; prompt extraction accepts only the new marker format. Authentication, trust, permission, read-only, Preview/Apply, and stale-content checks must remain unchanged.

## Rollback / Recovery

Revert the rename commit and reload VS Code to restore the old identifier contract. Do not delete old cached state or persistent Pi session files. Users must update settings, keybindings, bridge consumers, and terminal sessions when adopting the new contract.

## Completion Checklist

- [x] Active source and scripts use the new contract; remaining old names are limited to historical evidence, legacy cleanup, and rejection tests.
- [x] Required tests pass. Record the validation evidence and gaps above in the PR.
- [ ] The branch is pushed and the PR is open.

Delete this temporary plan only after all checks and PR handoff are complete.
