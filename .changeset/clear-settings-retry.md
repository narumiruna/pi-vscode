---
"narumi-pi": patch
---

Add a retry action for failed automatic settings saves. Return an error when the settings queue is full so rejected saves and resets do not leave rows disabled.
