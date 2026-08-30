import { copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const agentDirectory = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const source = join(repositoryRoot, "resources", "pi-vscode-bridge.ts");
const destinationDirectory = join(agentDirectory, "extensions");
const destination = join(destinationDirectory, "pi-vscode.ts");

await mkdir(destinationDirectory, { recursive: true });
await copyFile(source, destination);
process.stdout.write(`Installed Pi extension: ${destination}\n`);
