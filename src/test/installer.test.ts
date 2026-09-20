import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(__dirname, "..", "..");
const removalScript = path.join(repositoryRoot, "scripts", "remove-legacy-picode-extension.mjs");
const releaseInstaller = path.join(repositoryRoot, "scripts", "install.sh");

test("source cleanup removes only legacy bridge paths and does not create Pi configuration", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picode-cleanup-"));
  const missingAgentDirectory = path.join(root, "missing-agent");
  const agentDirectory = path.join(root, "agent");
  const extensionsDirectory = path.join(agentDirectory, "extensions");
  const unrelated = path.join(extensionsDirectory, "user-extension.ts");

  try {
    execFileSync(process.execPath, [removalScript], {
      env: { ...process.env, PI_CODING_AGENT_DIR: missingAgentDirectory },
    });
    await assert.rejects(access(missingAgentDirectory), { code: "ENOENT" });

    await mkdir(extensionsDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(extensionsDirectory, "picode.ts"), "legacy bridge"),
      writeFile(path.join(extensionsDirectory, "pi-vscode.ts"), "older legacy bridge"),
      writeFile(unrelated, "keep me"),
    ]);
    execFileSync(process.execPath, [removalScript], {
      env: { ...process.env, PI_CODING_AGENT_DIR: agentDirectory },
    });

    await assert.rejects(access(path.join(extensionsDirectory, "picode.ts")), { code: "ENOENT" });
    await assert.rejects(access(path.join(extensionsDirectory, "pi-vscode.ts")), { code: "ENOENT" });
    assert.equal(await readFile(unrelated, "utf8"), "keep me");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("release installer installs only the VSIX and safely removes exact legacy bridge paths", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "picode-release-installer-"));
  const fakeBin = path.join(root, "bin");
  const home = path.join(root, "home");
  const agentDirectory = path.join(root, "agent");
  const extensionsDirectory = path.join(agentDirectory, "extensions");
  const codeLog = path.join(root, "code.log");
  const curl = path.join(fakeBin, "curl");
  const code = path.join(fakeBin, "code");

  try {
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      curl,
      `#!/bin/sh\nset -eu\noutput=""\nwhile [ "$#" -gt 0 ]; do\n  if [ "$1" = "--output" ]; then output="$2"; shift 2; else shift; fi\ndone\nprintf 'fixture-vsix' > "$output"\n`,
    );
    await writeFile(code, `#!/bin/sh\nset -eu\nprintf '%s\\n' "$*" > "$CODE_LOG"\n`);
    await Promise.all([chmod(curl, 0o755), chmod(code, 0o755), mkdir(home)]);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:/usr/bin:/bin`,
      HOME: home,
      PI_CODING_AGENT_DIR: agentDirectory,
      CODE_LOG: codeLog,
    };

    execFileSync("sh", [releaseInstaller, "0.0.2"], { env });
    await assert.rejects(access(agentDirectory), { code: "ENOENT" });
    assert.match(await readFile(codeLog, "utf8"), /--install-extension .*pi-coding-agent-vscode\.vsix --force/);

    await mkdir(extensionsDirectory, { recursive: true });
    await Promise.all([
      writeFile(path.join(extensionsDirectory, "picode.ts"), "legacy bridge"),
      writeFile(path.join(extensionsDirectory, "pi-vscode.ts"), "older legacy bridge"),
      writeFile(path.join(extensionsDirectory, "user-extension.ts"), "keep me"),
    ]);
    execFileSync("sh", [releaseInstaller, "0.0.2"], { env });

    await assert.rejects(access(path.join(extensionsDirectory, "picode.ts")), { code: "ENOENT" });
    await assert.rejects(access(path.join(extensionsDirectory, "pi-vscode.ts")), { code: "ENOENT" });
    assert.equal(await readFile(path.join(extensionsDirectory, "user-extension.ts"), "utf8"), "keep me");

    const source = await readFile(releaseInstaller, "utf8");
    assert.doesNotMatch(source, /unzip|bridge_source|mkdir -p|cp .*picode/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
