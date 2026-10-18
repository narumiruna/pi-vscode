import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import path from "node:path";
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
        (data.action !== "reload" && data.action !== "navigate" && data.action !== "session-location") ||
        typeof data.token !== "string" ||
        !/^[a-zA-Z0-9-]{1,100}$/.test(data.token) ||
        typeof data.cwd !== "string" ||
        ctx.sessionManager.getSessionId() !== data.sessionId ||
        ((data.action !== "session-location" || data.leafId !== undefined) &&
          ctx.sessionManager.getLeafId() !== data.leafId) ||
        cwd !== data.cwd ||
        !ctx.isIdle()
      )
        throw new Error("Stale or invalid control request.");
      if (data.action === "session-location") {
        const sessionId = ctx.sessionManager.getSessionId();
        const source = ctx.sessionManager.getSessionFile();
        const leafId = ctx.sessionManager.getLeafId();
        const entriesHash = hashEntries(ctx.sessionManager.getEntries());
        if (!source) throw new Error("Session transfer requires a saved session.");
        // getSessionDir is independent of dirname(source), including after resuming an external file.
        const sessionDir = await realpath(ctx.sessionManager.getSessionDir());
        const sessionFile = await realpath(source);
        if (
          [sessionDir, sessionFile].some(
            (value) => !path.isAbsolute(value) || value.length > 4_096 || value.includes("\0"),
          )
        )
          throw new Error("Session location exceeds its bounds.");
        if (
          sessionId !== ctx.sessionManager.getSessionId() ||
          source !== ctx.sessionManager.getSessionFile() ||
          leafId !== ctx.sessionManager.getLeafId() ||
          entriesHash !== hashEntries(ctx.sessionManager.getEntries())
        )
          throw new Error("The active session changed during capture.");
        const response = `PI_VSCODE_CONTROL_RESULT:${JSON.stringify({
          token: data.token,
          sessionDir,
          sessionId,
          sessionFile,
          leafId,
          entriesHash,
        })}`;
        if (Buffer.byteLength(response) > 16_384) throw new Error("Session location response exceeds 16 KiB.");
        // This read does not reload resources, change the leaf, or invalidate the current runtime.
        ctx.ui.notify(response, "info");
        return;
      }
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

/** Same JSON.stringify(entry) + LF digest as the host; never serialize the complete tree at once. */
function hashEntries(entries: readonly unknown[]): string {
  if (entries.length > 50_000) throw new Error("Session transfer exceeds 50,000 entries.");
  const hash = createHash("sha256");
  let bytes = 0;
  for (const entry of entries) {
    const serialized = JSON.stringify(entry);
    if (serialized === undefined) throw new Error("Invalid session entry.");
    bytes += Buffer.byteLength(serialized) + 1;
    if (bytes > 32 * 1024 * 1024) throw new Error("Session transfer exceeds 32 MiB.");
    hash.update(serialized).update("\n");
  }
  return hash.digest("hex");
}
