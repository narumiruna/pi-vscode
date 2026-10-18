import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
// The shared mock intentionally exposes only APIs needed by most tests.
vscode.QuickPickItemKind = { Separator: -1, Default: 0 };
vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
afterAll(() => vscode.restore());

const groups = [
  [
    "Session management",
    ["resume", "rename", "compact", "branches", "export", "import", "share", "terminal", "returnTerminal"],
  ],
  ["Review and repair", ["checkpoints", "review", "findings", "diagnostics", "staged", "repair", "debug"]],
  ["Background work", ["background", "worktree"]],
  ["Pi configuration", ["model", "thinking", "commands", "reload", "restart", "compatibility", "login", "logout"]],
] as const;

const routes = [
  ["resume", "resumeSession"],
  ["rename", "nameSession"],
  ["compact", "compact"],
  ["branches", "browseSessionTree", 37],
  ["export", "exportSession"],
  ["import", "pi.importSession"],
  ["share", "pi.shareSession"],
  ["terminal", "openInTerminal"],
  ["returnTerminal", "returnFromTerminal"],
  ["checkpoints", "selectCheckpoint", process.cwd(), "session-actions"],
  ["review", "pi.reviewChanges"],
  ["findings", "pi.showReviewFindings"],
  ["diagnostics", "pi.fixWorkspaceDiagnostics"],
  ["staged", "pi.reviewStagedChanges"],
  ["repair", "pi.repairFailedTest"],
  ["debug", "pi.askDebugContext"],
  ["background", "runBackground", "keep this draft", false, 37],
  ["worktree", "runBackground", "keep this draft", true, 37],
  ["model", "pickModel"],
  ["thinking", "pickThinkingLevel"],
  ["commands", "pickPiCommand"],
  ["reload", "reloadResources"],
  ["restart", "restartSessionProcess"],
  ["compatibility", "pi.extensionUiCompatibility"],
  ["login", "pi.signInProvider"],
  ["logout", "pi.signOutProvider"],
] as const;

function fixture() {
  const listeners = new Set<() => void>();
  const eventListeners = new Set<(event: { type: string }) => void>();
  const runtimeCalls: unknown[][] = [];
  const posted: any[] = [];
  const record =
    (name: string) =>
    async (...args: unknown[]) => {
      runtimeCalls.push([name, ...args]);
      throw new Error(`Unexpected runtime execution: ${name}`);
    };
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: {
      connected: true,
      busy: false,
      sessionId: "session-actions",
      sessionFile: "/fixture/session-actions.jsonl",
      availableModels: [],
      availableThinkingLevels: [],
      commands: [],
    },
    onEvent: (listener: (event: { type: string }) => void) => {
      eventListeners.add(listener);
      return { dispose: () => eventListeners.delete(listener) };
    },
    onDidChangeState: (listener: () => void) => {
      listeners.add(listener);
      return { dispose: () => listeners.delete(listener) };
    },
    reloadResources: record("reloadResources"),
    restartSessionProcess: record("restartSessionProcess"),
    chooseSessionBranch: record("chooseSessionBranch"),
    switchSession: record("switchSession"),
    compact: record("compact"),
    setModel: record("setModel"),
    setThinkingLevel: record("setThinkingLevel"),
    openInTerminal: record("openInTerminal"),
  };
  const context: any = {
    extensionUri: MockUri.file("/fixture-extension"),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  provider.postState = () => {};
  provider.postMessage = (message: unknown) => posted.push(message);
  provider.postNotice = (...args: unknown[]) => posted.push({ type: "notice", args });
  vscode.window.showQuickPick = async () => undefined;
  vscode.window.showWarningMessage = async () => undefined;
  const commands: unknown[][] = [];
  vscode.commands.executeCommand = async (...args: unknown[]) => commands.push(args);
  return {
    provider,
    runtime,
    runtimeCalls,
    commands,
    posted,
    listeners,
    eventListeners,
    emitEvent: (type: string) => {
      for (const listener of eventListeners) listener({ type });
    },
    emit: () => {
      for (const listener of listeners) listener();
    },
    select: (action: string, beforeReturn?: () => void) => {
      vscode.window.showQuickPick = async (items: any[]) => {
        beforeReturn?.();
        return items.find((item) => item.action === action);
      };
    },
    dispose: () => {
      for (const disposable of context.subscriptions) disposable.dispose();
    },
  };
}

test("More accounts for all 26 actions in four native groups with searchable descriptions", async () => {
  const f = fixture();
  try {
    vscode.window.showQuickPick = async (items: any[], options: any) => {
      assert.equal(options.title, "Pi Session Actions");
      assert.equal(options.matchOnDescription, true);
      assert.equal(options.canPickMany, undefined);
      let index = 0;
      for (const [label, actions] of groups) {
        assert.deepEqual(items[index++], { label, kind: vscode.QuickPickItemKind.Separator });
        for (const action of actions) {
          const item = items[index++];
          assert.equal(item.action, action);
          assert.ok(item.label.length > 0);
          assert.ok(item.description.length > 0);
          assert.equal(item.alwaysShow, undefined, "actions can be filtered out");
        }
      }
      assert.equal(index, items.length);
      assert.equal(new Set(items.filter((item) => item.action).map((item) => item.action)).size, 26);
      for (const [query, action] of [
        ["JSONL file", "resume"],
        ["TUI", "terminal"],
        ["template", "commands"],
        ["credential", "logout"],
      ] as const) {
        const matches = items.filter((item) => `${item.label} ${item.description ?? ""}`.includes(query));
        assert.ok(
          matches.some((item) => item.action === action),
          `description search: ${query}`,
        );
      }
      return undefined;
    };
    await f.provider.showMoreActions("keep this draft", 37);
    assert.deepEqual(f.posted, []);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});

for (const [action, route, ...args] of routes) {
  test(`More ${action} keeps its original route and arguments`, async () => {
    const f = fixture();
    const calls: unknown[][] = [];
    try {
      for (const method of new Set(routes.map(([, name]) => name))) {
        if (method.startsWith("pi.")) continue;
        const target =
          method === "openInTerminal"
            ? f.runtime
            : method === "selectCheckpoint"
              ? f.provider.changeTracker
              : f.provider;
        target[method] = async (...values: unknown[]) => calls.push([method, ...values]);
      }
      vscode.commands.executeCommand = async (...values: unknown[]) => calls.push(values);
      f.select(action);
      await f.provider.showMoreActions("keep this draft", 37);
      assert.deepEqual(calls, [[route, ...args]]);
      assert.equal(
        f.posted.some((message) => message.type === "clearInput"),
        false,
      );
      assert.deepEqual(f.runtimeCalls, []);
      assert.equal(f.listeners.size, 1, "picker subscription released; provider subscription remains");
      assert.equal(f.eventListeners.size, 1, "picker lifecycle subscription released");
    } finally {
      f.dispose();
    }
  });
}

for (const selection of ["cancel", "separator", "separator-with-action", "unknown"]) {
  test(`More ${selection} cannot dispatch or clear the composer`, async () => {
    const f = fixture();
    try {
      f.provider.runBackground = async () => assert.fail("invalid selections must not launch an agent");
      vscode.window.showQuickPick = async (items: any[]) =>
        selection === "cancel"
          ? undefined
          : selection === "separator"
            ? items[0]
            : selection === "separator-with-action"
              ? { ...items[0], action: "worktree" }
              : { label: "Unknown", action: "unknown" };
      await f.provider.showMoreActions("keep this draft", 37);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.runtimeCalls, []);
      assert.deepEqual(f.posted, []);
      assert.equal(f.listeners.size, 1);
    } finally {
      f.dispose();
    }
  });
}

test("More releases its temporary origin listener if the native picker fails", async () => {
  const f = fixture();
  try {
    vscode.window.showQuickPick = async () => {
      throw new Error("picker failed");
    };
    await assert.rejects(f.provider.showMoreActions("draft", 37), /picker failed/);
    assert.equal(f.listeners.size, 1);
    assert.equal(f.eventListeners.size, 1);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});

for (const change of ["sessionId", "sessionFile", "cwd", "connection", "replacement-round-trip"]) {
  test(`More rejects a stale ${change} origin after the picker returns`, async () => {
    const f = fixture();
    try {
      f.select("terminal", () => {
        if (change === "cwd") f.runtime.currentCwd = "/other-workspace";
        else if (change === "connection" || change === "replacement-round-trip") {
          f.runtime.currentState.connected = false;
          f.emit();
          if (change === "replacement-round-trip") {
            f.runtime.currentState.connected = true;
            f.emit();
          }
        } else f.runtime.currentState[change] = "other-session";
      });
      await assert.rejects(f.provider.showMoreActions("keep this draft", 37), /session changed/);
      assert.deepEqual(f.runtimeCalls, []);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.posted, []);
      assert.equal(f.listeners.size, 1);
    } finally {
      f.dispose();
    }
  });
}

for (const action of ["checkpoints", "resume", "compact", "reload", "restart", "branches"]) {
  test(`More ${action} preserves its host busy guard after async selection`, async () => {
    const f = fixture();
    try {
      f.provider.changeTracker.selectCheckpoint = async () => assert.fail("checkpoint restore must be blocked");
      f.select(action, () => {
        f.runtime.currentState.busy = true;
      });
      await f.provider.showMoreActions("keep this draft", 37).catch((error: Error) => {
        assert.match(error.message, /Wait for Pi/);
      });
      assert.deepEqual(f.runtimeCalls, []);
      assert.deepEqual(f.commands, []);
      assert.equal(
        f.posted.some((message) => message.type === "clearInput"),
        false,
      );
    } finally {
      f.dispose();
    }
  });
}

for (const event of ["extension_ui_reset", "process_exit"]) {
  test(`More rejects a replaced client or same-session control after ${event}`, async () => {
    const f = fixture();
    try {
      f.select("terminal", () => f.emitEvent(event));
      await assert.rejects(f.provider.showMoreActions("keep this draft", 37), /session changed/);
      assert.deepEqual(f.runtimeCalls, []);
      assert.deepEqual(f.commands, []);
      assert.equal(
        f.posted.some((message) => message.type === "clearInput"),
        false,
      );
      assert.equal(f.eventListeners.size, 1, "picker lifecycle subscription released");
    } finally {
      f.dispose();
    }
  });
}

test("More retains terminal ownership recovery when the foreground owner is held", async () => {
  const f = fixture();
  try {
    let returns = 0;
    f.runtime.currentState.busy = true;
    f.provider.returnFromTerminal = async () => {
      returns++;
    };
    f.select("returnTerminal");
    await f.provider.showMoreActions("keep this draft", 37);
    assert.equal(returns, 1, "a generic busy check must not remove the recovery route");
    assert.deepEqual(f.posted, []);
  } finally {
    f.dispose();
  }
});

test("cancelled background confirmation keeps attachments and composer without starting tools", async () => {
  const f = fixture();
  try {
    f.provider.attachments.attachments.push({ id: "context", label: "context", content: "keep" });
    f.provider.backgroundAgents.start = async () => assert.fail("cancelled approval must not start tools");
    f.select("background");
    await f.provider.showMoreActions("keep this draft", 37);
    assert.equal(f.provider.attachments.summaries.length, 1);
    assert.deepEqual(f.posted, []);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});

for (const action of ["background", "worktree"]) {
  test(`accepted ${action} clears only the captured composer revision`, async () => {
    const f = fixture();
    const starts: unknown[][] = [];
    try {
      vscode.window.showWarningMessage = async (_message: unknown, _options: unknown, confirmation: string) =>
        confirmation;
      f.provider.backgroundAgents.start = async (...args: unknown[]) => starts.push(args);
      f.select(action);
      await f.provider.showMoreActions("keep this draft", 37);
      assert.equal(starts.length, 1);
      assert.equal(starts[0]?.[0], "keep this draft");
      assert.equal(starts[0]?.[4], action === "worktree");
      assert.deepEqual(
        f.posted.filter((message) => message.type === "clearInput"),
        [{ type: "clearInput", expectedText: "keep this draft", expectedRevision: 37 }],
      );
      assert.deepEqual(f.runtimeCalls, []);
    } finally {
      f.dispose();
    }
  });
}

test("More branch navigation preserves cancellation and captured draft revision", async () => {
  const f = fixture();
  try {
    f.select("branches");
    f.runtime.chooseSessionBranch = async () => ({ cancelled: true });
    await f.provider.showMoreActions("keep this draft", 37);
    assert.deepEqual(f.posted, []);
    f.provider.finishSessionTransition = async () => {};
    f.runtime.chooseSessionBranch = async () => ({ cancelled: false, text: "branch draft" });
    await f.provider.showMoreActions("keep this draft", 37);
    assert.deepEqual(f.posted, [{ type: "restoreBranchDraft", text: "branch draft", expectedRevision: 37 }]);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});

test("completed unrelated resource reload does not clear the composer", async () => {
  const f = fixture();
  try {
    f.select("reload");
    f.runtime.reloadResources = async () => true;
    await f.provider.showMoreActions("keep this draft", 37);
    assert.deepEqual(f.posted, []);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});
