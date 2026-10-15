# PR #60 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/60

## Evidence and scope

The checkout remote is `git@github.com:narumiruna/pi-vscode.git`. PR #60 is open on `narumi/fix/pr-57-math-review`, based on `main`. Reviewed commit: `c8ceafecac97d2086205040ca6446df6163bd301`.

The description, sole commit, complete three-file diff, checks, submitted review, inline comments, conversation, and both review threads were read. REST lists were paginated. GraphQL reports no further thread or comment pages. The review and conversation summaries contain no separate request. The original `Compile and test` check passed.

No applicable `AGENTS.md` was found. The extension skill and its security and testing guides were read. The minimum VS Code version stays at 1.106.0. These changes affect Markdown parsing for the chat webview. No manifest, API, host, trust, CSP, RPC, or storage change is needed. The existing pending patch Changeset covers these corrections.

## R1: Compact per-unit prices

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286232924
Thread: `PRRT_kwDOUAKqMc6s5CuC`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Markdown after an unmatched price becomes literal source.
- Evidence: the new streaming regression fails against the unchanged parser. `Price is $5 /month and **flexible*` produces literal markers instead of `*<em>flexible</em>`. PR #60 adds unrestricted `/` to the numeric math-prefix test.
- Scope: this directly regresses the price behavior that PR #60 says it preserves.
- Required fix: compact multi-letter operands need more math evidence. Keep single-symbol, numeric, parenthesized, TeX, and operator-backed division expressions as pending source.
- Tests: three price formats, four unit names, five Markdown suffixes at every streaming prefix, and pending and closed division expressions.

## R2: Signed numeric inequalities

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286232933
Thread: `PRRT_kwDOUAKqMc6s5CuH`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Markdown changes the visible source of an incomplete formula.
- Evidence: the new regression fails against the unchanged parser. `$-2 < [x](mailto:x@y)` becomes an active link. The new `^\d` check rejects the negative numeric prefix. Closed numeric inequalities still render with KaTeX.
- Scope: PR #60 adds the numeric-prefix restriction when fixing shell redirection. Signed numbers need the same protection as positive numbers.
- Required fix: permit an optional leading sign in the inequality numeric-prefix check. Keep the shell redirection tests.
- Tests: signed integers, decimals, and factorials; six inequality operators; five Markdown suffixes; closed formulas.

## Other evidence

Installation reports two development dependency advisories. The manifest and lockfile are unchanged. These reports do not show a defect caused by PR #60. Dependency maintenance is outside this parser review. Use a separate dependency PR; none was created.

## Validation and disposition

R1 and R2 are implemented and validated. Both new tests failed before the production changes. All 22 Markdown tests pass after the fixes. The original division, price, shell redirection, and inequality tests still pass.

- `npm run package`: 372 tests across 44 files passed. VSIX creation passed with 130 files.
- `npm run test:rich-content`: browser rendering and lifecycle checks passed.
- `unzip -t pi.vsix`: passed. The packaged parser contains the updated slash and signed-prefix checks. Renderer assets, fonts, and licenses are present.
- Focused Biome check: passed, with six existing informational template-literal suggestions outside the changes. No automatic edits were applied.
- `git diff --check`: passed.
- `npm audit --omit=dev`: zero vulnerabilities. Development dependency maintenance remains deferred as stated above.

No clarification or code blocker remains. Native UI, remote hosts, Windows/macOS, live providers, and screen-reader applications were not tested. No Marketplace release was run.

The fixes were pushed as `4581b94`. Both threads received evidence replies and were resolved through the API. The repeat query confirms these states.

## Repeat review of `4581b94`

The current branch identifies PR #60. The remote still matches its repository. The description, two commits, checks, reviews, inline comments, conversation, and all six threads were refreshed. REST lists were paginated. GraphQL reports no further thread or comment pages. The complete diff and instructions from the prior pass are unchanged. The only new feedback is the four items below. CI passed for `4581b94`.

R1 and R2 are already addressed, P2. Their source, tests, replies, and resolved states are unchanged. No duplicate replies are needed. The dependency deferral also remains unchanged.

### R3: Single-letter price units

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286571959
Thread: `PRRT_kwDOUAKqMc6s52Nq`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Markdown after a price becomes literal.
- Evidence: the base parser at `8f8b442` renders emphasis after `$5 /h`; `4581b94` keeps the markers literal. The expanded streaming test fails before the fix.
- Scope: the single-letter slash alternative was added by this PR. Preserving price Markdown is an explicit PR goal.
- Fix: require a clear math continuation after alphabetic divisors of any length. Test `h`, `s`, `m`, and `g` at each Markdown streaming prefix.

### R4: Other operators after word divisors

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286571969
Thread: `PRRT_kwDOUAKqMc6s52Nx`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Markdown changes incomplete formula source.
- Evidence: the new test fails for `$2 /velocity \\times [y](mailto:x@y)`. Both the base and `4581b94` render a link. The PR slash lookahead permits only `[=+^<>]` after a word divisor.
- Scope: although the base has this case, fixing compact numeric division is the original PR goal. Supporting other clear math operators is required to complete that fix and keep the R3 disambiguation consistent.
- Fix: use the existing clear operator forms after word divisors, including TeX commands and spaced `*`, `/`, and `-`. Test single-letter and word divisors, four numeric prefixes, nine operators, five Markdown suffixes, and closed formulas.

### R5: Leading-decimal inequalities

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286571981
Thread: `PRRT_kwDOUAKqMc6s52N6`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Markdown changes incomplete formula source.
- Evidence: the base retains `$.5 < [x](mailto:x@y)` as source. `4581b94` renders a link. The new regression fails before the fix. The numeric inequality check requires a digit directly after the sign.
- Scope: this is a regression from the numeric-prefix restriction added by this PR.
- Fix: allow a leading decimal point before a digit. Test `.5`, `-.5`, and `+.5`, six inequality operators, five Markdown suffixes, and closed formulas.

### R6: Shell positional parameters

Source: https://github.com/narumiruna/pi-vscode/pull/60#discussion_r4286571991
Thread: `PRRT_kwDOUAKqMc6s52OA`.

- Outcome: Valid but out of scope — deferred.
- Severity: P2. Inline code stays literal after a positional parameter and redirection.
- Evidence: independent bundles of the base parser at `8f8b442` and the head parser at `4581b94` both render `echo $2 > ` followed by backticked `output` as `<p>echo $2 &gt; ` followed by literal backticks and `output`. The PR does not change this result. Both versions accept the same numeric inequality prefix in this case.
- Scope: this is a pre-existing ambiguity between positional parameters and numeric math. The PR fixes the regression for named shell variables and preserves numeric inequalities. A command-context parser is not needed for those fixes. No new evidence shows that this PR introduces, exposes, or worsens the positional-parameter case.
- Recommended follow-up: use a separate issue or PR to define command-context rules and test positional parameters against numeric inequalities. None was created. No code change is made for R6.

### Repeat validation and publication

R3, R4, and R5 are implemented and validated. All three regressions failed against unchanged production code. All 24 focused Markdown tests now pass. R6 remains a settled out-of-scope deferral. No clarification is needed.

- `npm run package`: 374 tests across 44 files passed. VSIX creation passed with 130 files.
- `npm run test:rich-content`: browser rendering and lifecycle checks passed.
- `unzip -t pi.vsix`: passed. The packaged parser contains both updated checks.
- Focused Biome check: passed with the same six existing informational suggestions.
- `git diff --check`: passed.

The dependency files and renderer assets are unchanged. The earlier production audit result is reused. Native UI, remote hosts, Windows/macOS, live providers, and screen-reader applications were not rerun. No Marketplace release was run.

PR #60 is still open at `4581b94`. The fixes use its existing branch. The evidence replies record the published commit. Resolve R3 through R5 after the push and R6 after the deferral reply. Verify all thread states through the API. No publication blocker is known.
