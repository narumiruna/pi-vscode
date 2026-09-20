import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

export const legacyGlobalBridgeFilenames = ["picode.ts", "pi-vscode.ts"] as const;

export function defaultPiAgentDirectory(
  environment: NodeJS.ProcessEnv = process.env,
  homeDirectory = homedir(),
): string {
  return environment.PI_CODING_AGENT_DIR || path.join(homeDirectory, ".pi", "agent");
}

export async function removeLegacyGlobalBridgeExtensions(
  agentDirectory = defaultPiAgentDirectory(),
): Promise<readonly string[]> {
  const removed: string[] = [];
  const extensionsDirectory = path.join(agentDirectory, "extensions");
  for (const filename of legacyGlobalBridgeFilenames) {
    const target = path.join(extensionsDirectory, filename);
    try {
      await lstat(target);
    } catch (error) {
      if (isErrnoException(error) && error.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    await rm(target, { force: true });
    removed.push(target);
  }
  return removed;
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
