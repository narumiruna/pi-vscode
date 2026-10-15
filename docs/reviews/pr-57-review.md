# PR #57 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/57
Reviewed head: `436a3c5952e43a8c22ef2d12ab34ee4c4c09f1b3`.
Goal: bound escaped math delimiter scans and preserve Markdown after currency.

## Evidence and instructions

The current branch and remote identify PR #57 in `narumiruna/pi-vscode`. The PR is open. Its description, commit, complete diff, checks, reviews, inline comments, and conversation were read. REST lists were paginated. GraphQL reports no further thread or comment pages. There are two findings. The review summary contains no separate request. The existing CI check passed.

No applicable `AGENTS.md` exists. The VS Code extension skill and relevant security and testing guides are unchanged from the prior review. The extension still uses the Node workspace host and VS Code 1.106.0 minimum. No host, trust, CSP, RPC, or storage change is needed.

The checkout has unrelated uncommitted changes in `src/sidebarHtml.ts` and `src/test/sidebarHtml.test.ts`. Work uses an isolated worktree at the reviewed commit. Those changes are not part of this review or its validation.

## R1: Preserve pending numeric formulas after whitespace

Source: https://github.com/narumiruna/pi-vscode/pull/57#discussion_r4285814286
Thread: `PRRT_kwDOUAKqMc6s4C8k`.

- Initial outcome: Actionable and not yet addressed.
- Final outcome: Already addressed by the validated changes in this review. The PR reply records the published commit and resolved thread.
- Severity: P2. Streaming math can change its visible source.
- Evidence: a fresh build renders `$2 \times *x*` as `<p>$2 \times <em>x</em></p>`. The same issue occurs with two backslashes before `times`. The numeric prefix test returns before the pending-math test.
- Scope: PR #57 adds the numeric prefix rejection. This regression conflicts with its goal to retain pending math as source.
- Required fix: accept clear math syntax immediately after the numeric prefix before classifying it as currency. Do not search ordinary prose for later Markdown punctuation.

## R2: Recognize punctuation-delimited prices

Source: https://github.com/narumiruna/pi-vscode/pull/57#discussion_r4285814305
Thread: `PRRT_kwDOUAKqMc6s4C8t`.

- Initial outcome: Actionable and not yet addressed.
- Final outcome: Already addressed by the validated changes in this review. The PR reply records the published commit and resolved thread.
- Severity: P2. Markdown after ordinary price punctuation stays literal.
- Evidence: a fresh build renders `Costs ($5), **cheap**` as `<p>Costs ($5), **cheap**</p>`. It also renders `Price is $5: *cheap*` with literal emphasis markers. The currency check permits only whitespace or the end of the input after the amount.
- Scope: this is an incomplete case of the currency fix that PR #57 is intended to provide.
- Required fix: accept ordinary non-math price punctuation as a currency boundary. Test formatted text after those boundaries.

## Validation and publication

The parser now reads the numeric amount and checks only the following expression prefix. A TeX command or a clear operator after whitespace keeps the pending formula as source. Currency punctuation is checked separately. Later Markdown in ordinary prose cannot change the decision.

- R1: tests preserve source for TeX commands with one or two backslashes, fractions, operators, and decimal numbers. A complete numeric formula still renders with KaTeX.
- R2: tests cover integer, decimal, and grouped prices; 12 punctuation boundaries; and every streaming prefix of strong text, emphasis, links, code, and underscore emphasis. The exact parenthesized-price example now renders strong text.
- The earlier escape-parity, 99,999-character performance, currency, and pending symbolic math tests still pass.
- `npm run package`: 364 tests across 44 files passed. VSIX creation passed with 130 files. `unzip -t pi.vsix` passed. The packaged parser contains the new prefix check.
- `npm run test:rich-content`: browser rendering, fonts, math, diagrams, CSP, caches, queue bounds, stale results, and disposal passed.
- Focused Biome check on both changed TypeScript files passed, with six existing informational diagnostics. `git diff --check` passed.
- The first package attempt failed because a shared `node_modules` symlink caused `npm list` to report `ELSPROBLEMS`. Replacing that worktree-only symlink with a local `npm ci` fixed the setup. The full package command then passed. No dependency files changed.
- The existing patch Changeset already covers these currency/parser corrections. No second Changeset is needed for the same pending patch.
- The four repository-wide Biome errors recorded in `docs/reviews/pr-50-review.md`, C2, remain deferred to a separate lint cleanup PR. The evidence for unchanged files is reused. No issue or extra PR was created.
- Native UI, remote hosts, Windows/macOS, live providers, and screen-reader applications were not rerun. No Marketplace release was run.

The fix was pushed as `ccd47a1`. Both original review threads received evidence replies and were resolved through the GitHub API. A fresh query confirmed both resolved states. The hosted `Compile and test` check passed.

## Follow-up review of `ccd47a1`

The branch, repository, PR state, description, commits, feedback, checks, and instructions were checked again. The head and prior diff are unchanged. All REST feedback lists were paginated. GraphQL reports no further thread or comment pages. There are two new findings. Prior R1 and R2 remain already addressed; their replies and resolved states are unchanged. The earlier full-diff review, validation, and out-of-scope lint outcome remain evidence for unchanged material.

### R3: Preserve pending factorial formulas

Source: https://github.com/narumiruna/pi-vscode/pull/57#discussion_r4285914380
Thread: `PRRT_kwDOUAKqMc6s4SIJ`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. A pending formula can show Markdown formatting instead of its source.
- Evidence: the built `ccd47a1` parser renders `$5! + *x*` as `<p>$5! + <em>x</em></p>`. The completed `$5! + x$` renders with KaTeX. The new currency boundary returns before examining a math operator after the factorial.
- Scope: PR #57 adds the punctuation boundary. Preserving incomplete formulas is part of its goal.
- Required fix: check for a clear math continuation after factorial punctuation. Keep ordinary price exclamations as currency.

### R4: Preserve underscore emphasis directly after currency

Source: https://github.com/narumiruna/pi-vscode/pull/57#discussion_r4285914398
Thread: `PRRT_kwDOUAKqMc6s4SIV`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Ordinary emphasis after a price is displayed literally.
- Evidence: the built `ccd47a1` parser renders `Only $5 _cheap_` and `Only $5 __cheap__` with literal underscore markers. The expression-prefix test treats every leading underscore as math.
- Scope: PR #57 adds this prefix test. Markdown after currency must remain available to Marked.
- Required fix: require a clear math continuation after an underscore, instead of treating underscore emphasis as math.

### New validation and publication

- R3 outcome: Already addressed by the validated changes in this review. The expression-prefix check now permits factorial punctuation before a clear math continuation. It does not search later prose for math signals. Tests cover single and repeated factorials, operators, TeX commands, and completed KaTeX formulas.
- R4 outcome: Already addressed by the validated changes in this review. An underscore must have whitespace or a braced continuation to identify pending numeric math. Tests compare every streaming prefix of underscore and asterisk emphasis, including strong text, directly after integer, decimal, and grouped prices. Cases with one or two price exclamation marks also retain Markdown. Spaced and braced math subscripts still remain source.
- `npm run package`: 366 tests across 44 files passed. VSIX creation passed with 130 files. ZIP validation passed, and the packaged parser contains the new prefix check.
- `npm run test:rich-content`: the browser suite passed, including rendering, CSP, math, diagrams, cache eviction, queue bounds, stale results, and disposal.
- Focused Biome check on both changed TypeScript files passed with the same six informational diagnostics. `git diff --check` passed.
- The existing patch Changeset covers these corrections. No dependency, manifest, host, trust, CSP, RPC, or storage change is needed. Unchanged repository-wide lint debt remains deferred to a separate cleanup PR. No such issue or PR was created.
- Native UI, remote hosts, Windows/macOS, live providers, and screen-reader applications were not rerun. No Marketplace release was run.

The fix uses the existing open PR branch. The review replies record the published commit. Both new threads must be resolved after the push and checked again through the API.
