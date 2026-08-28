# Product Experience Redesign Plan

## Goal

Unify Pi's VS Code workflows around one persistent conversation, simplify the narrow Sidebar interface, support safe image paste and edit proposals, and make loading, cancellation, failure, and recovery explicit without breaking existing commands, settings, sessions, or storage.

## Architecture

- `PiRuntimeManager` becomes one foreground runtime shared by the Sidebar and editor context-menu actions.
- `PiChatViewProvider` owns conversation presentation, native Quick Pick routing, attachment state, recovery actions, and ephemeral edit-proposal callbacks.
- Editor actions send bounded selection context through the shared conversation controller instead of one-shot Pi processes.
- Existing native `@pi` Chat, inline completion, background agents, command identifiers, settings, and persisted Pi sessions remain compatible.

## Risks

- Sharing the runtime can create contention when a context-menu action is invoked during streaming; reject with a clear wait-or-cancel message rather than starting a second foreground process.
- Edit proposal callbacks are process-local; after reload, generated replacement text remains in the Pi transcript but Apply controls cannot be restored safely.
- Large pasted images can overload webview messaging; enforce MIME, encoded-size, decoded-size, count, and model-capability checks on both sides.
- Existing uncommitted bridge work and partial image-paste work must be preserved and integrated without unrelated rollback.

## Plan

- [x] Refactor `src/extension.ts`, `src/sidebar.ts`, and `src/editorActions.ts` around one shared foreground runtime; source routing now sends context-menu actions through `PiConversationController`.
- [x] Add safe edit-proposal lifecycle and Preview, Apply, Reject, stale-document, and failure states; Apply remains disabled until Preview and callbacks recheck document versions.
- [x] Redesign `src/sidebarHtml.ts` around a compact header, native Quick Pick secondary actions, a goal-focused composer, attachment chips, reconnect, and stable state feedback; CSS includes a 340px narrow-width breakpoint.
- [x] Complete bounded clipboard-image paste and text-paste compatibility in `src/sidebar.ts`, `src/sidebarHtml.ts`, and `src/attachmentUtils.ts`; automated tests cover supported MIME, canonical Base64, size bounds, and generated webview behavior.
- [x] Make loading, empty, streaming, success, error, disabled, cancellation, truncation, and recovery states explicit in Sidebar state and rendering; old `v1` stored messages remain accepted.
- [x] Add focused unit tests for prompts, storage compatibility, runtime profiles, request lifecycle and serialization, compaction-safe assistant capture, cross-proposal Apply locking, protocol bounds, image validation, and generated Webview behavior; 52 automated tests pass. Manual Extension Host checks remain unavailable in this non-interactive run.
- [x] Update `README.md`, `CHANGELOG.md`, `docs/FEATURE_MATRIX.md`, and `docs/SECURITY.md` to describe the unified conversation and attachment workflow.
- [x] Run `npm test`, load the packaged Pi extension, run `npm run package`, inspect VSIX contents, inspect the final diff, and install `narumitw.pi-coding-agent@0.0.1`; packaging passes with only the pre-existing missing-repository warning.

## Completion Checklist

- [ ] Context-menu results appear in Pi Chat and support follow-up in the same session.
- [ ] Edit actions require Preview and explicit Apply, and stale edits are blocked.
- [ ] Ctrl/Cmd+V image paste works with existing attachment limits and model checks.
- [ ] Primary controls remain usable at 280px, 400px, and 600px Sidebar widths.
- [ ] Keyboard labels, focus behavior, ARIA state, and non-color status cues are present.
- [x] Existing commands, settings, session files, project trust, and permission gates remain compatible in manifest, storage keys, and automated checks.
- [x] Automated checks and packaging pass; manual context-menu, clipboard, responsive-layout, and screen-reader paths remain explicitly unverified.
