---
"pi-coding-agent-vscode": patch
---

Fix failed-test repair in workspaces opened through filesystem aliases, including macOS temporary paths. Preserve the selected editor URI and reject a workspace alias that changes targets during evidence capture, Preview, or Apply. Obtain save/rerun approval and revalidate before applying the repair, so cancellation or rejected aliases leave no dirty repair to save later.
