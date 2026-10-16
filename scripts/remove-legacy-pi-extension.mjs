import { lstat, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const extensionsDirectory = join(agentDirectory, "extensions");

for (const filename of ["picode.ts", "pi-vscode.ts"]) {
  const target = join(extensionsDirectory, filename);
  try {
    await lstat(target);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      continue;
    }
    throw error;
  }
  await rm(target, { force: true });
  process.stdout.write(`Removed legacy global Pi bridge extension: ${target}\n`);
}
