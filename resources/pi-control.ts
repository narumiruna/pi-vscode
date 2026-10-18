import { realpath } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Host-only, narrow command route. No tool, bridge mutation endpoint, or model request. */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("vscode-pi-control", {
    description: "Internal VS Code resource reload and session navigation",
    handler: async (args, ctx) => {
      if (args.length > 4_096) throw new Error("Control payload exceeds its limit.");
      const payload: unknown = JSON.parse(args);
      if (typeof payload !== "object" || payload === null) throw new Error("Invalid control payload.");
      const data = payload as Record<string, unknown>;
      const cwd = await realpath(ctx.cwd);
      if (
        (data.action !== "reload" && data.action !== "navigate") ||
        typeof data.token !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(data.token) ||
        typeof data.cwd !== "string" ||
        ctx.sessionManager.getSessionId() !== data.sessionId ||
        ctx.sessionManager.getLeafId() !== data.leafId ||
        cwd !== data.cwd ||
        !ctx.isIdle()
      )
        throw new Error("Stale or invalid control request.");
      if (data.action === "reload") {
        if (typeof ctx.reload !== "function") throw new Error("This Pi version does not support resource reload.");
        await ctx.reload();
        return; // The old context is invalid after reload.
      }
      if (typeof data.targetId !== "string" || !ctx.sessionManager.getEntry(data.targetId))
        throw new Error("Navigation target is no longer available.");
      if (typeof ctx.navigateTree !== "function") throw new Error("This Pi version does not support navigation.");
      const result = await ctx.navigateTree(data.targetId, { summarize: false });
      ctx.ui.notify(
        `PI_VSCODE_CONTROL_RESULT:${JSON.stringify({ token: data.token, cancelled: result.cancelled })}`,
        "info",
      );
    },
  });
}
