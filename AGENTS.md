# Repository guidance

## Language and Terminology

- Follow ASD-STE100 (Simplified Technical English) for English technical prose when applicable.
  - Use approved vocabulary and sentence structures where practical.
  - Preserve technical accuracy when ASD-STE100 conflicts with established terminology.
- Keep proper nouns and technical terms in English.
- Use terminology consistently throughout the response.

## Technical Documentation

- Make rules specific, actionable, and verifiable.
- Use indented sub-items for rules that depend on a parent rule.
- Put each prose sentence on a separate source line.
- Use Mermaid syntax for diagrams when a diagram improves clarity.
- Prefer concrete explanations and examples over abstract descriptions.
- Do not add diagrams, examples, or sections that provide no useful information.

## Documentation

- Read `README.md` for development commands and `docs/SECURITY.md` before changing process, trust, context, or edit workflows.
- Update `README.md` and `docs/FEATURE_MATRIX.md` when user-visible capabilities change.
- Treat `docs/WORKFLOW_VALIDATION.md` as historical evidence, not the source for current commands or test counts.

## Code style

- Follow `biome.json`: two-space indentation, 120-column line width, double quotes, and semicolons in JavaScript and TypeScript.
- Keep host code compatible with the strict Node16 configuration in `tsconfig.json` and browser code with `tsconfig.webview.json`.
- Use stable VS Code APIs supported by the minimum version in `package.json` and the pinned `@types/vscode` declarations.

## Commands

- Use Node.js 22.19 or newer and `npm ci` to install the locked dependencies used by CI.
- Run `npm run compile` to check host and browser TypeScript and build bundled renderer assets.
- Rerun `npm run compile` after renderer or style changes when using `npm run watch`, which watches only host TypeScript.
- Run `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources` for the documented formatting and lint check.
- Run `npm run package` when VSIX validation is needed; it runs the full test suite and overwrites the local `pi.vsix`.

## Boundaries

- Edit source files rather than generated `out/` files, bundled dependencies, copied fonts, or `*.vsix` archives.
- Do not run `npm run dev`, `npm run install:vsix`, `npm run install:extension`, or `scripts/install.sh` without an explicit installation request because they change the installed extension or remove legacy bridge files.
- Ask before publishing releases or Marketplace packages, changing external systems, or using a live model for validation.

## Security

- Preserve the trust, permission, read-only, Preview/Apply, and stale-content checks documented in `docs/SECURITY.md` when changing affected workflows.
- Keep prompts and context on Pi stdin rather than process arguments, and keep bridge access authenticated and restricted to loopback.
- Keep renderer assets bundled locally and preserve the webview CSP and content sanitization boundaries.

## Testing

- Run `npm test` after code changes; it compiles first and runs Vitest against `out/test/**/*.test.js` without a live model.
- Add regression tests in `src/test/*.test.ts` and use `src/test/vscodeMock.ts` for tests that need the mock VS Code host.
- Run `npm run test:rich-content` after renderer changes and `npm run test:thinking-picker` after thinking-picker changes, with local Playwright Chromium installed.
- Use `npm run test:native -- 1.140.0` for isolated native Extension Host checks and substitute `stable` for current-version checks, with `xvfb-run -a` on headless Linux.
- Use `xvfb-run -a npm run test:native-ui -- 1.140.0` for Linux native UI checks with disposable profiles and fixture Pi responses.
- Report browser, native, remote, platform, and live-provider checks separately, and do not claim checks that were not run.
- [UNREVIEWED] On macOS, use `TMPDIR=/private/tmp npm test -- --maxWorkers=1` to avoid temporary-directory symlink rejection and concurrent-fixture timeouts.

## Repository structure

- Keep VS Code host integration in `src/`, browser rich-content rendering in `src/webview/`, and packaged Pi bridge and policy extensions in `resources/`.

## Git and commits

- Do not commit images or binary files unless they are logos, icons, or assets required by the project.
- Include a `.changeset/*.md` entry for release-worthy changes and leave version and changelog updates to the Changesets Version PR workflow.
- Keep the Husky pre-commit check enabled; it runs `npm test` through `scripts/pre-commit.mjs`.
