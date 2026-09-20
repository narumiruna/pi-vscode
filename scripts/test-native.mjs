import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = process.argv[2] ?? "1.106.0";
const trusted = process.argv[3] !== "untrusted";
const directory = await mkdtemp(path.join(tmpdir(), "pi-native-fixture-"));
try {
  const workspace = path.join(directory, "workspace");
  const userData = path.join(directory, "user");
  await mkdir(workspace);
  await mkdir(path.join(userData, "User"), { recursive: true });
  await writeFile(
    path.join(userData, "User", "settings.json"),
    JSON.stringify({
      "security.workspace.trust.startupPrompt": "never",
      "files.autoSave": "off",
      "telemetry.telemetryLevel": "off",
      "picode.executablePath": path.join(directory, "nonexistent-pi"),
      "workbench.startupEditor": "none",
    }),
  );
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(gitEnv, {
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
    GIT_TERMINAL_PROMPT: "0",
  });
  const git = (...args) =>
    execFileSync("git", ["-c", "commit.gpgsign=false", ...args], { cwd: workspace, env: gitEnv, stdio: "pipe" });
  git("init", "-q");
  await writeFile(path.join(workspace, "source.ts"), "export function greet() { return 1; }\ngreet();\n");
  await writeFile(path.join(workspace, "other.ts"), "export const other = 1;\n");
  await writeFile(path.join(workspace, "tsconfig.json"), "{}");
  git("add", "source.ts", "other.ts", "tsconfig.json");
  git("commit", "-qm", "test: base");
  git("branch", "base");
  await writeFile(path.join(workspace, "other.ts"), "export const other = 2;\n");
  git("add", "other.ts");
  const executable = await downloadAndUnzipVSCode({
    version,
    cachePath: path.join(tmpdir(), "pi-vscode-native-cache"),
  });
  const evidence = path.join(directory, "evidence.json");
  const args = [
    workspace,
    "--no-sandbox",
    "--disable-gpu",
    "--disable-updates",
    "--skip-welcome",
    "--skip-release-notes",
    "--user-data-dir",
    userData,
    "--extensions-dir",
    path.join(directory, "extensions"),
    `--extensionDevelopmentPath=${repository}`,
    `--extensionTestsPath=${path.join(repository, "out", "test", "nativeWorkflow.js")}`,
  ];
  if (trusted) args.push("--disable-workspace-trust");
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      stdio: "inherit",
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(directory, "pi"),
        PICODE_NATIVE_EVIDENCE: evidence,
        PICODE_NATIVE_EXPECT_TRUST: String(trusted),
      },
    });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Native smoke test exceeded 90 seconds."));
    }, 90_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve() : reject(new Error(`Native smoke test exited ${code}`));
    });
  });
  console.log(await readFile(evidence, "utf8"));
} finally {
  await rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 500 });
}
