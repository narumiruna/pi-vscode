import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const readOnlyPolicyMarker = "<<<PI_VSCODE_POLICY: read-only>>>";
const readOnlyTools = new Set(["read", "grep", "find", "ls", "vscode_context"]);

export default function (pi: ExtensionAPI) {
  let policyActive = false;
  let previousTools: string[] | undefined;

  const restoreTools = () => {
    if (previousTools) {
      pi.setActiveTools(previousTools);
    }
    previousTools = undefined;
    policyActive = false;
  };

  pi.on("before_agent_start", event => {
    if (!event.prompt.includes(readOnlyPolicyMarker)) {
      return;
    }
    if (!policyActive) {
      previousTools = pi.getActiveTools();
    }
    policyActive = true;
    pi.setActiveTools(pi.getActiveTools().filter(tool => readOnlyTools.has(tool)));
  });

  pi.on("tool_call", event => {
    if (policyActive && !readOnlyTools.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked ${event.toolName}: this VS Code editor action is preview-only.`,
      };
    }
  });

  pi.on("agent_settled", restoreTools);
  pi.on("session_shutdown", restoreTools);
}
