import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as piPackage from "@earendil-works/pi-coding-agent";

const dangerousCommandPatterns = [
  /\brm\s+(-[^\s]*r[^\s]*f|--recursive|--force)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[^\s]*f|push\s+--force)\b/i,
  /\b(curl|wget)\b[^\n|;&]*(\||&&|;)\s*(sh|bash|zsh)\b/i,
];

export default function (pi: ExtensionAPI) {
  // Safe discovery only: the command never executes shell or invokes a provider.
  pi.registerCommand("vscode-pi-permission-ready", {
    description: `VS Code direct-shell policy; Pi ${piPackage.VERSION}`,
    handler: async () => {
      throw new Error("This command is capability metadata, not an execution route.");
    },
  });

  pi.on("user_bash", async (event, ctx) => {
    // Pi 1.3.0 validates this event's result and rethrows handler errors. Older
    // runtimes must not receive bash RPC from the host, even to probe support.
    if (piPackage.VERSION !== "1.3.0") throw new Error("Direct shell requires the verified Pi 1.3.0 event contract.");
    if (!ctx.hasUI || ctx.mode !== "rpc") throw new Error("Direct shell requires the VS Code approval UI.");
    if (
      !event.command.trim() ||
      event.command.length > 8_000 ||
      /[\p{Cc}\p{Cf}]/u.test(event.command.replace(/[\n\r\t]/g, ""))
    )
      throw new Error("Direct shell command exceeds the supported bounds or contains hidden controls.");
    const sessionId = ctx.sessionManager.getSessionId();
    const allowed = await ctx.ui.confirm(
      "PI_VSCODE_DIRECT_SHELL_V1",
      JSON.stringify({
        command: event.command,
        cwd: event.cwd,
        excludeFromContext: event.excludeFromContext,
        sessionId,
      }),
      { timeout: 5_000 },
    );
    if (!allowed || ctx.sessionManager.getSessionId() !== sessionId)
      throw new Error("Direct shell blocked: missing, stale, or rejected VS Code approval.");
    // Do not return { block }: that contract belongs only to tool_call.
    // Undefined lets the packaged read-only gate and later policies run.
    return undefined;
  });
  pi.on("tool_call", async (event, ctx) => {
    const mode = process.env.PI_VSCODE_PERMISSION_MODE ?? "dangerous";
    if (mode === "off") {
      return undefined;
    }

    const mutating = event.toolName === "bash" || event.toolName === "edit" || event.toolName === "write";
    if (!mutating) {
      return undefined;
    }

    let needsConfirmation = mode === "all";
    let summary = event.toolName;
    if (event.toolName === "bash") {
      const command = typeof event.input.command === "string" ? event.input.command : "";
      summary = command;
      needsConfirmation ||= dangerousCommandPatterns.some((pattern) => pattern.test(command));
    } else {
      const target = typeof event.input.path === "string" ? event.input.path : "";
      summary = target;
      const resolved = path.resolve(ctx.cwd, target);
      const relative = path.relative(ctx.cwd, resolved);
      const outsideWorkspace = relative.startsWith("..") || path.isAbsolute(relative);
      const sensitive = /(^|[/\\])(\.env(?:\.|$)|\.git(?:[/\\]|$)|credentials?|secrets?)/i.test(target);
      needsConfirmation ||= outsideWorkspace || sensitive;
    }

    if (!needsConfirmation) {
      return undefined;
    }
    if (!ctx.hasUI) {
      return { block: true, reason: `Blocked ${event.toolName}: no permission UI is available.` };
    }

    const allowed = await ctx.ui.confirm(
      `Allow Pi ${event.toolName}?`,
      summary.length > 1_000 ? `${summary.slice(0, 1_000)}…` : summary,
    );
    if (!allowed) {
      return { block: true, reason: `Blocked ${event.toolName} by user.` };
    }
    return undefined;
  });
}
