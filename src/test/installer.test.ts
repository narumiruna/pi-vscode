import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

test("source installer replaces the previous bridge with the Pi bridge", async () => {
  const agentDirectory = await mkdtemp(path.join(tmpdir(), "picode-installer-"));
  const extensionsDirectory = path.join(agentDirectory, "extensions");
  const repositoryRoot = path.resolve(__dirname, "..", "..");
  const previousBridge = path.join(extensionsDirectory, "pi-vscode.ts");
  const installedBridge = path.join(extensionsDirectory, "picode.ts");

  try {
    await mkdir(extensionsDirectory, { recursive: true });
    await writeFile(previousBridge, "stale bridge");
    execFileSync(process.execPath, [path.join(repositoryRoot, "scripts", "install-picode-extension.mjs")], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    assert.equal(
      await readFile(installedBridge, "utf8"),
      await readFile(path.join(repositoryRoot, "resources", "picode-bridge.ts"), "utf8"),
    );
    await assert.rejects(readFile(previousBridge), { code: "ENOENT" });
  } finally {
    await rm(agentDirectory, { recursive: true, force: true });
  }
});
