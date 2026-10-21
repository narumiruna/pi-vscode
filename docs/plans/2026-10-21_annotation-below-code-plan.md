# Below-code annotation plan

## Execution status

**Blocked at the native feasibility gate (2026-10-21).** The test-only prototype creates a below-anchor expanded thread, but VS Code 1.140.0 and current stable 1.143.0 automatically open the Comments panel in default disposable Linux profiles. Production integration has not started. The no-navigation acceptance criteria remain unchanged.

See [Native annotation thread feasibility](../ANNOTATION_THREAD_FEASIBILITY.md) for commands, actual results, reproduced failure, prepared but unreached assertions, and the required design decision. This plan is not complete and must not be deleted. The draft PR retains the prototype and failure evidence only.

## Goal

Show each `vscode_annotate` explanation below its marked passage without requiring hover. Use temporary native editor UI. Do not insert source comments or change files.

Use an expanded, read-only native comment thread as the proposed display. This is not a custom inline block: VS Code controls its layout, and the explanation also appears in the Comments panel. Implementation depends on the feasibility gate below.

## Context

- `src/editorAnnotations.ts` validates complete lines, workspace/file identity, document versions and request revisions. It currently renders whole-line decorations with literal-text hovers.
- `src/piRuntime.ts` owns foreground authorization and invalidates annotations on clear and session/client transitions.
- `resources/pi-bridge.ts` defines the existing bounded tool input and `{ count, visible }` result. No new tool parameter is needed.
- `docs/SECURITY.md`, under **Temporary Editor Annotations**, requires no file writes, new tabs, selection changes, scrolling or focus changes.
- `package.json` requires VS Code `^1.140.0` and pins `@types/vscode` to `1.140.0`. Use these current values rather than historical validation versions.
- The pinned stable declarations expose `comments.createCommentController`, `createCommentThread`, `CommentThreadCollapsibleState.Expanded`, `CommentMode.Preview` and `canReply`.
- `scripts/annotation-native-fixture.mjs` already checks actual editor decorations, literal hovers, authorization, inactive tabs and lifecycle cleanup.
- `scripts/test-native-ui.mjs` supports Linux only. The host environment is macOS; execution used a local Linux arm64 container with Xvfb. Native below-code placement was verified before the no-navigation gate failed on VS Code 1.140.0 and 1.143.0.

## Display contract

1. An accepted annotation retains its current whole-line highlight and hover. Its explanation also appears in an initially expanded native thread anchored at the end of the marked passage.
2. The thread is labelled **Pi annotation**, with **Pi** as author. It contains literal plain text, including multiline and Chinese text.
3. The user can collapse and reopen the thread through native controls. Do not force it open again on every redraw.
4. Reply, edit, reaction and new-comment actions are not provided.
5. The annotation call does not reveal a range, activate a tab, open the Comments panel, move the cursor or take focus. Preserve the existing scroll contract during creation, replacement and removal.
6. Inactive open documents retain annotations without navigation. Their threads appear when the user opens the existing tab.
7. Explanations also appear in the native Comments panel. Global VS Code comment visibility controls can hide them; do not change user settings to override those controls.
8. A range ending at EOF must work without inserting a trailing newline. Diff editors must retain the existing supported-document behavior.
9. `count` remains the number of accepted input annotations. `visible` retains its existing meaning: the document has a visible text editor, not proof that a comment widget is expanded or visible.

## Architecture

Keep validation, retained state and native UI ownership in `EditorAnnotations`. Do not add another bridge route, webview renderer or generic presentation layer.

- Create one extension-owned `CommentController` lazily. Use a fixed extension-specific ID and label.
- Retain decoration options and owned comment-thread handles for each document under the existing version/revision checks.
- Use the validated end line as the thread anchor. Group annotations with the same end line into one thread, with messages in input order, to avoid competing widgets at one anchor. Retention limits still count input annotations.
- Set `canReply = false` and `CommentMode.Preview`. Do not register a commenting-range provider, reaction handler or mutation commands.
- Construct the thread body with the existing literal-text escaping rules: untrusted `MarkdownString`, HTML disabled, escaped entity input and encoded autolink punctuation. Do not interpret model Markdown, URLs, images or commands.
- Validate the entire replacement and existing limits before creating threads. Keep the previous accepted state until the replacement is prepared. Dispose newly created handles on failure; do not leave a partial retained replacement or remove the previous accepted state.
- Keep the final authorization/content checks and synchronous UI commit together. Do not add an asynchronous gap that permits expired work to restore annotations.
- Clear decorations and dispose threads together on document edits, last-tab closure, manual clear and all existing runtime invalidation paths. Save-only events retain both.
- Do not recreate threads on ordinary visible-editor changes. Preserve user collapse state and avoid duplicate Comments panel entries. Dispose the controller on extension disposal.

## Non-Goals

- Custom Monaco view zones, private workbench APIs, proposed APIs or editor DOM injection.
- CodeLens or inlay-hint substitutes that do not provide a multiline block below the passage.
- Source edits, persistent review conversations, replies or provider calls.
- New settings, feature flags, tool arguments, dependencies or installation steps.
- Function parsing: annotations remain passage-based and work with code and ordinary text.

## Plan

- [x] Prepare a minimal native-thread prototype and deterministic fixture using the pinned stable APIs. Compile it and add mock assertions for anchor, expanded state, read-only behavior and disposal. Prepare native assertions for below-code geometry, EOF, duplicate anchors, diff views, inactive tabs, and focus/selection/scroll preservation. Evidence: passing compilation/unit checks and a runnable fixture. Do not treat mock results as native placement evidence.
  - Evidence: compilation and 113 focused unit tests passed (16 prototype cases). The runnable native prototype failed the panel-preservation gate on Linux arm64 VS Code 1.140.0 and 1.143.0. Geometry/literal/grouping checks passed before the failure; later native checks were not reached. Production integration is blocked.
  - Native feasibility is a prerequisite for production integration. Obtain the evidence described in **External Handoff** before starting the next task.
  - If expanded threads cannot meet the display and navigation contract, stop integration and record the failure. Do not substitute hover-only output or relax the security contract without a new design decision.
- [ ] **Blocked by failed feasibility:** Integrate comment-thread ownership into `src/editorAnnotations.ts` after the native feasibility gate passes. Preserve the current authorization, exact-text, file-safety and retention checks. Evidence: controller tests prove correct anchoring/grouping, replacement cleanup, unchanged counts and no new file/editor actions.
- [ ] **Production lifecycle tests blocked by failed feasibility; prototype mock tests added:** Extend `src/test/vscodeMock.ts` and `src/test/editorAnnotations.test.ts` for controller/thread lifecycle and failure handling. Cover partial creation failure, invalid/stale replacement, multiple visible editors, edit/close/save-only events, manual clear, disposal, retained limits, and late work after invalidation. Keep existing authorization/runtime/tool tests. Evidence: all affected tests pass without weakening assertions unrelated to native layout.
- [ ] **Prototype assertions prepared; integration and remaining native UI checks blocked:** Extend `scripts/annotation-native-fixture.mjs` and, only where needed, `src/test/nativeUiWorkflow.ts` with real comment-widget and Comments panel checks. Assert full literal text, no links/images/commands, multiline/Chinese wrapping, same-anchor ordering, cleanup, collapse/reopen, themes and narrow editors. Keep existing navigation-preservation and unchanged-file checks. Evidence: fixture code is ready for the Linux native checks in the handoff; do not replace DOM evidence with accepted bridge metadata.
- [ ] **Blocked; no released capability change or changeset:** Update the tool description in `resources/pi-bridge.ts` and its tests to describe the native expanded display and Comments panel behavior. Keep the input schema, limits and result shape unchanged. Update `README.md`, `docs/FEATURE_MATRIX.md`, `docs/USER_GUIDE.md`, `docs/SECURITY.md` and `docs/DEVELOPMENT.md` to match verified behavior. Add a patch `.changeset/*.md` entry. Evidence: documentation matches implementation and distinguishes new validation from historical results.
- [x] Run local verification with Node.js 22.19 or newer and locked dependencies. Use `npm run compile`, `npm test`, and `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources`. On macOS, use `TMPDIR=/private/tmp npm test -- --maxWorkers=1`. Run `npm run test:native -- 1.140.0` and `npm run test:native -- stable` where test-build downloads and execution are available. Evidence: record actual commands, versions and results; leave failed mandatory checks unresolved.
- [x] Prepare the external validation handoff with fixture commands, prototype findings and remaining platform limits. Evidence: retained test/documentation notes distinguish unit, native Extension Host, native UI, remote and live-provider coverage. No live provider, extension installation or publication is part of this work.

## Completion Checklist

- [x] The native feasibility result has a documented disposition; production integration is blocked if placement or navigation-preservation requirements fail.
- [x] Local compilation, tests and lint pass, and required available Extension Host checks have recorded results.
- [ ] Tests cover thread ownership, literal-text safety, stale/invalid replacement, failure cleanup and all existing invalidation paths.
- [x] Tool input/result compatibility and documented limits are unchanged.
- [ ] Documentation, changeset and external validation instructions describe the actual display and known limitations.

## External Handoff

### Linux native feasibility and UI validation

- Responsible role: maintainer or agent with an available Linux graphical environment or Xvfb.
- Prerequisites: disposable VS Code test profiles, local Playwright Chromium, Node.js 22.19 or newer, locked dependencies, and the prepared prototype/annotation fixture. No configured live provider is required.
- Action: first run `xvfb-run -a npm run test:native-ui -- 1.140.0 annotation-prototype` and `xvfb-run -a npm run test:native-ui -- stable annotation-prototype`. Both currently fail the gate. The existing `annotations` selector still tests the unchanged production decoration/hover workflow and passed on both versions. After an accepted design revision and passing prototype gate, run the production `annotations` checks on both versions. Capture actual version metadata, fixture output and before/after screenshots outside committed source assets.
- Expected result: an expanded native explanation is below the range end without hover, including EOF and supported diff views. Full literal text is readable. Creation, replacement and clearing preserve tabs, text, focus, selection and scroll. Disposed annotations leave no owned threads in the editor or Comments panel.
- Recorded disposition: actual below-anchor expansion, literal text and duplicate-anchor grouping passed before the panel-opening failure. Default native creation opened the Comments panel and changed the visible range. Production integration stopped. Other native scenarios after that assertion and interactions with comment visibility settings remain unverified; see the feasibility record.
- Restriction: the prototype result gates production integration. Passing integration fixtures gate release. If the API cannot preserve the existing no-navigation contract, stop and revise the design rather than weakening the checks.

### Other platform and usability checks

- Responsible role: maintainer with the target environment.
- Prerequisite: a candidate that passes the Linux fixtures.
- Action: inspect macOS/Windows and remote-host rendering, native keyboard navigation, screen-reader output, and coexistence with another comment provider. Review multiline Chinese text in a narrow editor.
- Expected result: readable, distinguishable Pi annotations, no unintended editing/reply actions, and cleanup limited to Pi-owned threads.
- Unverified behavior: these environments and assistive-technology behavior remain explicitly unverified until checked. Do not claim coverage from Linux or mock results. Subjective visual review does not replace automated safety checks.

## Risks

- Stable type declarations confirm API availability, not widget placement or focus/scroll behavior. The native feasibility gate is mandatory.
- Native comments add gutter and Comments panel UI. Their chrome, stacking and visibility are controlled by VS Code, not the extension.
- Expanded blocks change editor layout. Verify viewport preservation rather than adding reveal/scroll commands to compensate.
- Multiple threads and other comment providers can affect readability. Same-anchor grouping and existing annotation limits bound the new UI without introducing a new setting.

## Rollback / Recovery

The tool protocol does not change and no data migration is needed. If integration fails validation, dispose the new threads/controller and restore the existing decoration/hover renderer. Keep the authorization and stale-content checks unchanged. Revert the new capability documentation and patch changeset with the renderer change; do not change version or changelog files manually.
