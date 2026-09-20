import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaultPiAgentDirectory, removeLegacyGlobalBridgeExtensions } from "../legacyBridge";

test("defaultPiAgentDirectory prefers the explicit Pi configuration directory", () => {
  assert.equal(defaultPiAgentDirectory({ PI_CODING_AGENT_DIR: "/custom/pi" }, "/home/user"), "/custom/pi");
  assert.equal(defaultPiAgentDirectory({}, "/home/user"), path.join("/home/user", ".pi", "agent"));
});

test("activation cleanup removes exact legacy bridge files without creating configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picode-activation-cleanup-"));
  const missingAgentDirectory = path.join(root, "missing-agent");
  const agentDirectory = path.join(root, "agent");
  const extensionsDirectory = path.join(agentDirectory, "extensions");
  const unrelated = path.join(extensionsDirectory, "user-extension.ts");

  try {
    assert.deepEqual(await removeLegacyGlobalBridgeExtensions(missingAgentDirectory), []);
    await assert.rejects(access(missingAgentDirectory), { code: "ENOENT" });

    await mkdir(extensionsDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(extensionsDirectory, "picode.ts"), "legacy bridge"),
      writeFile(path.join(extensionsDirectory, "pi-vscode.ts"), "older legacy bridge"),
      writeFile(unrelated, "keep me"),
    ]);

    assert.deepEqual(await removeLegacyGlobalBridgeExtensions(agentDirectory), [
      path.join(extensionsDirectory, "picode.ts"),
      path.join(extensionsDirectory, "pi-vscode.ts"),
    ]);
    await assert.rejects(access(path.join(extensionsDirectory, "picode.ts")), { code: "ENOENT" });
    await assert.rejects(access(path.join(extensionsDirectory, "pi-vscode.ts")), { code: "ENOENT" });
    assert.equal(await readFile(unrelated, "utf8"), "keep me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("activation cleanup refuses to recursively delete a directory at a legacy file path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picode-activation-directory-"));
  const legacyDirectory = path.join(root, "extensions", "picode.ts");
  try {
    await mkdir(legacyDirectory, { recursive: true });
    await assert.rejects(removeLegacyGlobalBridgeExtensions(root));
    await access(legacyDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
