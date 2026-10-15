import assert from "node:assert/strict";
import { execFileSync, type SpawnSyncReturns } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(__dirname, "..", "..");
const removalScript = path.join(repositoryRoot, "scripts", "remove-legacy-picode-extension.mjs");
const releaseInstaller = path.join(repositoryRoot, "scripts", "install.sh");
const upgradeCheck = path.join(repositoryRoot, "scripts", "check-legacy-vscode-extension.sh");

test.each([releaseInstaller, upgradeCheck])(
  "upgrade check stops safely before replacing the old ID: %s",
  async (script) => {
    const root = await mkdtemp(path.join(tmpdir(), "picode-upgrade-"));
    const bin = path.join(root, "bin");
    const mutations = path.join(root, "mutations.log");
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, MUTATIONS_LOG: mutations };
    try {
      await mkdir(bin);
      await writeFile(
        path.join(bin, "code"),
        `#!/bin/sh\nset -eu\nif [ "$1" = "--list-extensions" ]; then\n  [ "\${LIST_FAIL:-0}" = 0 ] || exit 7\n  printf '%s\\n' "$INSTALLED_EXTENSIONS"\nelse\n  printf '%s\\n' "$*" >> "$MUTATIONS_LOG"\nfi\n`,
      );
      await writeFile(path.join(bin, "curl"), '#!/bin/sh\nprintf "download\\n" >> "$MUTATIONS_LOG"\nexit 9\n');
      await Promise.all([chmod(path.join(bin, "code"), 0o755), chmod(path.join(bin, "curl"), 0o755)]);
      for (const id of ["narumi.pi-coding-agent-vscode", "NARUMI.PI-CODING-AGENT-VSCODE"]) {
        assert.throws(
          () =>
            execFileSync("sh", [script], {
              env: { ...env, INSTALLED_EXTENSIONS: `other.extension\n${id}\nnarumi.narumi-pi` },
              stdio: "pipe",
            }),
          (error: unknown) => {
            assert.ok(error instanceof Error);
            const failure = error as Error & SpawnSyncReturns<Buffer>;
            assert.equal(failure.status, 1);
            assert.match(failure.stderr.toString(), /Save sessions and worktree results/);
            assert.match(failure.stderr.toString(), /code --uninstall-extension narumi\.pi-coding-agent-vscode/);
            return true;
          },
        );
        await assert.rejects(access(mutations), { code: "ENOENT" });
      }
      assert.throws(
        () => execFileSync("sh", [script], { env: { ...env, LIST_FAIL: "1" }, stdio: "pipe" }),
        (error: unknown) => error instanceof Error && (error as Error & SpawnSyncReturns<Buffer>).status === 7,
      );
      await assert.rejects(access(mutations), { code: "ENOENT" });
      execFileSync("sh", [upgradeCheck], {
        env: {
          ...env,
          INSTALLED_EXTENSIONS: "narumi.narumi-pi\nother.pi-coding-agent-vscode\nnarumi.pi-coding-agent-vscode-extra",
        },
      });
      await assert.rejects(access(mutations), { code: "ENOENT" });
      const recipes = await readFile(path.join(repositoryRoot, "justfile"), "utf8");
      assert.match(
        recipes,
        /install-vsix:\n {4}sh .*check-legacy-vscode-extension\.sh"\n {4}npm run package\n {4}code --install-extension/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

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
