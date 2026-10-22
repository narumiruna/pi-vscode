---
"narumi-pi": patch
---

Fix startup after upgrades or reloads when an older version remembered an unwritten Pi session path.
Remember only saved sessions and offer explicit recovery for an absent restore file without changing existing session files or external executable overrides.
