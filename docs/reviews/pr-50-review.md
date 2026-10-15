# PR #50 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/50
Reviewed head: `04ca99b1e668d77f4d8dbb4c4503c7ad51a0f567`.
Goal: safe Markdown, math, diagrams, and code highlighting in the session panel.

## Review evidence

The branch and checkout remote match `narumiruna/pi-vscode`. No applicable `AGENTS.md` file exists. The description, commit list, full diff, and original validation were reviewed during implementation. The head commit and complete diff are unchanged, so that review remains valid. All current reviews, inline comments, issue comments, and review threads were fetched. REST lists use pagination. GraphQL reports no further thread or comment pages. There are two findings. The review summary and conversation status contain no separate request. The head has no check runs or commit statuses.

The extension still requires VS Code 1.106.0 and the Node workspace host. The fixes will not change host placement, public APIs, RPC, storage, trust, or CSP permissions.

## R1: Avoid full-history cache misses

Source: https://github.com/narumiruna/pi-vscode/pull/50#discussion_r4285462185
Thread: `PRRT_kwDOUAKqMc6s3Njo`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. Repeated full-history parsing can delay streamed output.
- Evidence: `postState()` renders messages from oldest to newest. The host cache holds 64 source/output pairs and evicts the oldest entry on a miss. After a 100-message scan, the next scan inserts its first 36 misses before reaching the cached tail. Those insertions evict the entries needed later in the same scan.
- Scope: PR #50 adds this cache and the more expensive Marked, highlighter, and KaTeX work. Useful cache hits are required for the existing 100-message transcript.
- Fix: `MarkdownRenderer.renderBatch()` captures all existing hits before admitting misses. The sidebar provider owns the cache. The limits remain 64 entries and 2,000,000 retained characters.
- Reproduction: the original parser ran 100 times on the first 100-message scan and 100 more times on the next scan.
- Validation: the new test uses the real parser with a call counter. The second scan needs 36 calls, not 100. Five changed streaming tails each need at most 37 calls. Output matches uncached parsing. Separate tests cover the character limit, oversized output, and duplicate source text.
- Outcome: implemented and validated. Publication and thread resolution are recorded on the pull request.

## R2: Preserve diagram labels during SVG ID updates

Source: https://github.com/narumiruna/pi-vscode/pull/50#discussion_r4285462193
Thread: `PRRT_kwDOUAKqMc6s3Njs`.

- Initial outcome: Actionable and not yet addressed.
- Severity: P2. The preview can show text that differs from its source.
- Evidence: `display()` applies `value.svg.replaceAll(value.id, unique)` to the entire SVG string. A label such as `piDiagram1` or `piDiagram10` can contain the renderer ID `piDiagram1`. The replacement changes that label as well as IDs.
- Scope: PR #50 adds this preview and promises readable source with a matching diagram.
- Fix: `namespaceSvg()` changes element IDs and local references through DOM attributes and parsed CSS rules. It does not replace SVG text nodes or CSS string values. The cached SVG no longer stores an unused renderer ID.
- Reproduction: the new real-Mermaid fixture failed on the original code. Visible text changed from `piDiagram1` / `piDiagram10` to `piDiagram2` / `piDiagram20`.
- Validation: real browser and installed-VSIX tests retain both labels. The delayed renderer test checks first and cached copies, distinct IDs, marker URLs, inline style URLs, local hrefs, ARIA references, nested CSS selectors, CSS URL values, and unchanged text/title/description/CSS string values. Existing sanitizer, CSP, cache eviction, queue, stale result, and disposal tests still pass.
- Outcome: implemented and validated. Publication and thread resolution are recorded on the pull request.

## Original publication

The target remains open. Both fixes use `narumi/feat/panel-rich-content`.

Validation:

- `npm run package`: 357 tests across 43 files pass. VSIX creation and ZIP validation pass. Required host/browser bundles, fonts, and licenses are present.
- `npm run test:rich-content`: actual browser rendering and all added reference/cache regressions pass.
- `xvfb-run -a npm run test:native-ui -- 1.106.0 packaged`: the installed VSIX passes the complete native UI walkthrough, including the new labels and existing workflow/reload checks.
- Full repository Biome check: no errors; 421 existing warnings and 12 infos remain. `git diff --check` and production audit pass.
- The complete fix diff was checked for correctness, security, lifecycle, compatibility, regressions, and scope. No dependency, manifest, RPC, persistence, trust, or CSP change was needed.
- Remote hosts, Windows/macOS native UI, live providers, and screen-reader applications were not rerun. No release or package publication was performed.

Commit `99f83cd` was pushed to PR #50. Both review comments received replies with evidence. Both threads were resolved through the GitHub API. A fresh query confirmed `isResolved: true` for each thread. No review question remains open.

## C1: Node.js 22 CI encoding failure

Source: https://github.com/narumiruna/pi-vscode/actions/runs/38769025755/job/116539672304

- Outcome: Valid but out of scope — deferred.
- Severity: P2 test portability failure. No active outage or unsafe diagnostic acceptance is shown.
- Evidence: the new CI workflow on main uses Node.js 22. The merge test reports 358 passed tests and one failure in `diagnostic capture verifies VS Code encoding iso885916`. The 10 Markdown tests, including both new cache tests, pass. Local Node.js 22.23.3 reproduces the same failure: `new TextDecoder("iso-8859-16", { fatal: true })` throws `ERR_ENCODING_NOT_SUPPORTED`. The focused encoding file has 93 passes and one failure on that runtime.
- Scope: `src/diagnosticEncoding.ts`, `src/test/diagnosticCapture.test.ts`, and `src/test/diagnosticEncodingFixtures.ts` are unchanged between the original PR base `c38453b`, this branch, and the latest fetched main `88b2c83`. The workflow was added separately in merged PR #53. This panel PR does not add, expose through its feature, or worsen the codec assumption. Production still rejects unsupported codecs safely.
- Recommendation: use a separate encoding-test portability PR. It must test the unsupported-codec path on runtimes without this decoder while retaining positive coverage where the decoder exists. No issue or separate PR was created.
- Original PR status: local Node.js 26 validation passed, but the hosted check was red. This was not a blocker to publishing or verifying the two panel fixes.

## Follow-up review of `12a64ec`

Target review: https://github.com/narumiruna/pi-vscode/pull/50#pullrequestreview-5536649387

The target is merged. The checkout remote matches the target repository. There is no applicable `AGENTS.md`. The original full-diff review above remains evidence for unchanged material. The commit list and changes from `04ca99b` through `12a64ec` were checked. All reviews, inline comments, conversation comments, and threads were fetched again. REST lists were paginated. GraphQL reports no further thread or comment pages. The review summary adds no separate request.

### Prior items

- R1: Already addressed, P2. Commit `99f83cd` contains the batch cache fix and its tests. The source still captures hits before inserting misses. The published reply and resolved thread are unchanged. No duplicate reply is needed.
- R2: Already addressed, P2. Commit `99f83cd` contains structural SVG ID updates and browser regressions. The source still preserves text nodes and CSS string values. The published reply and resolved thread are unchanged. No duplicate reply is needed.
- C1: Already addressed, P2. Separate PR https://github.com/narumiruna/pi-vscode/pull/54 merged as `1a240bc`. Commit `12a64ec` also contains the runtime-dependent encoding test change. PR #50's latest `Compile and test` check passed. The earlier deferral is no longer pending. No encoding change is needed here.

### R3: Avoid repeated math-prefix scans

Source: https://github.com/narumiruna/pi-vscode/pull/50#discussion_r4285704189
Thread: `PRRT_kwDOUAKqMc6s3yP0`.

- Outcome: Actionable and not yet addressed.
- Severity: P2. A bounded message can delay the Extension Host for seconds.
- Evidence: the tokenizer slices from offset zero for every candidate closer and applies a regex to the entire prefix. After installing the locked dependencies and rebuilding the original source, `$` plus repeated `\\$` took 165 ms at 20,001 characters, 633 ms at 40,001, 2,445 ms at 80,001, and 3,682 ms at 99,999.
- Scope: PR #50 adds this tokenizer. Bounded, responsive math rendering is part of its goal.
- Required fix: inspect only the adjacent backslash run. Preserve odd/even escape handling for all four delimiters. Add a bounded-input regression.

### R4: Preserve Markdown after currency

Source: https://github.com/narumiruna/pi-vscode/pull/50#discussion_r4285704203
Thread: `PRRT_kwDOUAKqMc6s3yP_`.

- Outcome: Actionable and not yet addressed.
- Severity: P2. Ordinary Markdown formatting disappears after a price.
- Evidence: rebuilt original code renders `Price is $5 and *cheap*` as `<p>Price is $5 and *cheap*</p>`. A link to `https://example.com` and strong text also remain literal. The pending-math test searches the whole suffix, including Markdown punctuation and URL slashes.
- Scope: PR #50 adds the pending token and documents currency exclusion in `README.md`.
- Required fix: reject numeric currency prefixes before claiming unmatched single-dollar math. Retain complete numeric math and pending symbolic math. Test streaming suffixes and ordinary Markdown after prices.

### Follow-up validation and publication

Branch: `narumi/fix/pr-50-math-review`, from remote `main` at `98c6d4a` after a fresh fetch. No relevant source or skill instruction changed on the newer base.

- R3 fix: count only the consecutive backslashes before each candidate closer. Each run belongs to one candidate, so the scan no longer repeats work over the entire prefix. Regression tests cover zero through four backslashes for all four delimiter pairs, skipped escaped candidates, exact output for 99,999 characters, and a generous 1,000 ms limit. A fresh benchmark took 21, 8, 16, and 13 ms at the same four input sizes used above.
- R4 fix: reject unmatched single-dollar numeric prefixes before looking for pending math in the suffix. Complete numeric formulas still render. Tests compare every streaming prefix of emphasis, strong text, links, strikethrough, code, and underscore emphasis after integer, decimal, and grouped prices with the same Markdown without a dollar marker. Existing pending symbolic math remains readable.
- R3 and R4 outcome: implemented and validated. The follow-up PR and the original review replies record the published commit and thread resolution.
- `npm test`: 362 tests across 44 files passed.
- `npm run test:rich-content`: browser rendering, CSP, asset loading, math, Mermaid, cache, queue, stale updates, and disposal passed.
- `npm run package`: 362 tests passed again; VSIX creation passed. `unzip -t pi.vsix` passed. The packaged `extension/out/markdown.js` contains the adjacent-backslash scan. Runtime renderer bundles and license files are present.
- Focused Biome check on both changed TypeScript files passed. `git diff --check` passed.
- A patch Changeset records both fixes. No dependency, manifest, host-placement, RPC, storage, trust, or CSP change was needed.
- Native UI, remote hosts, Windows/macOS, live providers, and screen-reader applications were not rerun. These fixes change host parsing only. No Marketplace release was run.

### C2: Existing repository-wide Biome failures

- Outcome: Valid but out of scope — deferred.
- Severity: P2 validation debt. This does not prevent the focused tests or package build.
- Evidence: a detached worktree at the fresh base `98c6d4a` and the fix branch each report exactly 4 errors, 425 warnings, and 17 infos with Biome 2.5.15. The four error paths and categories match: formatting in `.vscode/launch.json`, `src/test/diagnosticCapture.test.ts`, and `tsconfig.json`; `lint/style/useConst` in `scripts/fixtures/native-pi.cjs`. Both changed TypeScript files pass the focused check.
- Scope: none of those four files is changed by this follow-up. The errors exist on the base. They do not show a defect introduced or worsened by PR #50's math parser.
- Recommendation: use a separate lint cleanup PR. No issue or separate PR was created for this item.
