# Pi Settings UX improvement plan

Status: Implementation and local validation complete; user visual acceptance remains pending in pull request review.

## Goal

Remove repeated row actions and use VS Code's native Settings editor wherever it can edit the existing configuration.
Keep Pi file editing separate from runtime Apply, restart, project approval, and MCP connections.

## Context

### Official guidance

The following official documentation was reviewed on 2026-10-22.

1. [Settings UX guidelines](https://code.visualstudio.com/api/ux-guidelines/settings)
   - Do not create a custom settings page or webview.
   - Provide defaults and clear, short descriptions.
   - Link to documentation for complex settings.
2. [Webview UX guidelines](https://code.visualstudio.com/api/ux-guidelines/webviews)
   - Use webviews only when the native APIs cannot provide the required function.
   - Do not repeat existing Settings functionality.
   - Support themes, accessibility, and keyboard navigation.
3. [Settings editor](https://code.visualstudio.com/docs/configure/settings#_settings-editor)
   - Changes save as the user edits.
   - A colored bar identifies configured settings.
   - A gear menu contains Reset and other secondary actions.
   - Search and `@modified` are built in.
4. [Configuration contribution point](https://code.visualstudio.com/api/references/contribution-points#contributesconfiguration)
   - Multiple configuration objects can provide category navigation.
   - Category and setting `order` values control presentation.
   - Simple string arrays already have native list controls.
   - `markdownDescription` can link to related settings and documentation.

These sources support using native Settings, not building a visual copy of the whole Settings editor.
Keeping a custom Pi file editor is a project-specific exception because these files are not VS Code configuration.
The official documentation does not prescribe the proposed draft and Save behavior for Pi files.
Newer documentation can describe behavior beyond the minimum supported VS Code version; verify the proposed experience on 1.140.0.

### Repository findings

- `package.json` already contributes all 11 `pi.*` settings to native Settings.
  - They currently belong to one `Pi` category.
  - The minimum VS Code version is 1.140.0, and the extension runs on the workspace Extension Host.
- `src/settingsPanel.ts` registers `pi.openSettings` and opens a custom panel.
  - Its existing `openNative` handler already opens `workbench.action.openSettings` with `@ext:narumi.narumi-pi`.
- `src/webview/settings.mts` repeats VS Code configuration controls.
  - Checkboxes and selects already save on change.
  - Text, number, and list controls have explicit Save.
  - Reset and Reload row appear on every row.
- `src/webview/nativeSettings.mts` edits eight common Pi settings and MCP enabled/exposure metadata.
  - All native fields use explicit Save, including checkboxes and selects.
  - Every row shows Save, Reset override, and Reload row, even without a draft.
- `resources/settings.css` uses large bordered cards, generous padding, and reserved status space on each row.
- `src/settingsHtml.ts` and the native form show several long introductory paragraphs before the controls.
- `docs/SECURITY.md` and `docs/NATIVE_CONFIGURATION.md` require guarded Pi file writes and separate runtime actions.
  - Native file controls are not interchangeable with VS Code configuration writes.
- `scripts/test-settings.mjs` covers browser interaction, drafts, scopes, conflicts, themes, layout, and CSP.
  - Native UI fixtures also depend on the current custom Settings controls.

## Recommended design

### VS Code extension settings

Use the real native Settings editor for General, Permissions, and Editor settings.

- Keep the public command ID `pi.openSettings` and the existing sidebar gear.
  - Route both to `workbench.action.openSettings` with `@ext:narumi.narumi-pi`.
  - Do not open a custom panel or start Pi.
- Organize the existing settings into General, Permissions, and Editor categories through `contributes.configuration`.
  - Preserve all setting IDs, defaults, types, bounds, configuration scopes, and runtime behavior.
  - Do not introduce new settings or copy Pi file values into VS Code configuration.
- Use native save-on-edit, scope selection, search, configured-value indicators, and Reset menus.
  - Do not implement a second version of these features.
- Keep descriptions short but retain security and startup warnings.
  - Link to the user guide for runtime selection, project-resource approval, and other detailed limits.

### Pi configuration files

Keep one dedicated **Pi Configuration** panel for the existing Global Pi / Project Pi file controls.

- Add `pi.openPiConfiguration`, titled **Pi: Open Pi Configuration**, as the direct panel command.
  - Put it in the Command Palette and the Pi view's secondary title actions, not beside every setting.
  - Keep `pi.openNativeSettings` and `pi.openNativeMcp` unchanged; they open existing native management dialogs.
- Remove the duplicated General, Permissions, and Editor form controls from the webview.
  - Remove its unrelated User/Workspace selector.
  - Keep one **Open VS Code Settings** action for extension settings.
- Use flat setting rows instead of rounded cards.
  - Keep the label, short description, control, and concise source information together.
  - Mark saved selected-scope overrides with a theme-aware indicator and text.
  - Mark unsaved drafts separately; do not use the saved-override indicator as an unsaved-state indicator.
- Show **Save** only when that row has a draft or an unresolved save attempt.
  - Keep Save visible but disabled while the row is pending or stale.
  - Hide Save after successful completion and return focus to its field.
  - A change back to the inherited value can still represent an explicit override; do not discard that intent through value equality alone.
  - Checkboxes, selects, and MCP metadata remain explicit-save controls.
- Put **Reset override** and **Reload row** in one compact row actions menu.
  - Disable Reset when there is no selected-scope override, or when the row is pending or stale.
  - Keep Reload available for draft discard and conflict recovery when no operation blocks it.
  - Show an inline **Reload row** recovery action only when a stale draft needs attention.
  - Never discard a draft merely because the menu opens or closes.
- Keep **Reload configuration** as a page-level action.
  - Explain that it reads saved values and does not reload Pi resources.
  - Preserve unrelated drafts when it refreshes the snapshot.
- Replace repeated introductory paragraphs with one short summary and a collapsed details section.
  - Keep trust failures, inactive project values, save errors, and restart requirements visible when relevant.
  - Do not reserve a blank status line for every clean row.

Do not add Save All or Reset All.
The existing row protocol has revision checks and partial-failure behavior; a batch operation would require a separate design.

## Non-Goals

- No automatic writes to Pi configuration files.
- No new runtime Apply, restart, connection, authentication, or provider-discovery behavior.
- No new settings database, Pi file schema, configuration keys, or migration of saved values.
- No custom search engine, filtering system, or copy of the native Settings editor.
- No change to multi-root target selection, Remote host placement, or supported VS Code versions.
- No dependency, framework, or UI toolkit replacement.

## Plan

- [x] Verify the native route on VS Code 1.140.0 before removing custom controls.
  - Check all 11 settings, native array controls, category labels, User/Workspace selection, and available remote-user handling.
  - Check Restricted Mode and virtual-workspace behavior, especially `pi.approveProjectResources`.
  - Native Settings already exists as a route; distinguish native editor behavior from custom-form-only validation and trust checks.
  - Confirm that runtime trust checks still prevent process launch and resource activation independently of where a value was edited.
  - Record any required security adjustment before implementation proceeds; do not silently remove a runtime guard.
- [x] Change the command routing and native configuration presentation in `package.json` and `src/settingsPanel.ts`.
  - Verify that the gear and `pi.openSettings` open filtered native Settings without creating the Pi panel.
  - Verify that `pi.openPiConfiguration` opens one dedicated panel and repeated invocation reveals it.
  - Verify that existing native management command IDs retain their behavior.
- [x] Restrict the webview shell to Pi file editing in `src/settingsHtml.ts` and `src/webview/settings.mts`.
  - Remove duplicated VS Code editing controls and their unused save/reset message handling.
  - Retain the host availability and invalidation signals needed by `NativeSettingsForm`.
  - Keep shared bounds and serialization helpers still required by native code; remove only proven-unused code.
  - Ignore obsolete General/Permissions/Editor recovery data without writing configuration or replaying old drafts.
  - Preserve valid bounded native common-setting drafts; MCP drafts remain memory-only.
- [x] Implement draft-dependent Save and the compact actions menu in `src/webview/nativeSettings.mts`.
  - Editing alone must send no `nativeSave` or `nativeReset` request.
  - Reset, reload, retry, and conflicts must retain their selected-scope and revision checks.
  - Opening actions must work by mouse and keyboard, expose expanded state, and support Escape and focus return.
  - Clicking outside must dismiss the menu without losing field data.
  - Pointer hover must not be the only way to find or activate actions.
- [x] Reduce row and introductory spacing in `resources/settings.css`.
  - Use VS Code theme tokens and visible focus indicators.
  - Verify no horizontal overflow at widths of 280, 400, 650, and 1100 pixels.
  - Verify light, dark, high-contrast, and reduced-motion presentation.
  - Compare the same clean native form before and after; all clean rows must lose the visible three-button action strip.
- [x] Update regression tests for the new surface boundaries.
  - Update `src/test/settings.test.ts` and `src/test/manifest.test.ts` for native routing and configuration category arrays.
  - Preserve `src/test/nativePiForm.test.ts` coverage for guarded writes, stale revisions, scope inheritance, secret exclusion, and missing-file behavior.
  - Update `scripts/test-settings.mjs` for clean/dirty/pending/error/stale states, actions-menu interaction, draft recovery, focus return, and layout.
  - Update `src/test/nativeSettings.ts`, `scripts/test-native-ui.mjs`, and `scripts/annotation-native-fixture.mjs` where they assume custom `pi.*` controls.
  - Keep equivalent native setting, scope, reset, annotation, and no-Pi-side-effect assertions instead of deleting that coverage.
- [x] Update `README.md`, `docs/USER_GUIDE.md`, `docs/FEATURE_MATRIX.md`, and `docs/NATIVE_CONFIGURATION.md`.
  - Explain the two entry points, the native Settings save model, and the retained explicit Pi file save model.
  - Update security documentation only where the documented UI boundary changes; preserve its file and runtime guarantees.
  - Add a patch Changeset for the user-visible change without changing versions or changelogs manually.
- [x] Run verification and record results separately by layer.
  - Run `npm run compile` and the documented Biome check.
  - On macOS, run `TMPDIR=/private/tmp npm test -- --maxWorkers=1`.
  - Run `npm run test:settings` with local Playwright Chromium.
  - Run `npm run test:rich-content` after renderer changes.
  - Run `npm run test:native -- 1.140.0` and `npm run test:native -- stable`.
  - Run applicable native UI fixtures on minimum and current VS Code; use `xvfb-run -a` on headless Linux.
  - Report unavailable native, remote, platform, and live-provider checks as gaps, not passed checks.

## Risks

- Native Settings replaces custom form behavior, not only its appearance.
  - Native scope handling and validation can differ from custom-form edit limits.
  - Verify and document those differences without weakening runtime trust or native Pi file guards.
- Moving file editing to a separate command can make it harder to find.
  - Keep the direct command in the Pi view's secondary actions and document it next to extension settings.
- Hiding Save or closing a menu can remove the focused element during redraw.
  - Explicitly test focus return after save, reset, reload, and failed operations.
- A page-wide refresh can make drafts stale.
  - Keep drafts and require explicit row recovery; do not silently submit them against a new revision.

## Execution evidence

Implementation uses branch `narumi/feat/native-settings-ux` from `origin/main` at `b728562`.
Pre-existing `AGENTS.md` and skill-reference edits are preserved but excluded from this implementation commit.
All checks below used macOS arm64 and locked dependencies installed with `npm ci`, without a live model.
Baseline native Settings UI on VS Code 1.140.0 passed before the custom controls were removed.
It verified all 11 controls, native arrays, User/Workspace saving and scoped model Reset, with no Pi launch or Pi file creation.
Native Settings now shows General (4), Permissions (2), and Editor (5); the property-contract regression checks all existing types, defaults, enums, bounds, and scopes.
Native Settings validation and incomplete-input behavior replace the former custom-form edit limits; runtime trust and native file guards remain unchanged.

| Check | Result |
| --- | --- |
| `npm run compile` | Passed host and browser TypeScript and asset bundling. |
| Documented Biome check on `src resources` | Exit 0; 958 warnings and 24 informational diagnostics, no errors. |
| `TMPDIR=/private/tmp npm test -- --maxWorkers=1` | 99 files passed; 1,466 tests passed and three skipped. |
| `npm run test:settings` | Passed explicit native saves, inheritance, draft recovery/migration, stale and failed operations, menu keyboard/dismissal, focus recovery, secrets, CSP, and 24 layout/theme combinations. |
| `npm run test:rich-content` | Passed renderer, responsive layout, CSP, and asynchronous lifecycle regressions. |
| `TMPDIR=/private/tmp npm run test:native -- 1.140.0` and `stable` | Passed Extension Host checks; stable resolved to 1.143.0. |
| The same native commands with `untrusted` | Passed separate Restricted Mode runtime guard checks on both versions. |
| `TMPDIR=/private/tmp npm run test:native-ui -- 1.140.0 settings` and `stable settings` | Passed real native settings, array Add Item, model scope/reset, annotation enum save/reset, categories, and Pi Configuration singleton, keyboard actions, draft-only edits, hide/reveal, explicit Save/focus and Reset. |
| Native Pi Configuration themes | Passed actual Dark Modern, Light Modern, and High Contrast theme propagation on both versions; local viewport captures were inspected and are not committed. |
| `TMPDIR=/private/tmp VITEST_MAX_WORKERS=1 npm run package` | Passed the full unit suite, VSIX build, extracted bundled-runtime checks, asset checks, and offline fail-closed smoke tests. |
| Script syntax and complete diff checks | Passed; independent review findings about the default native UI route and stale-row recovery focus were corrected. |

The first default-concurrency package attempt failed on the existing RPC fixture's one-second `get_state` timeout.
The single-worker rerun passed without changing the RPC client or its tests.
An exploratory array-specific native Reset automation attempt did not pass because the menu could disappear during list refresh; it is not claimed as coverage.
Current native Reset evidence covers model scopes, the annotation enum, and explicit Pi file overrides.
`npm audit` reports three existing development-only transitive advisories; dependency versions and the lockfile are unchanged.
Virtual-workspace rejection has unit coverage, but native virtual windows and actual remote-user scopes were not exercised.
Full Linux UI and annotation workflows, Windows native behavior, Remote SSH/WSL/container, installed-package UI, screen readers, live providers, and external MCP servers were not tested.
The updated default Linux and annotation fixtures retain their assertions but are not claimed as passed runs on this macOS host.

User visual acceptance is an external review step, not an automated-test result.
Keep this plan until that acceptance is recorded; do not mark the final item complete on the user's behalf.

## Completion Checklist

- [x] The sidebar gear opens native Settings filtered to Pi, with no custom `pi.*` form.
- [x] All 11 existing setting IDs, defaults, bounds, scopes, and runtime semantics remain accounted for.
- [x] Pi Configuration remains directly accessible and shows no User/Workspace selector.
- [x] Clean Pi rows show no Save/Reset/Reload button strip; draft rows expose only the needed primary action.
- [x] Keyboard users can reach row actions and recover from errors without losing drafts.
- [x] Saving and resetting Pi files retain trust, stale-content, dirty-buffer, canonical-path, and member-patch checks.
- [x] Opening, switching, and refreshing the panel create no configuration files, Pi processes, or MCP connections.
- [x] Documentation, Changeset, and applicable automated checks are complete, with unrun checks stated explicitly.
- [ ] The user accepts the native Settings route and the compact Pi Configuration layout after implementation review.
