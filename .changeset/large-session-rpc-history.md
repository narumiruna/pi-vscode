---
"narumi-pi": patch
---

Raise the persistent Pi RPC single-line limit from 5 MiB to 64 MiB for large active-branch history responses.
Reject larger frames with safe diagnostics, stop decoding at the first fatal failure, release retained input and ignore later stdout during bounded cleanup.
Preserve existing session references and files on history failure, without automatic new-session fallback or request replay.
Retained transcript, bridge, one-shot output, attachment and session import/export limits are unchanged.
