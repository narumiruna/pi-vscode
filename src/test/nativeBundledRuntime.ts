/** Actual Extension Host and packaged Pi. No model, login, existing profile, or fake runtime. */
import assert from "node:assert/strict";
import { chmod, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { runIsolatedPiHelper } from "../isolatedPi";
import { hasOperation } from "../operationLocks";
import { verifyPackagedCommands } from "../piControl";
import type { PiRpcClient } from "../piRpcClient";
import { PiRuntimeManager } from "../piRuntime";
import { initializePiRuntime, readPiInvocationOptions } from "../vscodePi";

interface ChildEvidence {
  pid: number;
  tty: boolean;
  sessionId: string;
  sessionFile: string;
  home: string;
  path: string;
  execPath: string;
  electronRunAsNode: string | null;
  packageDir: string | null;
  argv: string[];
}

export async function run(): Promise<void> {
  const directory = process.env.PI_VSCODE_BUNDLED_DIRECTORY;
  assert.ok(directory && path.isAbsolute(directory));
  assert.equal(process.env.HOME, process.env.PI_VSCODE_BUNDLED_ORIGINAL_HOME, "VS Code HOME must not change");
  assert.equal(String(vscode.workspace.isTrusted), process.env.PI_VSCODE_BUNDLED_EXPECT_TRUST);
  const root = vscode.workspace.workspaceFolders?.[0]?.uri;
  assert.ok(root);
  const extensionRoot = path.resolve(__dirname, "../..");
  initializePiRuntime(extensionRoot);
  const values = new Map<string, unknown>();
  const context = {
    extensionUri: vscode.Uri.file(extensionRoot),
    workspaceState: {
      get: (key: string) => values.get(key),
      update: async (key: string, value: unknown) => {
        values.set(key, value);
      },
    },
    environmentVariableCollection: { clear() {}, replace() {} },
  } as unknown as vscode.ExtensionContext;
  assert.equal(process.env.PATH ?? "", "", "All hosts and Pi children must have no PATH lookup");
  process.env.PATH = ""; // VS Code can remove an empty inherited variable.
  process.env.PI_PACKAGE_DIR = path.join(directory, "must-not-be-used");
  const runtime = new PiRuntimeManager(context);
  const evidence: Record<string, unknown> = {
    version: vscode.version,
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    electron: process.versions.electron ?? null,
    remoteName: vscode.env.remoteName ?? null,
    trusted: vscode.workspace.isTrusted,
    modelRequests: 0,
    guiHomeUnchanged: true,
  };
  let terminal: vscode.Terminal | undefined;
  const nativeWindow = require("vscode").window as typeof vscode.window;
  const originalWarning = nativeWindow.showWarningMessage;
  const originalCreateTerminal = nativeWindow.createTerminal;
  try {
    const invocation = readPiInvocationOptions(root);
    assert.equal(invocation.executablePath, process.execPath);
    const prefix = invocation.executableArgs;
    assert.ok(prefix);
    assert.ok(prefix.every((argument) => path.isAbsolute(argument)));
    assert.equal(prefix.length, 2);
    assert.match(prefix[0] ?? "", /pi-runtime-bootstrap\.cjs$/);
    assert.match(prefix[1] ?? "", /[/\\]dist[/\\]bundle[/\\]cli\.js$/);
    if (!vscode.workspace.isTrusted) {
      await assert.rejects(runtime.ensureStarted(root), /trusted/);
      await assert.rejects(runtime.executeBash("printf forbidden", false), /trusted/);
      assert.equal(runtime.currentState.connected, false);
      assert.equal(runtime.clientGeneration, 0);
      assert.deepEqual(await children(directory), []);
      evidence.restrictedMode = "Process launch and direct shell rejected before Pi startup";
      return;
    }
    await runtime.ensureStarted(root);
    assert.equal(runtime.currentState.connected, true);
    const first = await waitForChild(directory, (child) => !child.tty);
    assert.equal(first.path, "");
    assert.equal(first.execPath, process.execPath);
    assert.equal(first.electronRunAsNode, null, "Bootstrap removes Electron mode before Pi/tool startup");
    assert.notEqual(first.packageDir, process.env.PI_PACKAGE_DIR);
    assert.ok(first.argv.includes("--no-approve"));
    await verifyPackagedCommands(await client(runtime).getCommands(), path.join(extensionRoot, "resources"));
    const result = await runtime.executeBash("printf bundled-native-offline", false);
    assert.ok(result);
    assert.equal(result.output, "bundled-native-offline");
    assert.equal(result.exitCode, 0);
    // Pi need not persist an empty/direct-shell-only session. Seed a header without a model turn.
    const retainedSession = path.join(directory, "persistent-session.jsonl");
    await writeFile(
      retainedSession,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "native-bundled-persistent",
        cwd: await realpath(root.fsPath),
        timestamp: new Date().toISOString(),
      })}\n`,
    );
    await runtime.switchSession(retainedSession);
    const sessionId = runtime.currentState.sessionId;
    const sessionFile = runtime.currentState.sessionFile;
    assert.ok(sessionId && sessionFile);
    assert.ok((await realpath(sessionFile)).startsWith(`${await realpath(directory)}${path.sep}`));
    const helper = await runIsolatedPiHelper(
      invocation,
      path.join(extensionRoot, "resources", "pi-isolated-helper.ts"),
      {
        operation: "discover",
        agentDir: path.join(directory, "unused-helper-store"),
      },
    );
    assert.equal(helper.status, "providers");
    assert.ok(helper.providers?.length);
    assert.equal(helper.cleanupWarning, undefined);
    evidence.helperProviderCount = helper.providers.length;
    // Only confirmation UI is automated. The host, runtime, policy, terminal, and ownership code are real.
    nativeWindow.showWarningMessage = (async (_message: string, ...items: unknown[]) => {
      const choice = items.find((item) => typeof item === "string");
      assert.ok(["Restart Pi", "Hand Off to Terminal", "Return Ownership"].includes(String(choice)));
      return choice;
    }) as typeof vscode.window.showWarningMessage;
    const beforeRestart = client(runtime);
    assert.equal(await runtime.restartSessionProcess(), true);
    assert.equal(beforeRestart.isRunning, false);
    assertIdentity(runtime, sessionId, sessionFile);
    const beforeTerminal = client(runtime);
    const eventCount = (await children(directory)).length;
    nativeWindow.createTerminal = ((options: vscode.TerminalOptions) => {
      assert.equal(beforeTerminal.isRunning, false, "RPC writer must stop before terminal creation");
      assert.equal(runtime.currentState.connected, false);
      assert.equal(options.shellPath, process.execPath);
      assert.ok(Array.isArray(options.shellArgs));
      assert.equal(options.shellArgs[0], prefix[0]);
      assert.equal(options.shellArgs[1], prefix[1]);
      assert.equal(options.env?.PI_VSCODE_ANNOTATION_TOKEN, null);
      terminal = (originalCreateTerminal as (options: vscode.TerminalOptions) => vscode.Terminal)(options);
      return terminal;
    }) as typeof vscode.window.createTerminal;
    await runtime.openInTerminal();
    assert.ok(terminal, "Controlled handoff must create an actual native terminal");
    assert.ok(await terminal.processId, "Native terminal process must exist");
    const terminalChild = await waitForChild(directory, (child, index) => index >= eventCount && child.tty);
    assert.equal(terminalChild.path ?? "", "");
    assert.equal(terminalChild.electronRunAsNode, null);
    assert.equal(terminalChild.sessionId, sessionId);
    assert.equal(terminalChild.sessionFile, sessionFile);
    assert.ok(hasOperation(await realpath(root.fsPath)), "Terminal retains the workspace ownership lock");
    await assert.rejects(runtime.ensureStarted(root), /owned by the terminal/);
    assert.equal((await children(directory)).length, eventCount + 1, "Blocked sidebar cannot start a second writer");
    const closed = new Promise<void>((resolve) => {
      const subscription = vscode.window.onDidCloseTerminal((candidate) => {
        if (candidate !== terminal) return;
        subscription.dispose();
        resolve();
      });
    });
    terminal.dispose();
    await deadline(closed, 10_000, "Native terminal closure");
    await waitForExit(terminalChild.pid);
    terminal = undefined;
    assert.equal(await runtime.returnFromTerminal(), true);
    assertIdentity(runtime, sessionId, sessionFile);
    assert.equal(hasOperation(await realpath(root.fsPath)), false);
    evidence.terminal = "Actual TUI; old writer stopped before creation; same-session return after owned PID exit";
    evidence.restart = "Explicit confirmation; stopped old writer; persistent ID and path retained";
    evidence.policyOwnership = "Bridge, read-only gate and control command verified against packaged paths";
    evidence.defaultRuntime = "Offline startup and direct shell with empty PATH; no external fallback";
    const config = vscode.workspace.getConfiguration("pi", root);
    const external = path.join(directory, "explicit external pi");
    if (process.platform !== "win32") {
      const quoted = [process.execPath, ...prefix].map((argument) => `'${argument.replace(/'/g, `'\\''`)}'`).join(" ");
      await writeFile(external, `#!/bin/sh\nunset PI_PACKAGE_DIR\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`);
      await chmod(external, 0o700);
    }
    await config.update("executablePath", external, vscode.ConfigurationTarget.Workspace);
    assert.equal(readPiInvocationOptions(root).executablePath, external);
    assert.equal(readPiInvocationOptions(root).executableArgs, undefined);
    await assert.rejects(runtime.executeBash("printf forbidden", false), /launch policy changed|Restart Pi/);
    if (process.platform !== "win32") {
      const previous = client(runtime);
      assert.equal(await runtime.restartSessionProcess(), true);
      assert.equal(previous.isRunning, false);
      assertIdentity(runtime, sessionId, sessionFile);
      assert.equal(
        (await runtime.executeBash("printf external-native-offline", false))?.output,
        "external-native-offline",
      );
    }
    await config.update("executablePath", undefined, vscode.ConfigurationTarget.Workspace);
    assert.equal(readPiInvocationOptions(root).executablePath, process.execPath);
    assert.equal(await runtime.restartSessionProcess(), true);
    assertIdentity(runtime, sessionId, sessionFile);
    evidence.externalOverride =
      process.platform === "win32"
        ? "Selection and active-client policy only; actual external Windows launch not checked"
        : "Explicit external wrapper launch and direct shell after confirmed same-session restart; reset returns bundled";
    const events = await children(directory);
    evidence.sessionStartEvents = events.length;
    evidence.uniquePiProcesses = new Set(events.map((event) => event.pid)).size;
  } catch (error) {
    evidence.failure = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    nativeWindow.showWarningMessage = originalWarning;
    nativeWindow.createTerminal = originalCreateTerminal;
    terminal?.dispose();
    await clientOrUndefined(runtime)?.stop();
    runtime.dispose();
    await writeFile(path.join(directory, "evidence.json"), JSON.stringify(evidence, null, 2));
    console.log("PI_BUNDLED_NATIVE_EVIDENCE", JSON.stringify(evidence));
  }
}

function clientOrUndefined(runtime: PiRuntimeManager): PiRpcClient | undefined {
  return (runtime as unknown as { client?: PiRpcClient }).client;
}
function client(runtime: PiRuntimeManager): PiRpcClient {
  const value = clientOrUndefined(runtime);
  assert.ok(value?.isRunning);
  return value;
}
function assertIdentity(runtime: PiRuntimeManager, sessionId: string, sessionFile: string): void {
  assert.equal(runtime.currentState.connected, true);
  assert.equal(runtime.currentState.sessionId, sessionId);
  assert.equal(runtime.currentState.sessionFile, sessionFile);
}
async function children(directory: string): Promise<ChildEvidence[]> {
  try {
    return (await readFile(path.join(directory, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
async function waitForChild(
  directory: string,
  matches: (value: ChildEvidence, index: number) => boolean,
): Promise<ChildEvidence> {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    const value = (await children(directory)).find(matches);
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Expected Pi session_start evidence did not arrive");
}
async function waitForExit(pid: number): Promise<void> {
  const end = Date.now() + 10_000;
  while (Date.now() < end) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Owned Pi terminal process did not exit; ownership return is forbidden");
}
async function deadline<T>(promise: Promise<T>, milliseconds: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded deadline`)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
