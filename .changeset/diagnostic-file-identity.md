---
"pi-coding-agent-vscode": patch
---

Prevent workspace diagnostic repair from sending file contents loaded through a raced symlink. Bind newly loaded and clean document text to safely captured disk bytes while preserving existing dirty buffers, workspace aliases and native Preview/Apply/Undo.
