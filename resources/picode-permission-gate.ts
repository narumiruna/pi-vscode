import path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const dangerousCommandPatterns = [
  /\brm\s+(-[^\s]*r[^\s]*f|--recursive|--force)/i,
  /\bsudo\b/i,
  /\b(chmod|chown)\b.*\b777\b/i,
  /\bgit\s+(reset\s+--hard|clean\s+-[^\s]*f|push\s+--force)\b/i,
  /\b(curl|wget)\b[^\n|;&]*(\||&&|;)\s*(sh|bash|zsh)\b/i,
];

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const mode = process.env.PICODE_PERMISSION_MODE ?? "dangerous";
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
