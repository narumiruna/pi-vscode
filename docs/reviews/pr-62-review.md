# PR #62 review ledger

Target: https://github.com/narumiruna/pi-vscode/pull/62

Reviewed head: `34957736e707806765703c063f2ab189c5aa8eda`. The checkout matches `narumiruna/pi-vscode` and the open PR branch. The complete remote diff matches the local diff. The prior implementation review remains valid for unchanged files. All pages of submitted reviews, inline comments, conversation comments, and review threads were read. The review summary and status comment contain no separate defect or question.

## Items

### R1 — Keep matching JSON unchanged outside codemode

- Source: https://github.com/narumiruna/pi-vscode/pull/62#discussion_r4286589228
- Severity: P2. In scope. This PR adds result decoding and changes the text shown and copied.
- Evidence: the new regression at the reviewed head returns `file contents` for the literal output `{"content":[{"type":"text","text":"file contents"}]}`. `extractToolText` has no tool identity, and both host event handlers call it for every tool. The claim is valid for both supported serialized shapes.
- Outcome: **Already addressed by this revision.** `extractToolText` decodes only when the stored tool name is `codemode`. Both host event handlers use the call ID to find that name. Missing identity and all other tools keep matching JSON unchanged. Unit tests cover both shapes for read, bash, edit, custom, and missing names. Native fixtures verify literal read output and literal bash JSON during update and end events. The existing codemode display check still passes.

### R2 — Keep the newest long output

- Source: https://github.com/narumiruna/pi-vscode/pull/62#discussion_r4286589239
- Severity: P2. In scope. This PR replaces tail retention with head retention for content-block output.
- Evidence: a cumulative output longer than 8,000 characters omits `latest partial line` in the new regression. Code inspection confirms that later final failures also fall outside the retained prefix. The original extraction kept the tail of text content. The claim is valid.
- Outcome: **Already addressed by this revision.** Output now keeps the newest text after a leading truncation notice. Input keeps its leading fields. Unit tests prove that cumulative output changes after the limit and retains the final failure. They also test plain output and small limits. Native full-output and copy checks retain `FINAL: retained command summary` within 8,000 characters.

## Validation

Before the fix, `npm run compile && npx vitest run out/test/toolPresentation.test.js` fails both new regressions. The two existing tests pass.

After the fix:

- Focused helper and sidebar DOM tests: 50 tests pass.
- `npm test`: 375 tests in 45 files pass.
- `npm run test:native-ui`: passes on Linux VS Code 1.106.0. This includes the new host update/end checks, tail retention and copy checks, and all prior native UI checks.
- Biome checks on changed scripts: no errors.
- `git diff --check`: passes.

No item is deferred or needs clarification. No blocker remains. The review changes do not alter permissions, CSP, execution, host placement, or retention limits. The original untested platform paths remain unverified.
