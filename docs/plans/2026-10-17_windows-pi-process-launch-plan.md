# Windows Pi Process Launch Repair Plan

## Goal

Make Windows Pi launches preserve argument data, use the actual child environment and working directory, and stop the owned process before reporting verified termination.

This is a follow-up to merged [PR #73](https://github.com/narumiruna/pi-vscode/pull/73). The implementation and local validation are complete. The evidence below distinguishes passing repair checks from existing full-suite failures and unverified environments.

## Baseline and evidence

- Reviewed head: `62d5f5c97ad2d42758d475ca7de3c60162b9d847`.
- Comparison merge base: `ec6dfe8465e7b0a96c18d28270164622fec91a89`.
- Merge commit and original planning baseline: `d263ed22bc5a2f0ea340463c181ea4c74dd5a623`.
- Implementation rebased onto `a58127a469a8013bf2b5ecd4817e11c1daac7f3c` after PR #75 merged during validation. Its new cleanup warning code and interface changes are preserved.
- The earlier review used isolated copies on Windows 10.0.26300.9711 with Node.js 26.6.0. A local `.cmd` wrapper launched a deterministic Node fixture; no provider prompt was required.
- Base shim launches failed with `spawn EINVAL`. Head shim launches succeeded.
- Head changed the argument `literal%PI_REVIEW_VALUE%` to `literalEXPANDED` when the variable contained `EXPANDED`.
- With the harmless variable value `" & echo PI_REVIEW_INJECTED & rem "`, head executed the additional `echo` command. This is command interpretation, not only display corruption.
- After head RPC `stop()`, the fixture process remained alive even though an expected `process_exit` event had been emitted. Direct Node launches stopped the fixture on both base and head.
- The earlier focused suite passed 15 tests. The full Windows suite compiled, but had 27 failures, 362 passes, and one skip. Failures included Windows permission and POSIX fixture assumptions. Do not treat that run as a clean Windows baseline.

The additional review identifies two more implementation defects. They are supported by the current code, but have not received native reproduction in this planning task:

- `PiRpcClient.start()` plans against the parent PATH before building the actual child environment. An override can select a different Pi installation, and an unset PATH can still influence resolution through the parent.
- `findWindowsExecutable()` searches every non-absolute input under PATH entries. A directory-qualified input such as `.\\tools\\pi.cmd` is not resolved against the launch `cwd`.

The additional percent-expansion report duplicates the first finding above. There are four distinct repair areas, including process cleanup.

## Scope

- `src/piSpawn.ts`: executable selection and launch strategy.
- `src/piRpcClient.ts`: final environment, launch integration, shutdown, and settlement events.
- `src/piClient.ts`: launch integration, cancellation, and error cleanup.
- `src/piProcess.ts`: shared bounded process ownership and cleanup.
- `src/backgroundAgents.ts`: retain shutdown warnings until cleanup settles and operation locks are released.
- `src/sidebarState.ts`: use a neutral cleanup-unverified notice that does not claim the root remained unresponsive after a confirmed exit.
- `src/test/piSpawn.test.ts`, `src/test/piRpcClient.test.ts`, and `src/test/piClient.test.ts`: regression coverage.
- `.github/workflows/ci.yml`: Windows coverage for the affected paths.
- `README.md`, `docs/FEATURE_MATRIX.md`, and `docs/SECURITY.md`: verified support and limitations.
- A patch changeset for the implemented repair. Leave version and changelog changes to the release workflow.

Do not change provider behavior, session formats, bridge authorization, permission gates, read-only gates, Preview/Apply checks, or webview behavior. Keep the minimum VS Code version and POSIX launch behavior unchanged. Do not add user settings or feature flags.

## Required contracts

### Child environment

Build one final environment before executable resolution. Pass that same environment to the planner and to `spawn()`.

- On Windows, merge and remove environment keys without case sensitivity.
  - An override named `PATH`, `Path`, or `path` replaces the inherited logical PATH value.
  - An unset entry removes every casing of that key after overrides are applied.
  - Emit one entry per logical environment key so Node does not select a different value from duplicate keys.
  - Do not restore the parent PATH when the child PATH is absent or empty.
- On POSIX, preserve case-sensitive environment behavior.
- Preserve `NO_COLOR` behavior and background bridge-variable removal.
- Define missing-PATH lookup behavior explicitly. Any Windows system-directory fallback must match the documented contract and have tests; it must not accidentally use the parent PATH.

### Executable resolution

Pass the actual launch `cwd` into resolution.

- Absolute paths are resolved directly.
- Directory-qualified relative paths, including `.\\tools\\pi.cmd` and `tools/pi.bat`, are resolved against `cwd`, not each PATH directory.
- Bare names search the final child PATH in directory order.
  - Preserve `.exe`, `.cmd`, then `.bat` preference within each directory.
  - Preserve an explicitly supplied extension.
  - Reject directories as executable candidates.
- Resolve relative PATH entries against the child `cwd`.
- Define behavior for quoted PATH entries and empty entries, with tests. Do not add an implicit workspace search unless explicitly documented and justified.
- Handle drive-relative and rooted-without-drive Windows paths deliberately. Either resolve them with a tested contract or reject them with a useful error; do not misclassify them as bare names.
- Preserve useful launch errors for missing files. Do not silently select a different installation after an explicit path fails.

The current setting documents an executable name or absolute path. If directory-qualified relative paths become supported, update the setting description and README to state that they are relative to the selected workspace launch directory.

### Arguments and shim execution

Arguments are data, not shell source. Quotes alone do not satisfy this contract.

1. Prefer direct `.exe` launches with an argument vector and `shell: false`.
2. Evaluate a shell-free path for supported npm Pi shims by resolving their Node executable and JavaScript entry point without executing or evaluating shim text.
   - Do not use the VS Code Extension Host `process.execPath` as an assumed standalone Node executable.
   - Preserve shim-specific arguments, environment, and runtime selection where support is claimed.
3. If a shell path is retained for other wrappers, require native round-trip and injection tests before adopting its escaping strategy.
   - Test the actual wrapper boundary, including `%*` forwarding, not only the initial `cmd.exe` command line.
   - Do not assume caret escaping, doubled percent signs, or a launch dependency solves every parser stage.
   - Reject unsupported argument or wrapper forms before execution if literal transport cannot be guaranteed. Report the limitation; never silently expand or alter the data.

Select the smallest strategy that meets the tested support contract. Do not implement a general batch-script interpreter. Do not add a dependency until its Windows behavior, maintenance cost, and packaged runtime impact have been checked.

Keep prompts, approved source context, and image payloads on stdin. Do not move them to process arguments, environment variables, or temporary command scripts as an escaping workaround.

### Process ownership and settlement

Both clients must retain ownership of the process they actually launch.

- For shell launches, killing only `cmd.exe` is insufficient.
- Select a bounded Windows process-tree ownership and termination mechanism before retaining shell support.
  - Account for the root exiting before descendants and for inherited open pipes.
  - Do not kill by executable name or use an unverified stale PID.
  - If using a tree-termination command, launch the trusted system executable without a shell and inspect its result. A successful command alone is not proof that every descendant stopped.
- Apply cleanup to RPC stop, startup failure, protocol failure, one-shot abort, stdin failure, and output-limit failure.
- Make repeated and concurrent stop requests idempotent.
- Preserve the existing POSIX process-group behavior.
- Keep cleanup bounded. Distinguish confirmed root exit from verified tree cleanup.
  - A deadline or an unverifiable descendant state must produce an explicit cleanup-unverified result or warning.
  - Release settlement waiters exactly once. Do not claim that all work stopped merely because the shell exited.
  - Preserve uncertain queue/checkpoint recovery and audit runtime operation-lock release when work may remain active.
- Close pipes, remove listeners and timers, and release handles on every terminal path.

## Implementation sequence

- [x] Add deterministic native Windows fixtures and capture failures on the merged baseline before changing runtime code.
- [x] Build and normalize the final child environment before planning. Test override and unset precedence, including mixed casing.
- [x] Add launch `cwd` to resolution and implement the executable-selection contract. Keep tightly coupled resolver code in `src/piSpawn.ts`.
- [x] Select and prove the shim strategy with real argument round trips and harmless injection probes. Remove the current string-only safety claim.
- [x] Select and prove Windows process ownership. Share cleanup code between clients only where it prevents different behavior for the same launch strategy.
- [x] Integrate launch and cleanup in both clients. Trace `process_exit` consumers in `src/piRuntime.ts` and background lifecycle code before changing event semantics.
- [x] Add Windows CI for the focused launch and lifecycle tests. Keep the existing Linux suite; do not hide unrelated Windows failures by disabling regression assertions.
- [x] Update security and support documentation and add a patch changeset after the implementation is verified.

Do not ship the shell-launch change separately from its ownership and argument protections.

## Regression matrix

| Area | Required cases | Observable result |
| --- | --- | --- |
| PATH | Parent installation A, child installation B; PATH removed; empty PATH; mixed key casing | Only the documented final-child lookup policy selects the executable |
| Paths | Absolute; directory-qualified relative; child cwd different from host cwd; relative PATH entry; spaces; Unicode; missing file; directory candidate | Correct target or explicit bounded launch failure |
| Candidates | `.exe`, `.cmd`, `.bat`; all three in one directory; earlier PATH directory with a shim and later directory with an exe | Directory order and per-directory extension preference remain stable |
| Arguments | Empty string; spaces; quotes; trailing backslashes; `%TEMP%`; undefined `%NAME%`; `!NAME!`; `^ & | < > ( )`; Unicode; supported multiline values | Fixture receives exactly the original argument array, or unsupported input is rejected before execution |
| Injection | Variable expansion containing quotes and a harmless `echo` marker; literal command separators | Marker does not execute; argument data is unchanged or rejected |
| Callers | One-shot model/provider options; RPC extension/session paths and system argument; npm-style `%*` wrapper | Both clients use the same verified transport rules |
| Cleanup | Active RPC stop; concurrent stop; early shell exit; startup error; protocol error; abort; output cap; stdin failure | Owned processes terminate, or cleanup uncertainty is explicitly reported within a deadline |
| Descendants | Wrapper launches a fixture that keeps work active after stdin EOF; fixture launches a descendant that holds a pipe open | No false verified-cleanup result and no hanging test |
| Preserved behavior | POSIX argument vector and groups; background bridge variables; stdin prompts | Existing contracts remain unchanged |

Each native fixture must use disposable files, fixed harmless input, and owned processes only. Record process identities and clean them in `finally` blocks, including assertion failures. Do not invoke an installed Pi binary, provider, user extension, VS Code window, or installation script.

Use JSON output to compare received argv exactly. Observe process liveness independently from client state and shell exit. A test that checks only `isRunning === false` is insufficient. Distinguish the fixture process, its descendants, and the wrapper process in assertions.

## Validation and release gate

Use Node.js 22.19 or newer. Compile before selecting emitted test files:

```bash
npm ci
npm run compile
npm exec -- vitest run out/test/piSpawn.test.js out/test/piClient.test.js out/test/piRpcClient.test.js
npm test
npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources
```

- Run the focused tests on native Windows and Linux. A simulated `platform: "win32"` test on Linux is not Windows execution evidence.
- Record OS, Node.js version, commands, fixture inputs, exit events, argument output, cleanup observations, and timing bounds.
- Compare baseline and repair in isolated copies when confirming regressions. Remove the copies afterward.
- Investigate full-suite failures separately and state which remain unrelated or unresolved. Do not describe a partial Windows pass as a full pass.
- Run isolated Extension Host checks on minimum VS Code 1.106.0 and current stable before claiming native extension integration support. On headless Linux, use `xvfb-run -a`.
- If adding runtime assets or a dependency, run `npm run package` and inspect the VSIX contents. Do not install it into the user's profile.
- Report browser, remote, live-provider, and platform checks separately. No live-provider validation is required for this repair.

Completion requires all four repair areas to have passing regression evidence. Update `docs/SECURITY.md` to describe the actual launch boundary; its current unconditional `shell: false` statement does not match the merged implementation. Document any retained wrapper or descendant-cleanup limitations without claiming universal batch compatibility or filesystem-wide containment.

If rollout fails, do not restore the known unsafe shell path. Prefer a targeted correction or an explicit launch error with instructions to use a verified executable path. Publishing and external release actions require separate approval.

## Implementation decision

All supported Windows launches now use `shell: false`. The resolver recognizes the entire standard npm Node shim template, without custom shebang arguments or environment assignments, and starts its adjacent or child-PATH `node.exe` with the script and original arguments. Other batch forms fail before execution. Native executables remain direct launches.

No Windows shell or general batch interpreter is retained, so a Windows shell process-tree termination mechanism is not needed for wrapper ownership. The actual runtime is the owned child. Windows descendant containment is not claimed: cleanup emits an explicit warning even when the root exits normally. POSIX uses a detached process group. Cleanup waits at most one second for graceful root exit and one further second for pipe closure after forced termination.

RPC exit settlement is emitted once, after bounded cleanup. Reentrant restart during stop is rejected. Unexpected-exit classification is captured at root exit, and old-generation events cannot affect a replacement process. The cleanup warning retains the current base's `cleanup-unverified` code, with a neutral summary that does not misreport a confirmed root exit as an unresponsive process. Foreground queue/checkpoint disconnect recovery is preserved. Background subscriptions remain active through stop so cleanup warnings reach task output before the operation lock is released.

## Verification evidence

### Baseline

A deterministic npm-style shim fixture reproduced argument expansion, harmless injected `echo` execution, and a surviving runtime after RPC stop on merged baseline `d263ed2`. The same harness showed that the parent and child PATH plans selected different targets, that mixed-case unset left duplicate PATH values, and that a directory-qualified relative shim fell through to `shell: false` without resolution.

The harness never executed the installed Pi binary. Fixture processes and temporary baseline copies were removed after verification.

### Repair

| Check | Environment | Result |
| --- | --- | --- |
| Native Windows launch and lifecycle suite | Windows 10.0.26300.9711, Node.js 22.23.3 and 26.6.0 | 35 tests passed across four files; actual argv, stdin, executable identity, root liveness, bounded uncertainty, and restart guards verified |
| Full unit/process suite | WSL Linux, Node.js 22.23.3 | 412 passed, three Windows-only tests skipped, 49 files passed |
| Formatting and lint | Documented Biome 2.5.13 command | Exit 0; existing repository warnings remain |
| Minimum Extension Host smoke | Linux under Xvfb, VS Code 1.106.0 | Passed; trust-preserving host, bridge, settings, edit/Undo, semantic, and encoding checks |
| Current Extension Host smoke | Linux under Xvfb, VS Code 1.142.0 | Passed with the same isolated fixture checks |
| VSIX | `npm run package` | Passed; inspected the 139-file archive and confirmed both clients, resolver, and new process owner are present |
| Existing npm installation template | Windows, planner only | Recognized the installed npm shim as a shell-free Node/script plan; Pi was not started |

Native Windows checks compile first, then run:

```bash
npm exec -- vitest run out/test/piSpawn.test.js out/test/piClient.test.js out/test/piRpcClient.test.js out/test/piProcess.test.js
```

Linux validation used `npm ci`, `npm test`, the documented Biome command, and `npm run package`. Extension Host validation compiled first, then ran `xvfb-run -a node scripts/test-native.mjs 1.106.0` and the same command with `stable`. All fixtures used disposable profiles or temporary directories.

### Existing failures and limits

- Full Windows suite on Node.js 26.6.0 after rebase: 392 passed, 22 failed, one skipped. The unchanged original baseline reproduced the same 21 platform/permission failures and the intermittent semantic-bridge timeout. Earlier repair runs passed that timeout case; it recurred in the final full run. Failures include symlink permissions, POSIX-only filenames and path assertions, line endings, and shell-based installer fixtures. The full Windows runs used a restricted PATH with Node, Git, and system tools to prevent fallback to an installed editor or Pi command.
- Linux Node.js 22.22.0: the configured Windows-1252 diagnostic test fails on both the unchanged baseline and the repair. That runtime decodes byte `0x80` differently from the fixture expectation. The final suite passes on Node.js 22.23.3; no unrelated encoding code was changed.
- Browser and remote workflows were not run because their implementation was unchanged. Native Windows Extension Host and packaged-install behavior were not tested; Windows evidence is from real Node process fixtures, not a simulated platform flag.
- No live provider, package publication, version tag, installed-extension replacement, or release workflow dispatch was used.
- Custom wrappers remain unsupported. Windows cleanup warnings are conservative and do not prove that tool descendants stopped. This limitation is documented rather than hidden by a shell-exit success signal.
