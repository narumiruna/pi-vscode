# Interface review resolution plan

## Goal

Resolve the findings from the three screenshot reviews. Make attachments, composer actions, model settings, runtime notices, and long responses easier to understand without changing Pi request semantics or security boundaries.

Implementation and local validation are complete. Final acceptance remains blocked on the untested platform, remote, and assistive-technology checks listed below; no deferral has been accepted.

## Context

The screenshots cover an empty conversation, an attachment draft, a long response, and a running request. Screenshot observations are not proof of runtime defects.

Repository evidence:

| Area | Current implementation | Consequence for the plan |
| --- | --- | --- |
| Layout and controls | `src/sidebarHtml.ts` owns sidebar CSS, markup, and browser interaction. | Keep tightly coupled layout changes here; do not introduce a new UI framework. |
| Model selection | The picker has a 132px maximum width, an existing provider/model tooltip, and a generic accessible label. | Improve visible identification and accessible value; preserve the existing full-identifier tooltip. |
| Thinking selection | The select already has `aria-label="Pi thinking level"` and a matching title. | Improve visible context and current-value description; do not describe accessibility labels as absent. |
| Attachment estimates | The summary reads `state.attachmentEstimate`, not the composer input. | Treat the zero-character observation as ambiguous labeling unless tests prove a counting defect. |
| Image previews | Composer and transcript images use `object-fit: cover`; transcript images can grow across the grid. A full-image dialog already exists. | Fix thumbnail layout and discovery rather than add a second preview mechanism. |
| Toolbar | Delete is already hidden when no deletable session exists. | Check actual session state before changing visibility rules. A new-looking session can still have a persistent file. |
| Runtime notices | `src/sidebar.ts` uses generic warning summaries with bounded details. | Improve known-event summaries without exposing raw diagnostics in the primary notice. |
| Running requests | Status, Stop, input locks, and hints already use foreground state. | Check visibility and wording across states; do not add a separate progress state machine. |
| Queue semantics | Enter submits Next after the current tool; the platform-specific alternate shortcut submits After this when the response finishes. | Preserve both behaviors and use the existing platform shortcut selection. |
| Tests | `src/test/sidebarHtml.test.ts`, `scripts/test-rich-content.mjs`, `scripts/test-thinking-picker.mjs`, and native fixture tests cover relevant surfaces. | Extend these checks instead of relying on screenshots alone. |

The apparent inner scrollbar in the final screenshot may be pixels in the attached image. Do not classify it as nested interactive scrolling without a browser reproduction.

## Scope and constraints

- Preserve starter cards, conversation titles, attachment removal, focus visibility, and Markdown hierarchy.
- Preserve trust, permission, read-only, Preview/Apply, stale-content, and deletion confirmation checks in `docs/SECURITY.md`.
- Preserve image validation, cache limits, metadata-only persistence, CSP, sanitization, and preview focus restoration.
- Preserve explicit submission, queue limits, queue uncertainty notices, and Stop behavior. Do not retry or resend automatically.
- Keep changes in source and test files. Do not edit generated assets or VSIX archives.
- Do not install the extension, publish a release, or use a live model for validation without separate approval.
- Do not add settings, feature flags, queue modes, external assets, or provider-specific model aliases for these fixes.

## Plan

### 1. Establish reproducible states

- [x] Add deterministic fixtures for empty and persisted-empty sessions, long responses, draft and submitted images, warnings, and running requests.
  - Use the sidebar browser harness and existing native Pi fixture; no live provider is needed.
  - Include portrait, landscape, and very tall images, long filenames, missing image bytes, and long model names.
  - Include idle, startup, tool work, response generation, settling, cancelling, disconnected, and queue-uncertain states.
  - Acceptance evidence: fixtures reproduce each applicable finding or record why the screenshot observation is not a defect.
- [x] Verify the ambiguous observations before changing behavior.
  - Confirm attachment-only character accounting and model display-name provenance.
  - Inspect computed image/button layout to distinguish thumbnail cropping from flex layout and scrollbar pixels.
  - Check existing tooltips, keyboard preview, status visibility, and toolbar actions in each session state.
  - Acceptance evidence: regression tests identify the actual cause; disproved findings have a recorded disposition in this plan.

### 2. Make status and warnings actionable

- [x] Improve runtime notice summaries in `src/sidebar.ts` and the notice presentation in `src/sidebarHtml.ts`.
  - Use a short, bounded cause and a valid next action when the event provides enough information.
  - Keep unknown warnings generic but explicitly direct users to `View diagnostic`.
  - State whether work can continue only when foreground/runtime state proves that claim.
  - Keep raw diagnostics and sensitive paths in the existing explicit detail surface.
  - Preserve queue-uncertainty precedence and notice-clearing rules; a warning must not imply a safe resend.
  - Acceptance evidence: tests cover known and unknown warnings, protocol errors, safe diagnostic rendering, details activation, and queue uncertainty.
- [x] Keep running status visible in the compact footer using the existing foreground state.
  - Use operation-specific labels when available and a short fallback such as `Working…` otherwise.
  - Keep Stop visible for every cancellable phase; distinguish cancellation and disconnection from normal progress.
  - Acceptance evidence: fixture checks confirm status text and Stop availability across the phase matrix without duplicate live announcements on every streamed update.

### 3. Clarify model and thinking settings

- [x] Adjust responsive model selection so its identity is readable at ordinary panel widths.
  - Remove the unnecessarily restrictive fixed maximum at wider widths; allow flexible width or a separate settings row at narrow widths.
  - Use the runtime display name without inventing aliases. Retain the full provider/model identifier in the tooltip.
  - Include the selected model in the accessible name or description. At extremely narrow widths, truncation is permitted only with the full value available through keyboard access.
  - Acceptance evidence: browser checks show an uncut representative model name at 600px and 960px, and usable controls at 180–400px with long names.
- [x] Add visible context to the thinking setting.
  - Show `Thinking` beside the selected value when space permits; keep a compact control at narrow widths.
  - Retain the existing accessible label and expose the current value and unavailable-state reason.
  - Acceptance evidence: all supported levels and the unsupported state pass browser and DOM checks with no overlap or clipped primary action.
- [x] Improve disabled-control presentation.
  - Keep disabled model/thinking values legible and explain when settings are locked during active work.
  - Keep the disabled Send arrow recognizable without making it look actionable.
  - Acceptance evidence: dark, light, and high-contrast review confirms a clear active/disabled distinction; enabled controls meet applicable contrast requirements.

### 4. Repair attachment layout and labeling

- [x] Replace ambiguous attachment estimates with explicitly scoped text.
  - Label counts as attachment text, not prompt text. For image-only drafts, prefer an image count over a misleading zero-text summary.
  - Move detailed character and estimated-token information into the existing attachment inspection surface where practical.
  - Keep the image-token exclusion explicit wherever text-token estimates appear.
  - Acceptance evidence: tests cover image-only, text-only, mixed, removed, and empty attachments; typing a prompt does not change an attachment-only count.
- [x] Make draft attachments compact without losing inspection or removal controls.
  - Use bounded thumbnails that preserve the complete image and aspect ratio rather than crop it.
  - Keep filenames readable outside the image area and keep remove controls separate from preview activation.
  - Acceptance evidence: one and multiple draft images leave the input and actions usable at short viewport heights; keyboard preview and removal remain operable.
- [x] Correct submitted-image cards in the transcript.
  - Bound thumbnail width and height, use containment, and place the filename below the image rather than beside it in a narrow column.
  - Make full-image activation discoverable with an accessible action such as `Open image preview`.
  - Reuse the existing dialog, Escape/close handling, and trigger-focus restoration.
  - Retain labeled unavailable placeholders and safe scroll compensation when images load.
  - Acceptance evidence: portrait, landscape, tall, multiple, and unavailable-image browser cases show no unintended crop, filename side column, or page-level overflow; native keyboard preview still works.

### 5. Clarify in-flight submission and responsive composer actions

- [x] Use a running-state placeholder such as `Write a follow-up…` and explain both queue actions.
  - Describe Next as submission after the current tool finishes and After this as submission after the response finishes.
  - Provide visible, keyboard-accessible submission controls for both actions while keeping Stop separate.
  - Preserve existing Enter, Shift+Enter, and platform-specific alternate shortcuts, queue limits, attachment handling, and pending-message labels.
  - Keep locked, disconnected, unsupported, and queue-uncertain states explicit; never offer submission when the host rejects it.
  - Acceptance evidence: DOM and browser tests prove each visible action and shortcut submits exactly one intended queue kind, with the same captured attachments.
- [x] Reflow composer actions at narrow widths.
  - Move model/thinking settings to another row when needed rather than shrink primary actions into unreadable controls.
  - Keep Attach, Stop, and submission actions reachable with no horizontal page scroll.
  - Show shortcut help only when relevant, without making it the only way to discover an action.
  - Acceptance evidence: layout cases at widths 180, 220, 280, 400, 600, and 960px and heights 420 and 800px cover idle, running, multiline input, and attachment drafts.

### 6. Improve transcript, toolbar, and footer hierarchy

- [x] Limit long assistant prose to approximately 70–80ch at wide panel widths.
  - Keep headings, lists, and paragraphs aligned within the reading column.
  - Allow code, tables, math, and diagrams to use available message width with local overflow where required.
  - Acceptance evidence: browser geometry checks confirm the prose width and preserve rich-content rendering without document-level horizontal overflow.
- [x] Add consistent clearance between the final response and composer.
  - Ensure the final paragraph remains fully visible when the input grows or attachments arrive.
  - Preserve bottom-following readers and the position of users reading older messages; do not force scroll-to-bottom.
  - Acceptance evidence: browser checks cover input resizing, attachment loading/removal, streaming, and manual transcript scrolling at short heights.
- [x] Reduce toolbar emphasis without removing useful session actions.
  - Keep Back and New available where they have an effect. Hide or disable invalid actions from actual session state, not visual emptiness.
  - Use neutral styling for Delete at rest, with destructive emphasis on hover/focus or confirmation.
  - Preserve modal confirmation, Trash behavior, and the separately confirmed permanent-delete fallback.
  - Acceptance evidence: session-state DOM tests and existing deletion tests pass; native checks confirm confirmation is still required.
- [x] Simplify persistent footer information.
  - Keep connection/work status and context usage visible. Move session ID to an explicit details surface or existing session menu while keeping it copyable.
  - Reduce permanent shortcut text through contextual help, without hiding submission semantics or recovery actions.
  - Acceptance evidence: users can reach the full session identifier by keyboard; narrow layouts retain status, context, reconnect, and recovery controls without overlap.

### 7. Validate and document the complete change

- [x] Extend unit and browser regression tests for all implemented findings.
  - Primary files: `src/test/sidebarHtml.test.ts`, applicable host lifecycle tests, `src/test/imageAssets.test.ts`, `src/test/attachmentUtils.test.ts`, `scripts/test-rich-content.mjs`, and `scripts/test-thinking-picker.mjs`.
  - Use real browser geometry for layout claims; string snapshots alone are not sufficient.
  - Acceptance evidence: each resolved finding has an automated assertion or an explicit manual review record.
- [x] Run the local code and browser checks with Node.js 22.19 or newer and locked dependencies.
  - Use `npm ci` if dependencies need installation. Browser checks require local Playwright Chromium.
  - Run `npm test` and `npm exec --yes --package=@biomejs/biome@2.5.13 -- biome check src resources`.
  - Run `npm run test:rich-content` and `npm run test:thinking-picker`; both compile first.
  - Acceptance evidence: record commands, results, and any unavailable prerequisite. Do not mark missing browser checks passed.
- [x] Run isolated native checks for minimum and current VS Code versions.
  - Extension Host: `xvfb-run -a npm run test:native -- 1.106.0` and `stable` passed on Linux.
  - Native UI: `xvfb-run -a npm run test:native-ui -- 1.106.0` and `stable` passed on Linux.
  - Fixtures cover image preview/Escape/focus restoration, both queue actions, Stop/recovery, copyable session details, deletion confirmation, and 200% zoom geometry in dark, light, and high-contrast themes.
  - Current `stable` resolved to VS Code 1.142.0.
- [ ] Complete platform, remote, and assistive-technology checks, or obtain explicit user acceptance of deferral.
  - Windows, macOS, and remote Extension Hosts are unavailable in this Linux environment.
  - Screen-reader spoken labels/announcements require an assistive-technology review. DOM labels, keyboard focus/order, and unchanged-status live-region mutation checks passed; these are not a screen-reader test.
  - Visual review used browser and native-DOM snapshots. Native geometry was checked at actual 200% zoom; Electron CDP clips iframe screenshots incorrectly at that zoom, so screenshots use the captured native DOM/styles at the measured viewport.

- [x] Update `README.md` and `docs/FEATURE_MATRIX.md` for the final user-visible behavior and add a `.changeset/*.md` release entry.
  - Document final queue labels, shortcut help, attachment details, and session-details access.
  - Update `docs/SECURITY.md` only if the documented presentation contract changes; do not weaken its boundaries.
  - Acceptance evidence: documentation matches verified behavior; no version or changelog update is made by hand.

## Execution evidence

### Finding dispositions

- Attachment counts were attachment-only by design, not a prompt-counting defect. Unit tests now prove that typing does not change them. Image-only drafts show image counts; text counts say `attachment text characters`. Detailed estimates remain in Attach → View attachments and exclude image tokens.
- Model names come directly from Pi (`name`, then `id`); no aliases were added. The full provider/model tooltip remains. Browser geometry proves a representative name is uncut at 600px and 960px; long-name controls remain usable at narrow widths.
- Both thinking controls already had accessible labels. The change adds visible Thinking context, current-value/unavailable descriptions, and lock explanations without replacing those labels.
- Delete visibility already depended on a persistent session file. Empty and persisted-empty fixtures confirm that rule; it was retained. Only resting destructive emphasis changed. Native modal cancellation keeps the session file; existing Trash/permanent-fallback tests pass.
- Image cropping came from `object-fit: cover`; the filename side column came from the shared horizontal button layout. Thumbnails now use containment, bounded columns, vertical transcript cards, and separate removal controls. The apparent screenshot scrollbar was not reproduced as an interactive image scrollbar; no speculative nested-scroll removal was made.
- Full-image preview already existed. It was retained, given an explicit accessible action, and tested with Escape/focus restoration. A rapid close/reopen fixture found a deferred-close race; stale close events now leave a newer preview intact.
- Foreground state already supplied cancellable phases and operation labels. No progress state machine was added. Equal status text no longer mutates the live region during streaming. Fallback active status is Working, not Ready.
- Queue semantics remain native: Next uses `steer`, After this uses `followUp`, with the same attachment capture and acceptance path. Both visible controls and shortcuts are tested. Slash commands, full queues, disconnected/unsupported states, duplicate acceptance, and image gates remain blocked; the host retains authoritative limits and recovery checks.
- Native 200% zoom exposed inherited VS Code body padding and short-panel composer clipping. The sidebar now owns its outer padding and bounds shrinkable attachment/queue areas while keeping primary controls visible. Native assertions check both viewport and composer clipping bounds.
- Long prose is limited to 78ch. Code, tables, math, and diagrams keep their existing local overflow. Resize/stream/image cases preserve bottom-following readers and readers viewing older content.

### Verification results

| Check | Result |
| --- | --- |
| Runtime/dependencies | Node.js 26.8.2; existing locked dependencies present; `npm ls --depth=0` passed. No dependency changes. |
| `npm test` (also run by package and pre-commit) | 48 files, 395 tests passed after rebasing onto current main. |
| Biome 2.5.13 `check src resources` | Exit 0; 464 warnings and 17 informational diagnostics, no errors. Warnings were not hidden or treated as errors. |
| `npm run test:rich-content` | Passed: 72 interface layout cases at 180/220/280/400/600/960px and 420/800px; four image cases; eight foreground phases; keyboard, stable live-region, scroll, CSP, sanitization, and rich-renderer lifecycle checks. |
| `npm run test:thinking-picker` | Passed: 64 browser cases including Max and unsupported state. |
| `xvfb-run -a npm run test:native -- 1.106.0` | Passed on Linux; 41 encoding cases plus host/workflow safeguards. |
| `xvfb-run -a npm run test:native -- stable` | Passed on Linux, VS Code 1.142.0. |
| `xvfb-run -a npm run test:native-ui -- 1.106.0` | Passed, including new interface controls, modal confirmation, native 200% geometry, and reload cleanup. |
| `xvfb-run -a npm run test:native-ui -- stable` | Passed on Linux, VS Code 1.142.0, with the same interface assertions. |
| `npm run package` | Passed; local VSIX contains 138 files. Archive inspection confirmed compiled sidebar controls, renderer assets, and fonts. No installation or publication. |
| Visual/keyboard review | Browser dark/light/high-contrast snapshots and native-DOM 200% snapshots reviewed. Native preview/Escape/focus restoration, session-ID selection, and queue buttons passed. |
| Screen reader | Not run with assistive technology. DOM names/descriptions and unchanged-live-region tests passed; spoken output is unverified. |
| Windows/macOS/remote | Not run; explicit acceptance of deferral is required. Windows shortcut selection is unit-tested, not platform-tested. |
| Live provider | Not run, as required; all model responses came from deterministic fixtures. |

The branch was rebased onto main at `d263ed2` after the process-launch refactor merged. Its four existing Biome errors were corrected with import ordering and whitespace only in `piClient.ts`, `piRpcClient.ts`, and `piSpawn.ts`; process-launch behavior was not changed. All listed checks were rerun on this integrated base.

During development, checks exposed outdated UI assertions, a concurrent-build race in the generated output directory, missing queue-update events in the new fixture, current-VS-Code chained Quick Pick/focus races, a pending-row presentation race, preview-close timing, and zoom clipping. Tests/builds now run sequentially, fixture acknowledgements match the protocol, and the final runs listed above passed. No failed run is represented as acceptance evidence.

Diff review covered correctness, fixed-text diagnostic summaries, existing trust/edit/deletion/queue/image/CSP boundaries, deferred preview events, resize observation, VS Code 1.106 compatibility, rich-content regressions, and scope. No settings, dependencies, model aliases, request modes, version edits, generated assets, or binaries are included.

## Completion Checklist

- [x] Every screenshot finding has a checked implementation task or a documented, evidence-based no-change disposition.
- [x] Attachment summaries are unambiguous, thumbnails preserve the full image, and preview/removal remain accessible.
- [x] Model identity, thinking context, disabled states, progress, warnings, and in-flight actions are understandable in tested states.
- [x] Long responses, footer metadata, toolbar emphasis, and responsive spacing meet the specified layout checks.
- [ ] Unit, lint, browser, native, and manual-review evidence is recorded; unavailable checks remain open until explicitly accepted as deferred.
- [x] No trust, edit-review, deletion, queue, image-data, CSP, or sanitization safeguards regress.
- [x] User documentation and the release changeset are complete, and the diff contains only intended source, test, and documentation changes.
- [ ] Obtain user acceptance of any remaining deferred checks. When all tasks and completion checks pass, delete this completed plan and report its path.
