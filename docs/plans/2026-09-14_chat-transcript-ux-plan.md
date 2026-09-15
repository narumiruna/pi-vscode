# Chat Transcript UX Plan

## Goal

Make Pi Chat trustworthy and easier to scan by showing submitted images and context on the user turn that consumed them, keeping tool activity beside the related response, reducing visual noise, and presenting one consistent actionable status.

## Context

- `src/sidebarState.ts` stores only message text plus one `contextLabel`; it cannot represent submitted images or individual context items.
- `src/sidebar.ts` adds a user message before submission but records only text-context labels. It sends images to Pi and then consumes them from the composer, so no transcript image remains.
- Pi session history already retains mixed user content. A verified session entry contains a text part followed by `{ type: "image", mimeType, data }`, but `convertPiMessages()` in `src/sidebarHelpers.ts` extracts only text and discards image parts during history synchronization.
- `src/sidebarHtml.ts` has no transcript attachment renderer or image-capable CSP. It also places tool activity in a separate fixed grid row, applies the editor font size directly to inline code, uses an 82 px minimum composer height, and can leave the attachment-lock warning visible after Pi becomes ready.
- Conversation deletion currently surfaces the raw remote-provider trash error and full session path. The native `pi-caffeinate` completion notification is external extension UI and is outside this plan's ownership.

## Architecture

- Extend `SidebarMessage` with structured transcript attachments. Text context keeps a short display label and full tooltip label; image entries keep a stable asset ID, label, MIME type, dimensions when available, and availability state.
- Keep binary image data out of normal `state` messages and `workspaceState`. Add a bounded Extension Host image-asset cache that validates supported MIME/Base64/decoded size, derives stable IDs from content, evicts oldest payloads at a documented total-byte limit, and sends each needed asset once per Webview lifecycle.
- On submission, snapshot attachment descriptors before composer consumption and associate them with that user turn. On `get_messages` synchronization, parse mixed text/image content, rebuild the same descriptors, and merge locally persisted labels by stable asset ID. If bytes cannot be recovered or are evicted, preserve an explicit unavailable-image placeholder.
- Let the Webview cache validated asset payloads and render thumbnails with DOM APIs. A keyboard-accessible modal preview owns close, Escape, focus return, and object/data URL cleanup. CSP permits only the minimum image source required; scripts and styles remain nonce-only.
- Move request tool activity into the conversation scroll flow after the current response. Keep edit proposals, file changes, and background agents in their existing workflow area unless later evidence justifies a broader redesign.
- Derive composer locks, Stop/Send visibility, hints, and transient notices from the same foreground request state. Errors show a short summary first; details remain available through an explicit action or native detail surface.

## Non-Goals

- Changing Pi's RPC image format, model image limits, or session-file format.
- Persisting duplicate Base64 image payloads in VS Code workspace storage.
- Rebuilding the native `@pi` Chat participant or suppressing notifications emitted by other Pi extensions.
- Persisting historical tool output that Pi's `get_messages` API does not return.

## Assumptions

- Pi continues returning user image parts through `get_messages` as `{ type: "image", mimeType, data }`.
- Historical image filenames are not present in Pi session content. A generic `Image 1` label is acceptable when no locally persisted label can be matched.
- Existing limits remain authoritative: five images per request, 5 MiB per image, supported PNG/JPEG/GIF/WebP only.

## Risks

- Reposting Base64 on every streamed state update would cause large Webview messages and memory churn; binary assets must use a deduplicated one-shot channel with explicit cache bounds.
- Adding `img-src data:` or `blob:` broadens CSP. Restrict it to the selected transport, validate MIME and canonical Base64 in the Extension Host, and never inject image values through `innerHTML`.
- History refresh currently replaces local transcript state. Stable asset IDs and metadata merging must prevent thumbnails or labels from disappearing after a successful request.
- Image decode can change scroll height after render. Preserve the reader's position unless they were already near the bottom.
- Permanent deletion is destructive. Offer it only after Trash is specifically unavailable and require a second modal confirmation.

## Plan

- [x] Define structured transcript attachment and image-asset types in `src/sidebarState.ts`, plus bounded restore/limit behavior that accepts existing `picode.sidebar.messages.v1` records and never persists Base64; verify legacy restore, malformed metadata rejection, descriptor preservation, and character limits with `npm test -- src/test/sidebarState.test.ts`.
- [x] Add a focused image-asset cache/parser module and update `src/sidebarHelpers.ts` to extract mixed Pi text/image parts, validate image payloads, derive stable IDs, preserve generic placeholders, merge known labels, cap aggregate history image work newest-first, and retain bounded browser-rejection IDs; verify duplicate images, unsupported MIME, malformed/oversized Base64, eviction, re-admission blocking, aggregate processing limits, and the observed text-plus-image history shape with focused Vitest coverage.
- [x] Update `src/sidebarAttachments.ts` and the foreground submission path in `src/sidebar.ts` to snapshot all consumed text/image descriptors onto the exact user turn before clearing the composer, retain assets for retry/current rendering, and keep attachments added during startup on the next draft; verify successful, rejected, cancelled, retry, and revision-race paths with controller/state tests.
- [x] Update history synchronization and persistence in `src/sidebar.ts` so refresh, reconnect, session resume, compaction, and Extension Host reload reconstruct image descriptors from Pi history while `workspaceState` stores metadata only; verify that serialized state and routine streamed `state` payloads contain no image Base64 and that restored labels merge by stable asset ID.
- [x] Add a bounded one-shot Extension Host-to-Webview image asset protocol in `src/sidebar.ts`, `src/sidebarHelpers.ts`, and `src/sidebarHtml.ts`; reset delivery tracking for each resolved Webview and resend only assets referenced by visible messages; verify protocol bounds, deduplication across repeated state updates, cache eviction placeholders, and Webview recreation in automated tests.
- [x] Render transcript context chips and responsive image thumbnail grids inside each user message in `src/sidebarHtml.ts`; add filename/short-label text, full-label tooltips, loading/unavailable states, accessible alternative text, and click/Enter/Space preview with Escape/close/focus return; update CSP minimally and verify DOM construction without user-controlled `innerHTML`, keyboard behavior, and 280/400/600 px layouts.
- [x] Refactor `src/sidebarHtml.ts` layout so tool activity follows the active response inside the conversation scroller, the empty composer starts at one compact row and grows to its existing cap, inline code stays near body size, long chips/statuses truncate cleanly, and delayed image decode preserves scroll position; verify generated CSS/DOM ordering and scroll rules in `src/test/sidebarHtml.test.ts`.
- [x] Consolidate owned busy/ready UI in `src/sidebarHtml.ts` and `src/sidebar.ts`: clear attachment-lock warnings when the lock ends, show Stop whenever a cancellable request is active, avoid simultaneous Ready/wait messaging, and replace raw operational errors with a short summary plus an explicit details path; add transition tests for sending, working, tool execution, settling, cancellation, failure, and reconnection.
- [x] Add a trash-unsupported recovery path in `src/piRuntime.ts` and `src/sidebar.ts` that summarizes the remote limitation, keeps the conversation intact by default, offers separately confirmed permanent deletion without putting the full session path in the primary notice, and clears a stale transcript if recovery starts a replacement session; verify unsupported-provider, user-cancel, replacement identity, permanent-delete success, and permanent-delete failure paths.
- [x] Update `README.md`, `CHANGELOG.md`, `docs/FEATURE_MATRIX.md`, `docs/SECURITY.md`, and `docs/WORKFLOW_VALIDATION.md` with transcript image behavior, binary-data lifetime/bounds, unavailable placeholders, preview accessibility, tool placement, and status/error behavior; verify documented commands and limits against the implementation.
- [ ] Run `npm test` and `npm run package`, inspect the intended diff and VSIX contents, then manually validate the packaged extension in VS Code using light, dark, and high-contrast themes at 280, 400, and 600 px Sidebar widths; record evidence for image send/history/reload/preview, scrolling, tool placement, status transitions, remote Trash fallback, keyboard-only use, and screen-reader labels.

## Completion Checklist

- [x] Every submitted image appears under the user turn that sent it immediately after acceptance and remains identifiable after response completion, history refresh, Sidebar hide/show, Extension Host reload, and session resume.
- [x] Multiple images render as bounded responsive thumbnails; preview works with pointer and keyboard, Escape closes it, focus returns to the trigger, and unavailable payloads remain visible as labeled placeholders.
- [x] No Base64 image data is written to `workspaceState` or repeated in routine streamed `state` messages; all image payloads, descriptor counts, and total cache bytes are bounded and validated.
- [x] Text context uses short readable labels in the transcript and exposes the full source in a tooltip without breaking narrow layouts.
- [x] Completed/running tool activity is adjacent to the relevant current response and no longer creates a large blank region between a short answer and its activity.
- [x] Inline code does not enlarge line height unexpectedly, the empty composer is compact, and conversation position remains stable when thumbnails load.
- [x] The composer never shows Ready together with a wait/cancel attachment warning; every cancellable state exposes Stop and stale transient warnings clear when their condition ends.
- [x] Remote Trash failure does not expose a long internal path as the primary error, does not delete by default, and requires a second confirmation before permanent deletion.
- [x] Legacy text-only stored conversations still load, unsupported image history degrades safely, and existing attachment count/size/model-capability checks continue to pass.
- [ ] `npm test` and `npm run package` pass, and packaged Extension Host checks cover the responsive, theme, accessibility, persistence, and error-recovery scenarios above.

## Verification Evidence

- `npm test`: 150 tests pass across 30 files.
- `npm run package`: repeats the passing suite and creates a 53-entry VSIX containing 42 compiled runtime modules; production dependency audit reports zero vulnerabilities.
- Chrome for Testing 153 renders generated packaged-equivalent Webview HTML at 280, 400, and 600 px in light, dark, and high-contrast fixtures without horizontal overflow; keyboard preview open/close and focus return pass.
- Native screen-reader output, live Pi provider image history/reload/session resume, and an actual remote provider's Trash behavior remain unverified in an interactive Extension Development Host and are explicitly recorded in `docs/WORKFLOW_VALIDATION.md`.
