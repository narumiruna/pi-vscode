import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const result = spawnSync(npm, ["test"], {
  cwd: repositoryRoot,
  stdio: "inherit",
});

if (result.error) {
  console.error(`Failed to run pre-commit checks: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 1);
