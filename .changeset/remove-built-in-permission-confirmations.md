---
"narumi-pi": minor
---

Remove pi-vscode's built-in tool and shell permission confirmations, including the `pi.agent.confirmToolCalls` setting, `PI_VSCODE_PERMISSION_MODE`, the packaged `pi-permission-gate`, and the shell approval handshake. Pi and installed extensions now own permissions. Without a permission policy, tools and commands can run with no confirmation. Sidebar and controlled-terminal `!` / `!!` execution no longer requires extra pi-vscode approval.

Existing Pi-requested dialogs remain unchanged. Workspace trust, project-resource approvals, read-only proposal enforcement, Preview/Apply, stale-content checks, and other workflow confirmations remain in place. Direct-shell Pi 1.3.0 compatibility uses read-only sentinel version metadata without an execution probe. Earlier validation records remain historical evidence.
