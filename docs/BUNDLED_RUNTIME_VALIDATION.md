# Bundled runtime validation

This record retains the evidence and external handoff for the completed `docs/plans/2026-10-22_bundled-pi-runtime-plan.md`.
The completed plan was removed after the local acceptance checks passed.

## Contract and evidence status

The default runtime is the exact production dependency `@earendil-works/pi-coding-agent@1.3.0`.
An unset, empty, or whitespace-only `pi.executablePath` selects it; a nonempty value, including saved `pi`, selects external Pi without configuration rewrites.
Reset removes only the chosen target override and selection uses the resulting effective value.
The workspace Extension Host's `process.execPath` starts an absolute pinned npm `dist/bundle/cli.js` entry through `resources/pi-runtime-bootstrap.cjs`.
Desktop Electron receives `ELECTRON_RUN_AS_NODE=1` only for entry; the bootstrap removes it before Pi and its tools run.
Bundled launches suppress automatic version checks, clear `PI_PACKAGE_DIR` and `PI_MANAGED_INSTALL_ROOT`, and reject initial CLI `update` before upstream import, including a configured `npmCommand`.
Pi 1.3.0 has no built-in TUI `/update` route.
Extension releases own bundled updates.
External Pi behavior and ordinary terminals are unchanged.

Ordinary launches reuse user configuration, credentials, provider environment, resources and sessions without migration or a separate store.
Isolated helpers retain disposable stores and their environment allowlist.
Missing or invalid assets fail without PATH fallback, replacement sessions or automatic replay.
Settings opening does not start or validate Pi.
Trust, permissions, read-only policy, Preview/Apply, stale-content checks, credential separation and process ownership remain required.
See [Runtime selection and recovery](USER_GUIDE.md#runtime-selection-and-recovery) and [Security](SECURITY.md#runtime-selection-and-update-ownership).

The evidence below separates pre-change discovery from final implementation checks.
Pending results are not passing evidence.
No universal-platform, remote, or live-provider validation is claimed.

## Baseline

Before bundled-runtime edits, `TMPDIR=/private/tmp npm test -- --maxWorkers=1` passed 1,417 tests with 3 skipped across 95 test files.
This baseline does not validate the new implementation or archive.
Final `npm ci`, regression, browser, packaging and native results must be recorded separately.

## Production dependency discovery

The full discovery report was read at `/private/tmp/pi-runtime-1.3.0-discovery.pSu7cD/DISCOVERY.md`.
Its temporary artifacts are supporting local evidence, not a permanent release dependency.
The stage used Node.js 26.5.0 and npm 11.17.0 on macOS arm64.
It did not test the minimum Node.js runtime or a native Extension Host.

The npm package requires Node.js 22.19 or newer.
Its CLI is `dist/bundle/cli.js`; its public ESM root is `dist/index.js`, with a separate `./rpc-entry` export.
The 118-package production lock had no OS/CPU pruning metadata.
A separate normal `npm ci --offline --omit=dev --no-audit --no-fund --foreground-scripts` stage produced 14,985 regular files byte-identical to the ignore-scripts discovery tree.
This is staging evidence, not a clean checkout install result.

Discovery commands included:

```sh
# Disposable production stage, not the repository or a global install.
npm install --omit=dev --ignore-scripts --no-audit --no-fund
# Separate disposable stage using the same staged package.json and package-lock.json.
npm ci --offline --omit=dev --no-audit --no-fund --foreground-scripts
node /private/tmp/pi-runtime-1.3.0-discovery.pSu7cD/smoke.mjs
```

The smoke harness launched absolute Node/CLI paths with empty PATH, disposable HOME/agent/session/workspace directories, offline flags, no inherited credentials, and a test-only network guard.
No guarded network attempt occurred.
It loaded the bridge, read-only gate, control extension and isolated helper from the staged closure outside the checkout.
Canonical command ownership, idle RPC state, harmless direct-shell `printf`, static provider discovery, and clean RPC/helper shutdown passed.
Static discovery returned 42 provider metadata entries without login or provider validation.
Public root import exposed 157 runtime exports.
This did not prove authenticated native bridge operation, complete terminal handoff, branch transfer, or all user-installed extensions.

Direct asset checks passed for bundled image-worker Photon WASM resizing, QuickJS default and bundled codemode workers, and loading the macOS arm64 native addon.
No native clipboard read/write or user input was requested.
The stage included the following required assets:

1. Bundled CLI/RPC entries, lazy chunks, image and codemode workers, and public export entries.
2. Unbundled image utilities and the public codemode worker.
3. Photon WASM and QuickJS WASM with adjacent loaders.
4. Pi themes, interactive images, HTML export templates and embedded vendor assets.
5. Six Pi TUI native prebuilds: Linux, Windows and macOS, each arm64 and x64.
6. Provider catalogs/data, schemas and the complete production dependency closure.

Native prebuild presence is not execution evidence for its target.
Linux's native addon requires `libxcb.so.1`; Wayland clipboard paths can require external commands such as `wl-paste`.
No claim is made that all tool, clipboard, or shell dependencies are bundled.

The unpruned discovery ZIP was 32,191,249 bytes (30.70 MiB), from 111,451,785 regular-file bytes (106.3 MiB).
The earlier rough combined estimate was 33.3 MiB, not a measured final VSIX size.
Record the actual packaged archive measurement before release.

## Distribution and license disposition

The selected layout is one universal VSIX with the pinned production dependency closure and all six native prebuilds.
The unused `examples/extensions/doom-overlay` tree is excluded because its embedded Doom WASM has GPL obligations not satisfied by the npm tree.
This exclusion does not remove required runtime assets.
Supplemental third-party notices are packaged under `resources/runtime-licenses`; dependency-provided notices must remain in the archive.
Exact-source license correspondence, supplemental coverage and archive inclusion passed the extracted-artifact check.
The source references and coverage are recorded in `resources/runtime-licenses/README.md`.
Npm license metadata alone does not cover embedded vendor files.
Discovery identified missing Pi package root notices, embedded marked 18.0.5/highlight.js 11.9.0 notices, and missing notices for proxy-agent-negotiate, standardwebhooks and three AWS SDK packages.
The discovery list is not legal approval or a vulnerability audit.
Pi's `v1.3.0` tag resolves to `71023aec1546d6d677a65669c5665c0927ce0dd0`; its root MIT text is included with the vendor and missing-dependency supplements.
All 118 production packages have shipped notices or documented supplements; the unused Doom example is absent.
The final VSIX contains 15,159 files and is 34,504,716 bytes (32.91 MiB).
Its SHA-256 is `1c2cff7ed88e85191484f3bb054dc5c937b2c0355a97b687f88b046837af10c1`.
`npm audit --omit=dev --json` reported zero vulnerabilities.
The full development install reported three advisories in `launch-editor`, `qs`, and `shell-quote`; these packages are not in the production closure.
No automatic dependency fix or legal approval is claimed.

## Host-runtime discovery and environment correction

Prior disposable native probes passed on macOS arm64 with these actual runtimes:

| Requested VS Code | Actual VS Code | Electron | Node.js | Probe result |
| --- | --- | --- | --- | --- |
| `1.140.0` | 1.140.0 | 43.7.3 | 24.21.0 | Version, RPC, TUI, workers and cleanup bootstrap passed. |
| `stable` | 1.143.0 | 43.7.7 | 24.21.0 | Version, RPC, TUI, workers and cleanup bootstrap passed. |

These are launch-strategy probes, not final production activation or extracted-artifact acceptance results.
The raw environment probe found `ELECTRON_RUN_AS_NODE=1` leaking into a shell child.
The selected bootstrap removes it before upstream import; final regression and native checks must confirm the correction.
`PI_SKIP_VERSION_CHECK=1` remains inherited by descendants and is not a network sandbox.
No model call or provider login was required.

An earlier GUI probe with temporary HOME triggered a macOS login Keychain prompt.
It was stopped without a Keychain reset or repair command.
The new runner preserves real GUI HOME while isolating Pi stores and VS Code profiles.
Before GUI launch, it verifies the installed build's `--use-inmemory-secretstorage` flag and encryption-service bypass, and disables built-in authentication/Copilot extensions.
Stop on any credential-store prompt; do not reset or repair the user's Keychain for validation.
All four final safer-runner checks passed with GUI and Extension Host HOME unchanged, disposable Pi stores, and no credential prompt observed.
No owned native test processes remained afterward.
Minimum-version evidence is retained at `/private/tmp/pi-bundled-native-h6nnos` (trusted) and `/private/tmp/pi-bundled-native-H7u3Kz` (Restricted Mode).
Stable evidence is retained at `/private/tmp/pi-bundled-native-1poVWW` (trusted) and `/private/tmp/pi-bundled-native-4O8h3N` (Restricted Mode).
These temporary paths support the recorded results; they are not runtime or release dependencies.

The trusted checks used real RPC, direct shell, static helper discovery (42 providers), canonical policy ownership, and a seeded disposable persistent session.
Confirmed restart retained the session ID/path.
Actual native TUI handoff stopped RPC before terminal construction; sidebar startup was blocked until the terminal PID exited and ownership returned explicitly.
An actual explicit external wrapper launch and reset back to bundled Pi retained that same session.
Restricted Mode rejected process launch and shell dispatch before any Pi session-start event.
No model or login request was made.

The earlier minimum-host worker probe also launched standalone Electron 43.7.3 through Pi's real bash tool after bootstrap cleanup.
It reported `app: true`, no `ELECTRON_RUN_AS_NODE`, and exit 0.
The stable worker probe passed image/QuickJS assets; its earlier VS Code-helper-as-GUI experiment trapped and is not a passing generic Electron result.

## Final implementation gates

Run build-based commands sequentially.
Use local Playwright Chromium for the Settings check.
No command below installs into an existing profile, publishes a package, calls a provider/model, or logs in.

| Gate | Command | Current retained result |
| --- | --- | --- |
| Locked checkout install | `npm ci` | Passed with Node.js 26.5.0 / npm 11.17.0; production resolution matches staging. |
| Full regression | `TMPDIR=/private/tmp npm test -- --maxWorkers=1` | Passed: 99 files, 1,466 tests, 3 skipped. |
| Formatting/lint | `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` | Passed: no errors; 973 warnings and 24 information diagnostics. |
| Settings browser | `npm run test:settings` | Passed with local Playwright Chromium, including executable reset and saved overrides. |
| Package and extracted smoke | `TMPDIR=/private/tmp npm run package` | Passed, including the default four-worker full suite and offline artifact smoke. |
| Same-artifact smoke rerun | `TMPDIR=/private/tmp npm run test:bundled-runtime` | Passed against the exact hash recorded above. |
| Minimum native trusted | `TMPDIR=/private/tmp node scripts/test-bundled-native.mjs 1.140.0` | Passed: VS Code 1.140.0 / Electron 43.7.3 / Node.js 24.21.0, macOS arm64. |
| Current native trusted | `TMPDIR=/private/tmp node scripts/test-bundled-native.mjs stable` | Passed: VS Code 1.143.0 / Electron 43.7.7 / Node.js 24.21.0, macOS arm64. |
| Minimum native Restricted Mode | `TMPDIR=/private/tmp node scripts/test-bundled-native.mjs 1.140.0 untrusted` | Passed; no Pi process launched. |
| Current native Restricted Mode | `TMPDIR=/private/tmp node scripts/test-bundled-native.mjs stable untrusted` | Passed; no Pi process launched. |

On headless Linux, prefix native commands with `xvfb-run -a`.
The extracted smoke must use the actual archive outside the checkout and test version/RPC shutdown, policy ownership, helper discovery, active-branch export/import, required assets and harmless direct shell without global Pi/Node lookup.
It must also verify updater refusal with custom `npmCommand` and conflicting package/managed-install variables, child environment cleanup, and missing-asset failure without fallback.
Native production checks must cover startup/restart, helper and policy loading, controlled terminal handoff/recovery, explicit external override and Restricted Mode without model requests.
Record actual versions, commands, evidence paths, failures and corrections; do not replace failed evidence with an unexplained pass.
Browser rich-content and thinking-picker checks were not run because their renderers and controls did not change.
The Settings browser check is separate and passed.

### Observed failures and corrections

Early full-suite attempts exposed legacy mock contexts that omitted the extension installation root or assumed the old external default.
One attempt reached the 300-second command deadline; a later run reported five remaining activation/workflow fixture failures.
The fixtures now supply normal activation ownership or explicitly select external Pi when testing legacy external fallback.
The final full suite and package suite passed without waiving a failing test.
The implementation was rebased onto `efcfea4`, which adds the scoped Pi configuration form.
The shared native file access now uses passive launch-settings reads, preserving form opening without runtime validation.
A regression verifies native form reads with missing packaged assets; the expanded Settings browser fixture and all final gates passed after the rebase.

Independent review found installation-root aliases rejected by a lexical bootstrap path comparison and an external-to-bundled setting change that could create a fresh fallback session.
The resolver now emits canonical installation paths; startup refuses fallback after any launch-policy change.
Regression tests cover aliases/junctions, both runtime-selection transitions, unchanged external recovery, and preserved saved-session pointers.

The first extracted smoke used CommonJS resolution for import-only public exports and failed.
It now reads each public ESM entry from the extracted package's export metadata.
Sequential extraction also exceeded an early command deadline; bounded parallel extraction/snapshot reads and a whole-run deadline replace that implementation.
Malformed and oversized child output rejects through the smoke cleanup path, which kills and waits for its known live roots with a bounded deadline.
The outer verifier owns a POSIX process group and uses an absolute Windows tree-cleanup command for deadlines and interruption.
Windows or escaped-descendant cleanup remains unverified; no general descendant-termination guarantee is made.

Negative artifact checks replaced only the CLI in disposable archive copies with malformed-RPC and hanging-version fixtures.
Both checks failed as required and their owned Pi PIDs exited.
The command was `node /private/tmp/pi-bundled-smoke-failures.mjs`; retained local results are `/private/tmp/pi-smoke-negative-KUUP6Y/results.json`.
No malformed archive or binary fixture is committed.

The final extracted smoke passed exact version, public imports, RPC initialization/shutdown, command ownership, real read-only denial, helper discovery, branch export/import, required workers/WASM/native assets, harmless shell, updater refusal and missing-asset rejection.
It recorded zero guarded network attempts or model/login/live-MCP calls and unchanged extension, credentials, source and source-session bytes.
Release publication now waits for three-platform same-artifact verification; GitHub release creation and Marketplace publication remain separate jobs so a failed Marketplace retry does not recreate the release.

## Release gates and external handoff

Release readiness requires passing mandatory local gates and a recorded resolution for distribution/runtime unknowns.
Do not waive an unknown or infer a passing result from asset inclusion.
Do not release an artifact known to omit a supported target's required assets.
Unavailable external checks restrict support claims and require retained ownership and expected results.
No publication or external-system write is authorized by this document.

1. Platform maintainer: Linux, Windows, x64 and remaining OS/architecture combinations are unverified for the real bundled runtime.
   Use the packaged artifact with disposable profiles on each target.
   Verify no-global-Pi/no-global-Node startup, native/worker/WASM assets, helper loading, child environment, updater refusal, bounded shutdown and controlled terminal recovery.
   Expect no fallback, leaked Electron bootstrap flag, or second session writer.
   Windows external npm shims and descendant-cleanup limits still require platform-specific checks.
2. Remote maintainer: Remote SSH, WSL and container execution are unverified.
   Use authorized remote hosts and disposable profiles with the artifact installed on the workspace Extension Host.
   Verify host-local package/store resolution, startup without remote Pi/Node lookup, provider environment preservation, helper isolation and terminal ownership return.
   Expect no use of a local UI installation or local UI user store.
   Desktop results do not establish remote support.
3. Release maintainer: remote CI results and the recorded archive contents, size and license coverage require review.
   Confirm pinned dependency/lockfile, all required assets, excluded Doom example, supplemental notices and same-artifact smoke before publication through the existing workflow.
   Runtime updates belong to extension releases, not Pi's updater.
   Resolve compatibility and distribution defects before publishing rather than silently waiving them.
4. Provider/account owner: live-provider requests, login, OAuth and live MCP services are unverified and need separate authorization.
   No provider/model/login call is authorized for this work.
   If later authorized, use disposable credentials and a minimal request without exposing secrets.
   Offline metadata discovery is not live-provider compatibility evidence.

For recovery, explicitly choose compatible external Pi and use the existing confirmed restart flow only after resolving cleanup and terminal ownership.
Never replay uncertain work automatically or reset user settings, credentials or sessions as a repair step.
An extension downgrade is not a shared-store/session-format rollback.
