import assert from "node:assert/strict";
import type { LogEvent, LogLevel, LogMetadata } from "../logging";
import { installVscodeMock, MockUri } from "./vscodeMock";

const sentinel = "PRIVATE_DIAGNOSTIC_SENTINEL";
const privateError = (code?: string) =>
  Object.assign(new Error(`${sentinel}: /private/session.jsonl`, { cause: new Error(sentinel) }), {
    code,
    stack: `${sentinel} stack`,
  });

function fixture() {
  const vscode = installVscodeMock();
  vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
  delete require.cache[require.resolve("../sidebar")];
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  const records: Array<{ level: LogLevel; event: LogEvent; metadata?: LogMetadata }> = [];
  const posted: Record<string, unknown>[] = [];
  const shows: boolean[] = [];
  const modals: unknown[] = [];
  let nextId = 0;
  const logger = {
    operation: (): `op-${number}` => `op-${++nextId}`,
    record: (level: LogLevel, event: LogEvent, metadata?: LogMetadata) => records.push({ level, event, metadata }),
    warning() {},
    endGeneration() {},
    show: () => shows.push(true),
  };
  vscode.window.showErrorMessage = (...args: unknown[]) => {
    modals.push(args);
    return Promise.resolve(undefined);
  };
  const subscription = () => ({ dispose() {} });
  const runtime: any = {
    currentState: { connected: true },
    clientGeneration: 7,
    currentCwd: process.cwd(),
    onEvent: subscription,
    onDidChangeState: subscription,
    ensureStarted: async () => {},
    getMessages: async () => [],
    compact: async () => {},
  };
  const context: any = {
    workspaceState: { get: () => undefined, update: async () => {} },
    extensionUri: MockUri.file("/extension"),
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime, logger) as any;
  provider.view = {
    webview: {
      postMessage: async (message: Record<string, unknown>) => {
        posted.push(message);
        return true;
      },
    },
  };
  return {
    vscode,
    runtime,
    context,
    provider,
    records,
    posted,
    shows,
    modals,
    dispose() {
      for (const disposable of context.subscriptions) disposable.dispose();
      vscode.restore();
    },
  };
}

test("runtime notices never retain raw details or duplicate logs and Show Output is explicit", async () => {
  const f = fixture();
  try {
    for (const warningCode of ["cleanup-unverified", "queue-uncertain", "state-refresh", sentinel]) {
      f.provider.handleRuntimeEvent({ type: "runtime_warning", warningCode, message: sentinel });
    }
    f.provider.handleRuntimeEvent({ type: "protocol_error", message: sentinel });
    const notices = f.posted.filter((message) => message.type === "notice");
    assert.equal(notices.length, 5);
    assert.ok(notices.every((notice) => notice.outputAvailable === true));
    assert.doesNotMatch(JSON.stringify(notices), new RegExp(sentinel));
    assert.match(String(notices[0]!.message), /remaining processes/);
    assert.match(String(notices[1]!.message), /nothing is replayed automatically/);
    assert.match(String(notices[2]!.message), /do not repeat the command/);
    assert.equal("noticeDetails" in f.provider, false);
    assert.deepEqual(f.records, [], "runtime owns warnings and protocol diagnostics");
    assert.deepEqual(f.shows, []);
    assert.deepEqual(f.modals, []);
    await f.provider.handleMessage({ type: "showOutput" });
    assert.deepEqual(f.shows, [true]);
    assert.deepEqual(f.modals, []);
  } finally {
    f.dispose();
  }
});

test("history load, refresh, compaction and cache failures project only safe metadata", async () => {
  const f = fixture();
  try {
    f.runtime.getMessages = async () => {
      throw privateError("EACCES");
    };
    await f.provider.initializeRuntime();
    assert.equal(f.records.at(-1)?.event, "history-load");
    assert.equal(f.records.at(-1)?.metadata?.errorCode, "EACCES");
    assert.equal(f.records.at(-1)?.metadata?.generation, 7);
    assert.equal(f.records.at(-1)?.metadata?.category, "permission");
    assert.equal(f.provider.historyRecoveryAvailable, true);
    await assert.rejects(f.provider.refreshHistory());
    assert.equal(f.records.at(-1)?.event, "history-refresh");
    assert.equal(f.records.at(-1)?.metadata?.operationCompleted, false);
    await f.provider.compact();
    assert.equal(f.records.at(-1)?.event, "history-compaction");
    assert.equal(f.records.at(-1)?.metadata?.operationCompleted, true);
    assert.match(f.provider.status, /Context compacted.*History refresh failed/);
    assert.ok(f.posted.some((notice) => /Do not repeat compaction/.test(String(notice.message))));
    f.context.workspaceState.update = async () => {
      throw privateError("EIO");
    };
    await f.provider.persistMessages();
    assert.equal(f.records.at(-1)?.event, "cache-save");
    assert.equal(f.records.at(-1)?.metadata?.errorCode, "EIO");
    f.runtime.getMessages = async () => {
      throw privateError(sentinel);
    };
    await assert.rejects(f.provider.syncMessagesFromPi(false, undefined, "history-refresh", true));
    assert.equal(f.records.at(-1)?.metadata?.category, "unknown");
    assert.equal(f.records.at(-1)?.metadata?.errorCode, undefined);
    assert.equal(f.records.at(-1)?.metadata?.operationCompleted, true);
    assert.doesNotMatch(JSON.stringify(f.records), new RegExp(sentinel));
    assert.doesNotMatch(JSON.stringify(f.posted.filter((message) => message.type === "notice")), new RegExp(sentinel));
    assert.deepEqual(f.shows, []);
    assert.deepEqual(f.modals, []);
  } finally {
    f.dispose();
  }
});

test("stale history success and failure are discarded with Debug metadata only", async () => {
  const f = fixture();
  try {
    for (const reject of [false, true]) {
      let settle!: () => void;
      f.runtime.getMessages = () =>
        new Promise((resolve, rejectPromise) => {
          settle = () => (reject ? rejectPromise(privateError()) : resolve([{ role: "user", content: sentinel }]));
        });
      f.runtime.clientGeneration = 7;
      const sync = f.provider.syncMessagesFromPi();
      f.runtime.clientGeneration = 8;
      settle();
      await sync;
      assert.equal(f.records.at(-1)?.event, "history-stale");
      assert.equal(f.records.at(-1)?.level, "debug");
      assert.equal(f.records.at(-1)?.metadata?.result, "discarded");
      assert.equal(f.records.at(-1)?.metadata?.generation, 7, "Discard is assigned to the originating generation");
      assert.match(f.records.at(-1)?.metadata?.operationId ?? "", /^op-\d+$/);
      assert.deepEqual(f.provider.messages, []);
    }
    assert.doesNotMatch(JSON.stringify(f.records), new RegExp(sentinel));
  } finally {
    f.dispose();
  }
});

test("failed Sidebar UI actions log a fixed event without error text or a diagnostic modal", async () => {
  const f = fixture();
  try {
    f.runtime.clearInstructions = async () => {
      throw privateError("EPERM");
    };
    await f.provider.handleMessage({ type: "clearQueue" });
    assert.equal(f.records.length, 1);
    assert.equal(f.records[0]?.event, "sidebar-action");
    assert.equal(f.records[0]?.metadata?.category, "permission");
    assert.doesNotMatch(JSON.stringify(f.records), new RegExp(sentinel));
    const notice = f.posted.find((message) => message.type === "notice");
    assert.equal(notice?.outputAvailable, true);
    assert.doesNotMatch(JSON.stringify(notice), new RegExp(sentinel));
    assert.deepEqual(f.shows, []);
    assert.deepEqual(f.modals, []);
  } finally {
    f.dispose();
  }
});

test.each(["composer", "editor", "retry"])(
  "%s requests pass their retry contract to runtime diagnostics",
  async (origin) => {
    const f = fixture();
    try {
      let args: unknown[] = [];
      f.runtime.prompt = async (...values: unknown[]) => {
        args = values;
        return "answer";
      };
      const result = await f.provider.runRequest("plain request", [], [], undefined, undefined, undefined, origin);
      assert.equal(result, "answer");
      assert.equal(args[6], origin !== "editor");
      assert.deepEqual(f.shows, []);
    } finally {
      f.dispose();
    }
  },
);

for (const accepted of [false, true]) {
  test(`permanent deletion confirmation ${accepted ? "accepted" : "cancelled"} preserves the runtime operation ID`, async () => {
    const f = fixture();
    const { SessionTrashUnavailableError } = require("../piRuntime") as typeof import("../piRuntime");
    try {
      const confirmations: unknown[][] = [];
      f.vscode.window.showWarningMessage = async (...args: unknown[]) => {
        confirmations.push(args);
        return confirmations.length === 1 ? "Delete Session" : accepted ? "Delete Permanently" : undefined;
      };
      const originalFile = "/sessions/original.jsonl";
      f.runtime.currentState = { connected: true, sessionFile: originalFile, sessionId: "original" };
      f.runtime.deleteSession = async () => {
        throw new SessionTrashUnavailableError(originalFile, { cause: privateError() }, "op-17");
      };
      const permanentCalls: unknown[][] = [];
      f.runtime.deleteSessionPermanently = async (...args: unknown[]) => permanentCalls.push(args);
      f.provider.refreshRecentSessions = async () => {};
      await f.provider.deleteSession();
      assert.equal(confirmations.length, 2, "destructive modals remain separate");
      assert.ok(confirmations.every((args) => (args[1] as { modal: boolean }).modal));
      assert.deepEqual(permanentCalls, accepted ? [[originalFile, "op-17"]] : []);
      assert.deepEqual(
        f.records.map(({ event, metadata }) => ({ event, metadata })),
        [
          {
            event: "permanent-confirmation",
            metadata: { operationId: "op-17", result: accepted ? "accepted" : "cancelled" },
          },
        ],
      );
      if (!accepted) assert.match(f.provider.status, /Session kept.*Trash unavailable/);
      assert.doesNotMatch(JSON.stringify(f.records), new RegExp(sentinel));
      assert.deepEqual(f.shows, []);
      assert.deepEqual(f.modals, []);
    } finally {
      f.dispose();
    }
  });
}
