import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piPackage from "@earendil-works/pi-coding-agent";

const readOnlyPolicyMarker = "<<<PI_VSCODE_POLICY: read-only>>>";
const readOnlyTools = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "vscode_context",
  "vscode_code_context",
  "vscode_annotate",
]);

export default function (pi: ExtensionAPI) {
  pi.registerCommand("vscode-pi-read-only-ready", {
    description: `VS Code read-only direct-shell policy v1; Pi ${piPackage.VERSION}`,
    handler: async () => {
      throw new Error("This capability marker is discovery-only.");
    },
  });
  // Pi dispatches extension commands before input handlers. An absent control command must
  // never become model input, including a catalog/dispatch race during resource replacement.
  pi.on("input", (event, ctx) => {
    if (/^\/vscode-pi-control(?:\s|$)/.test(event.text)) {
      ctx.ui.notify("The packaged VS Code control command is unavailable. Input was blocked.", "error");
      return { action: "handled" };
    }
  });
  let policyActive = false;
  let previousTools: string[] | undefined;

  const restoreTools = () => {
    if (previousTools) {
      pi.setActiveTools(previousTools);
    }
    previousTools = undefined;
    policyActive = false;
  };

  pi.on("before_agent_start", (event) => {
    if (!event.prompt.startsWith(`${readOnlyPolicyMarker}\n`)) {
      return;
    }
    if (!policyActive) {
      previousTools = pi.getActiveTools();
    }
    policyActive = true;
    pi.setActiveTools(pi.getActiveTools().filter((tool) => readOnlyTools.has(tool)));
  });

  pi.on("tool_call", (event) => {
    if (policyActive && !readOnlyTools.has(event.toolName)) {
      return {
        block: true,
        reason: `Blocked ${event.toolName}: this VS Code editor action is preview-only.`,
      };
    }
  });

  pi.on("user_bash", () => {
    if (policyActive) throw new Error("Direct shell blocked: this VS Code editor action is preview-only.");
  });

  pi.on("agent_settled", restoreTools);
  pi.on("session_shutdown", restoreTools);
}
