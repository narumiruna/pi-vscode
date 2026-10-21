import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { type LogMetadata, PiLogger } from "../logging";
import type { PiRpcEvent } from "../piRpcClient";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager, SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
afterAll(() => mock.restore());

const secret = "PRIVATE_SENTINEL_prompt_shell_queue_path_title_stderr_stack_auth_mcp_annotation";
const failure = (code = "EACCES") => Object.assign(new Error(secret, { cause: secret }), { code });

class FixtureClient {
  public isRunning = true;
  public readonly listeners = new Set<(event: PiRpcEvent) => void>();
  public cleanupWarning = false;
  public stopFailure = false;
  public prompt = async (_message: string): Promise<string | undefined> => {
    this.emit({ type: "message_end", message: { role: "assistant", content: secret } });
    this.emit({ type: "agent_settled" });
    return undefined;
  };
  public onEvent(listener: (event: PiRpcEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }
  public emit(event: PiRpcEvent) {
    for (const listener of this.listeners) listener(event);
  }
  public async stop() {
    if (this.cleanupWarning) this.emit({ type: "runtime_warning", warningCode: "cleanup-unverified", message: secret });
    this.emit({ type: "process_exit", expected: true, code: 0, signal: null, stderr: secret });
    this.isRunning = false;
    if (this.stopFailure) throw failure("EIO");
  }
}

async function fixture(action: (f: any) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "pi-runtime-log-"));
  const session = path.join(root, `${secret}.jsonl`);
  writeFileSync(session, `${JSON.stringify({ type: "session", cwd: root })}\n`);
  const folder = { uri: MockUri.file(root) };
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.isTrusted = true;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  mock.workspace.fs = { delete: async () => {} };
  const records: { event: string; level: string; metadata: LogMetadata }[] = [];
  const lines: string[] = [];
  const channel: Record<string, unknown> = { show: () => assert.fail("Logging must not open Output"), dispose() {} };
  for (const level of ["info", "warn", "error", "debug", "trace"]) {
    channel[level] = (line: string) => {
      lines.push(line);
      const split = line.indexOf(" ");
      records.push({ event: line.slice(0, split), level, metadata: JSON.parse(line.slice(split + 1)) });
    };
  }
  const logger = new PiLogger(channel as unknown as vscode.LogOutputChannel);
  const runtime = new PiRuntimeManager(
    {
      extensionUri: MockUri.file(process.cwd()),
      workspaceState: { get: () => undefined, update: async () => {} },
      environmentVariableCollection: { clear() {} },
    } as unknown as vscode.ExtensionContext,
    logger,
  );
  const internal = runtime as any;
  const client = new FixtureClient();
  internal.client = client;
  internal.clientGenerations.set(client, 7);
  internal.nextClientGeneration = 7;
  internal.clientSubscription = client.onEvent((event) => internal.handleEvent(event));
  internal.state = {
    ...runtime.currentState,
    connected: true,
    sessionFile: session,
    sessionId: secret,
    sessionName: secret,
  };
  internal.ensureStarted = async () => {};
  internal.refreshState = async () => {};
  try {
    await action({ runtime, internal, client, records, lines, root, session, logger });
    assert.ok(
      lines.every((line) => !line.includes(secret)),
      "No user data enters any log level",
    );
  } finally {
    internal.clientSubscription?.dispose();
    internal.client = undefined;
    runtime.dispose();
    logger.dispose();
    rmSync(root, { recursive: true, force: true });
  }
}

test("runtime warnings are logged without a Sidebar and suppression never removes UI warnings", async () => {
  await fixture(async ({ runtime, internal, client, records }: any) => {
    client.emit({ type: "runtime_warning", warningCode: "unknown", message: secret, cause: secret, stack: secret });
    const forwarded: PiRpcEvent[] = [];
    runtime.onEvent((event: PiRpcEvent) => forwarded.push(event));
    client.emit({ type: "runtime_warning", warningCode: secret, message: secret });
    client.emit({ type: "runtime_warning", warningCode: secret, message: secret });
    assert.equal(records.filter((r: any) => r.event === "runtime-warning").length, 1);
    assert.equal(forwarded.length, 2);
    client.emit({ type: "process_exit", expected: false, code: 17, signal: "SIGTERM", stderr: secret });
    assert.ok(records.some((r: any) => r.event === "process-exit" && r.metadata.exitCode === 17));
    assert.ok(records.some((r: any) => r.event === "warnings-suppressed" && r.metadata.count === 2));
    assert.equal(internal.client, undefined);
  });
});

test("protocol errors log only an invalid-frame category, never malformed input or errors", async () => {
  await fixture(async ({ client, records }: any) => {
    client.emit({ type: "protocol_error", message: secret, line: secret, error: failure(), stderr: secret });
    const record = records.find((r: any) => r.event === "runtime-warning");
    assert.equal(record.metadata.warningCode, "protocol-error");
    assert.equal(record.metadata.category, "invalid-frame");
  });
});

for (const stopFailure of [false, true]) {
  test(`detached cleanup logging preserves late-client isolation (stop failure: ${stopFailure})`, async () => {
    await fixture(async ({ runtime, internal, client, records }: any) => {
      client.cleanupWarning = true;
      client.stopFailure = stopFailure;
      const events: PiRpcEvent[] = [];
      runtime.onEvent((event: PiRpcEvent) => events.push(event));
      const stop = internal.stopClient();
      if (stopFailure) await assert.rejects(stop, /PRIVATE_SENTINEL/);
      else await stop;
      assert.equal(client.listeners.size, 0);
      const count = records.length;
      const replacement = new FixtureClient();
      internal.client = replacement;
      internal.clientGenerations.set(replacement, 8);
      internal.state = { ...runtime.currentState, connected: true, sessionId: "replacement" };
      client.emit({ type: "process_exit", code: 91, signal: secret });
      client.emit({ type: "runtime_warning", warningCode: "cleanup-unverified", message: secret });
      assert.equal(records.length, count);
      assert.equal(runtime.currentState.connected, true);
      assert.equal(events.filter((e) => e.type === "process_exit").length, 0);
      assert.equal(events.filter((e) => e.type === "runtime_warning").length, 1);
      assert.ok(
        records.some(
          (r: any) => r.event === "cleanup" && r.metadata.result === "unverified" && r.metadata.generation === 7,
        ),
      );
    });
  });
}

for (const outcome of ["completed", "failed", "cancelled", "uncertain", "empty", "exit", "queue"] as const) {
  test(`prompt has exactly one start/end boundary for ${outcome}, without private input`, async () => {
    await fixture(async ({ runtime, internal, client, records }: any) => {
      if (outcome !== "completed")
        client.prompt = async () => {
          if (outcome === "cancelled") internal.requestLog.cancelled = true;
          if (outcome === "uncertain") client.emit({ type: "tool_execution_start", toolName: secret, args: secret });
          if (outcome === "exit") client.emit({ type: "process_exit", code: 19, expected: false, stderr: secret });
          if (outcome === "queue") client.emit({ type: "queue_update", steering: [secret], followUp: [] });
          if (outcome === "empty") {
            client.emit({ type: "agent_settled" });
            return undefined;
          }
          throw failure();
        };
      const request = runtime.prompt(
        secret,
        undefined,
        [{ data: secret, mimeType: "image/png" }],
        undefined,
        undefined,
        true,
        true,
      );
      if (outcome === "completed") assert.equal(await request, secret);
      else if (outcome === "empty") assert.equal(await request, undefined);
      else await assert.rejects(request, /PRIVATE_SENTINEL/);
      const boundaries = records.filter((r: any) => r.event === "request");
      assert.equal(boundaries.length, 2);
      assert.equal(boundaries[0].metadata.result, "started");
      assert.equal(
        boundaries[1].metadata.result,
        outcome === "empty" ? "failed" : outcome === "exit" || outcome === "queue" ? "uncertain" : outcome,
      );
      assert.equal(boundaries[1].metadata.retryAvailable, ["failed", "cancelled", "empty"].includes(outcome));
      assert.equal(typeof boundaries[1].metadata.durationMs, "number");
      assert.equal(boundaries[0].metadata.operationId, boundaries[1].metadata.operationId);
    });
  });
}

test("pre-submission failure never reports an available retry from incomplete evidence", async () => {
  await fixture(async ({ runtime, records }: any) => {
    await assert.rejects(
      runtime.prompt(
        secret,
        undefined,
        undefined,
        undefined,
        () => {
          throw failure();
        },
        true,
        true,
      ),
      /PRIVATE_SENTINEL/,
    );
    const end = records.find((r: any) => r.event === "request" && r.metadata.result !== "started");
    assert.equal(end.metadata.result, "failed");
    assert.equal(end.metadata.retryAvailable, false);
  });
});

test("a disposed logger does not change request results or start a replacement client", async () => {
  await fixture(async ({ runtime, internal, client, logger }: any) => {
    logger.dispose();
    assert.equal(await runtime.prompt(secret), secret);
    assert.equal(internal.client, client);
    assert.equal(client.isRunning, true);
  });
});

test("a rejected concurrent prompt cannot change the active prompt's log ownership", async () => {
  await fixture(async ({ runtime, internal, client, records }: any) => {
    let accepted!: () => void;
    const started = new Promise<void>((resolve) => {
      accepted = resolve;
    });
    let settle!: () => void;
    client.prompt = async () => {
      accepted();
      await new Promise<void>((resolve) => {
        settle = resolve;
      });
      client.emit({ type: "tool_execution_start", toolName: secret });
      throw failure();
    };
    const first = runtime.prompt(secret, undefined, undefined, undefined, undefined, true, true);
    await started;
    const operationId = internal.requestLog.operationId;
    await assert.rejects(runtime.prompt(secret), /current Pi request/);
    assert.equal(internal.requestLog.operationId, operationId);
    settle();
    await assert.rejects(first, /PRIVATE_SENTINEL/);
    const final = records.find(
      (r: any) => r.event === "request" && r.metadata.operationId === operationId && r.metadata.result !== "started",
    );
    assert.equal(final.metadata.retryAvailable, false);
    assert.equal(final.metadata.result, "uncertain");
  });
});

for (const outcome of ["completed", "cancelled", "uncertain"] as const) {
  test(`direct shell has one start/end boundary for ${outcome} and never logs command/output`, async () => {
    await fixture(async ({ runtime, internal, client, records, session }: any) => {
      internal.withForegroundOperation = async (_label: unknown, action: any) => action(client, async () => {});
      client.getCommands = async () => [
        {
          name: "vscode-pi-read-only-ready",
          source: "extension",
          description: "VS Code read-only direct-shell policy v1; Pi 1.3.0",
          sourceInfo: { path: path.join(process.cwd(), "resources", "pi-read-only-gate.ts") },
        },
      ];
      client.getState = async () => ({ sessionId: secret, sessionFile: session });
      client.getMessages = async () => [{ text: secret }];
      client.bash = async () => {
        if (outcome === "uncertain") throw failure();
        return { output: secret, cancelled: outcome === "cancelled", truncated: false, exitCode: 0 };
      };
      const execution = runtime.executeBash(`printf ${secret}`, false);
      if (outcome === "uncertain") await assert.rejects(execution, /did not complete reliably/);
      else await execution;
      const boundaries = records.filter((r: any) => r.event === "request");
      assert.equal(boundaries.length, 2);
      assert.equal(boundaries[0].metadata.command, "bash");
      assert.equal(boundaries[0].metadata.result, "started");
      assert.equal(boundaries[1].metadata.result, outcome);
      assert.equal(boundaries[1].metadata.retryAvailable, false);
      assert.equal(typeof boundaries[1].metadata.durationMs, "number");
    });
  });
}

test("unsupported Trash and permanent deletion retain one operation ID across recovery", async () => {
  await fixture(async ({ runtime, internal, records, session }: any) => {
    const calls: boolean[] = [];
    mock.workspace.fs = {
      delete: async (_uri: unknown, options: { useTrash: boolean }) => {
        calls.push(options.useTrash);
        if (options.useTrash) throw new Error(`Trash unsupported ${secret}`);
      },
    };
    internal.ensureStarted = async () => {
      internal.state = { ...internal.state, connected: true, sessionFile: "replacement" };
    };
    // The first ensureStarted must retain the original deletion target.
    let starts = 0;
    const recover = internal.ensureStarted;
    internal.ensureStarted = async () => {
      if (++starts > 1) await recover();
    };
    let unavailable: InstanceType<typeof SessionTrashUnavailableError> | undefined;
    try {
      await runtime.deleteSession();
    } catch (error) {
      assert.ok(error instanceof SessionTrashUnavailableError);
      unavailable = error;
    }
    assert.ok(unavailable);
    const operationId = unavailable.operationId;
    await runtime.deleteSessionPermanently(unavailable.sessionFile, operationId);
    assert.deepEqual(calls, [true, false]);
    const deletion = records.filter((r: any) => ["deletion", "trash", "recovery-startup"].includes(r.event));
    assert.ok(deletion.every((r: any) => r.metadata.operationId === operationId));
    assert.ok(deletion.some((r: any) => r.metadata.result === "unsupported"));
    assert.ok(deletion.some((r: any) => r.metadata.result === "retained"));
    assert.ok(deletion.some((r: any) => r.metadata.result === "deleted"));
    assert.equal(unavailable.sessionFile, session);
    assert.equal(runtime.currentState.sessionFile, "replacement");
  });
});

for (const mode of ["permission", "permanent", "deleted-cleanup"] as const) {
  test(`deletion ${mode} records final outcomes and discarded recovery failures`, async () => {
    await fixture(async ({ runtime, internal, records, session }: any) => {
      mock.workspace.fs = {
        delete: async () => {
          if (mode !== "deleted-cleanup") throw failure();
        },
      };
      internal.context.workspaceState.update = async () => {
        throw failure("EIO");
      };
      let starts = 0;
      internal.ensureStarted = async () => {
        if (++starts > (mode === "permanent" ? 0 : 1)) throw failure("ENOSPC");
      };
      const deletion = mode === "permanent" ? runtime.deleteSessionPermanently(session) : runtime.deleteSession();
      if (mode === "deleted-cleanup") await deletion;
      else await assert.rejects(deletion, /PRIVATE_SENTINEL/);
      const final = records.filter(
        (r: any) => r.event === "deletion" && ["deleted", "retained"].includes(r.metadata.result),
      );
      assert.equal(final.length, 1);
      assert.equal(final[0].metadata.result, mode === "deleted-cleanup" ? "deleted" : "retained");
      assert.ok(
        records.some(
          (r: any) =>
            r.event === "recovery-startup" && r.metadata.result === "failed" && r.metadata.errorCode === "ENOSPC",
        ),
      );
      if (mode === "deleted-cleanup") {
        assert.ok(records.some((r: any) => r.event === "storage-cleanup" && r.metadata.errorCode === "EIO"));
        assert.ok(
          records.some((r: any) => r.event === "runtime-warning" && r.metadata.warningCode === "deleted-cleanup"),
        );
      } else assert.ok(records.some((r: any) => r.event === "deletion" && r.metadata.category === "permission"));
    });
  });
}

test("startup failure and saved-session fallback log safe metadata and keep recovery behavior", async () => {
  await fixture(async ({ internal, records, session }: any) => {
    internal.context.workspaceState.get = () => session;
    const attempts: unknown[] = [];
    internal.createAndStartClient = async (target: unknown) => {
      attempts.push(target);
      if (target) throw failure("ENOENT");
    };
    await internal.startClient();
    assert.deepEqual(attempts, [session, undefined]);
    assert.deepEqual(
      records.filter((r: any) => r.event === "restore-fallback").map((r: any) => r.metadata.result),
      ["started", "ready"],
    );
  });
});

test("startup preflight failures retain only a safe category/code, not session paths or errors", async () => {
  await fixture(async ({ internal, records, root }: any) => {
    await assert.rejects(internal.createAndStartClient(path.join(root, `${secret}-missing.jsonl`)), { code: "ENOENT" });
    const boundaries = records.filter((r: any) => r.event === "startup");
    assert.equal(boundaries.length, 2);
    assert.equal(boundaries[1].metadata.result, "failed");
    assert.equal(boundaries[1].metadata.errorCode, "ENOENT");
    assert.equal(boundaries[1].metadata.category, "io");
  });
});

for (const result of [true, false, "failed"] as const) {
  test(`restart records its ${result} outcome without changing the result`, async () => {
    await fixture(async ({ runtime, internal, records }: any) => {
      internal.control.restartSessionProcess = async () => {
        if (result === "failed") throw failure();
        return result;
      };
      if (result === "failed") await assert.rejects(runtime.restartSessionProcess(), /PRIVATE_SENTINEL/);
      else assert.equal(await runtime.restartSessionProcess(), result);
      const boundaries = records.filter((r: any) => r.event === "restart");
      assert.equal(boundaries.length, 2);
      assert.equal(boundaries[1].metadata.result, result === "failed" ? "failed" : result ? "completed" : "cancelled");
    });
  });
}

for (const replacement of [false, true]) {
  test(`late settlement refresh failure stays with its originating client/revision (replacement: ${replacement})`, async () => {
    await fixture(async ({ runtime, internal, client, records }: any) => {
      let rejectState!: (error: unknown) => void;
      client.getState = () =>
        new Promise((_resolve, reject) => {
          rejectState = reject;
        });
      client.getSessionStats = async () => ({});
      internal.refreshState = Object.getPrototypeOf(runtime).refreshState;
      internal.requestLog = { operationId: "op-41" };
      const warnings: PiRpcEvent[] = [];
      runtime.onEvent((event: PiRpcEvent) => {
        if (event.type === "runtime_warning") warnings.push(event);
      });
      client.emit({ type: "agent_settled" });
      if (replacement) {
        internal.client = new FixtureClient();
        internal.clientGenerations.set(internal.client, 8);
        internal.nextClientGeneration = 8;
      } else internal.refreshRevision++;
      internal.requestLog = { operationId: "op-42" };
      const state = runtime.currentState;
      rejectState(failure());
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(warnings, []);
      assert.deepEqual(runtime.currentState, state);
      assert.equal(records.filter((r: any) => r.event === "runtime-warning").length, 0);
      const stale = records.find((r: any) => r.event === "history-stale");
      assert.equal(stale.level, "debug");
      assert.equal(stale.metadata.generation, 7);
      assert.equal(stale.metadata.operationId, "op-41");
      internal.emitWarning({ type: "runtime_warning", warningCode: "state-refresh", message: secret });
      assert.equal(
        records.filter((r: any) => r.event === "runtime-warning").length,
        1,
        "Stale failure must not consume warning suppression",
      );
    });
  });
}

test("created RPC clients receive the same logger and generation without reusing a startup ID", async () => {
  await fixture(async ({ runtime, internal, records, logger }: any) => {
    await internal.stopClient();
    internal.bridgeEnvironment = async () => ({});
    const start = vi.spyOn(PiRpcClient.prototype, "start").mockResolvedValue(undefined);
    try {
      await internal.createAndStartClient(undefined);
      const diagnosticContext = internal.client.diagnosticContext;
      const startup = records.find((r: any) => r.event === "startup" && r.metadata.result === "started");
      assert.equal(diagnosticContext.logger, logger);
      assert.equal(diagnosticContext.generation, startup.metadata.generation);
      assert.equal(diagnosticContext.operationId, undefined);
      internal.requestLog = { operationId: "op-99" };
      assert.equal(diagnosticContext.operationId, "op-99", "RPC commands share their active request boundary ID");
      await assert.rejects(internal.client.getMessages(), /not running/);
      const commandRecords = records.filter((r: any) => r.event === "rpc-command");
      assert.equal(commandRecords.length, 2);
      assert.ok(commandRecords.every((r: any) => r.metadata.operationId === "op-99"));
      internal.requestLog = undefined;
      assert.equal(diagnosticContext.operationId, undefined, "Idle commands generate independent operation IDs");
      assert.ok(records.some((r: any) => r.event === "startup" && r.metadata.result === "ready"));
      assert.equal(runtime.currentState.connected, false, "The fixture refresh does not mutate runtime state");
    } finally {
      start.mockRestore();
    }
  });
});
