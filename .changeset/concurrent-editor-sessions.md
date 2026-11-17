---
"narumi-pi": minor
---

Add Pi: New Concurrent Session and a Pi view-title plus action for up to eight independent native editor sessions alongside the sidebar.
Require explicit confirmation that sessions share workspace files without isolation.
Keep each panel's RPC process, transcript, composer draft, attachments, queue, model/thinking controls, and Stop independent.
Keep work running while hidden; close only that panel's runtime and retain saved Pi session files.
Do not automatically restore or restart editor panels after reload.
Preserve sidebar-only global workflows, terminal handoff/recovery, restart, and annotations, shared consent-gated draft recovery, and existing security and storage bounds.
Prevent duplicate in-window RPC session-file writers and retain the session slot and writer claim after unverified cleanup until window reload.
Conservatively disable checkpoint restoration after conflicting activity.
Keep workspace-root aliases and reconnect bound to the selected workspace, retain accepted queue recovery on prompt failure, and wait for all detached cleanup before releasing capacity.
Block exclusive workspace workflows after unverified RPC cleanup until window reload, while ordinary agents retain shared admission with unverified checkpoint attribution.
Keep distinct queued instruction and attachment snapshots during uncertain recovery, even when message text is identical.
Reject editor startup, reconnect, and ordinary prompts after the original workspace folder or canonical root changes.
Protect another view's retained draft from late send acknowledgements with shared memory-only writer ownership.
