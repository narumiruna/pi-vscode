import { realpathSync } from "node:fs";
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

  let sessionGeneration = 0;
  pi.on("session_start", () => {
    sessionGeneration++;
  });
  pi.on("session_shutdown", () => {
    sessionGeneration++;
  });

  pi.on("user_bash", async (event, ctx) => {
    // Pi 1.3.0 validates this event's result and rethrows handler errors. Older
    // runtimes must not receive bash RPC from the host, even to probe support.
    if (piPackage.VERSION !== "1.3.0") throw new Error("Direct shell requires the verified Pi 1.3.0 event contract.");
    if (!ctx.hasUI || (ctx.mode !== "rpc" && ctx.mode !== "tui"))
      throw new Error("Direct shell requires an RPC or native terminal approval UI.");
    if (
      !event.command.trim() ||
      event.command.length > 8_000 ||
      /[\p{Cc}\p{Cf}]/u.test(event.command.replace(/[\n\r\t]/g, ""))
    )
      throw new Error("Direct shell command exceeds the supported bounds or contains hidden controls.");
    const { command, cwd, excludeFromContext } = event;
    const { mode, sessionManager, ui, signal } = ctx;
    const sessionId = sessionManager.getSessionId();
    const generation = sessionGeneration;
    const contextCwd = ctx.cwd;
    if (
      typeof excludeFromContext !== "boolean" ||
      !path.isAbsolute(cwd) ||
      cwd.length > 8_192 ||
      /[\p{Cc}\p{Cf}]/u.test(cwd) ||
      !sessionId ||
      sessionId.length > 200 ||
      /[\p{Cc}\p{Cf}]/u.test(sessionId)
    )
      throw new Error("Direct shell context exceeds the supported bounds or is invalid.");
    const canonicalCwd = realpathSync(cwd);
    if (
      canonicalCwd.length > 8_192 ||
      /[\p{Cc}\p{Cf}]/u.test(canonicalCwd) ||
      canonicalCwd !== realpathSync(contextCwd) ||
      signal?.aborted
    )
      throw new Error("Direct shell blocked: stale working directory or cancelled request.");
    const payload = JSON.stringify({ command, cwd, excludeFromContext, sessionId });
    if (payload.length > 40_000) throw new Error("Direct shell approval exceeds the supported bounds.");
    // RPC keeps the reserved correlated host protocol and deadline. Native TUI
    // users receive the full text and have no artificial review deadline.
    const allowed =
      mode === "rpc"
        ? await ui.confirm("PI_VSCODE_DIRECT_SHELL_V1", payload, { timeout: 5_000 })
        : await ui.confirm(
            "Allow direct shell command?",
            `Working directory (canonical): ${canonicalCwd}\nContext mode: ${excludeFromContext ? "!! (excluded from model context)" : "! (included in model context)"}\nBoth modes remain in Pi session history.\n\nFull command:\n${command}`,
          );
    if (
      allowed !== true ||
      sessionGeneration !== generation ||
      ctx.sessionManager !== sessionManager ||
      sessionManager.getSessionId() !== sessionId ||
      !ctx.hasUI ||
      ctx.mode !== mode ||
      ctx.ui !== ui ||
      signal?.aborted ||
      ctx.cwd !== contextCwd ||
      realpathSync(contextCwd) !== canonicalCwd ||
      realpathSync(cwd) !== canonicalCwd ||
      event.command !== command ||
      event.cwd !== cwd ||
      event.excludeFromContext !== excludeFromContext
    )
      throw new Error("Direct shell blocked: missing, stale, or rejected approval.");
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
