---
"narumi-pi": patch
---

Fix Pi 1.3.0 crashes when starting a new sidebar conversation by disposing outgoing bridge callbacks before session API invalidation and cancelling pending event-bus requests without replay.
