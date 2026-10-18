import { runBoundedProcess } from "./boundedProcess";
import { nativeObject } from "./nativePiJson";
import { validMcpName } from "./nativePiModel";
import { buildPiProcessEnvironment, planPiSpawn } from "./piSpawn";

export interface McpDiagnostic {
  readonly checkedAt: string;
  readonly source: "separate-cli";
  readonly outcome: "completed" | "unsupported-or-invalid" | "timeout" | "cancelled" | "output-limit";
  readonly servers: readonly { name: string; state: string; toolCount: number }[];
  readonly configErrorCount?: number;
  readonly cleanup: string;
}

/** Parse only allowlisted metadata. Raw transport/error/stderr text may contain credentials. */
export function projectMcpDiagnostic(text: string): Pick<McpDiagnostic, "servers" | "configErrorCount"> | undefined {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!nativeObject(data) || !Array.isArray(data.servers) || data.servers.length > 100 || !Array.isArray(data.errors))
    return undefined;
  const servers: { name: string; state: string; toolCount: number }[] = [];
  for (const item of data.servers) {
    if (
      !nativeObject(item) ||
      typeof item.name !== "string" ||
      !validMcpName(item.name) ||
      typeof item.state !== "string" ||
      !["connected", "disabled", "disconnected", "connecting", "failed", "needs-auth", "closed"].includes(item.state) ||
      !Array.isArray(item.tools) ||
      item.tools.length > 10000
    )
      return undefined;
    servers.push({ name: item.name, state: item.state, toolCount: item.tools.length });
  }
  return { servers, configErrorCount: Math.min(data.errors.length, 100) };
}

/** Caller must hold the workspace operation and obtain approval immediately before invoking. */
export async function checkNativeMcp(executable: string, cwd: string, signal: AbortSignal): Promise<McpDiagnostic> {
  const env = buildPiProcessEnvironment(process.env, {
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
    PI_SKIP_VERSION_CHECK: "1",
  });
  const plan = planPiSpawn(executable, ["mcp", "list", "--json"], { cwd, env });
  const result = await runBoundedProcess(plan.command, plan.args, {
    cwd,
    env,
    signal,
    timeoutMs: 30_000,
    maxBytes: 128 * 1024,
  });
  const metadata = projectMcpDiagnostic(result.stdout.toString("utf8"));
  return {
    checkedAt: new Date().toISOString(),
    source: "separate-cli",
    outcome:
      result.status !== "exited"
        ? result.status
        : metadata && (result.exitCode === 0 || result.exitCode === 1)
          ? "completed"
          : "unsupported-or-invalid",
    servers: metadata?.servers ?? [],
    configErrorCount: metadata?.configErrorCount,
    cleanup: result.cleanup,
  };
}
