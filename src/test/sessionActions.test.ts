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
  ["Conversation display", ["details", "wordWrap"]],
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

test("More accounts for all 28 actions in five native groups with searchable descriptions", async () => {
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
      assert.equal(new Set(items.filter((item) => item.action).map((item) => item.action)).size, 28);
      for (const [query, action] of [
        ["JSONL file", "resume"],
        ["TUI", "terminal"],
        ["template", "commands"],
        ["credential", "logout"],
        ["long code lines", "wordWrap"],
        ["text draft recovery", "details"],
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

for (const codeWrapping of [undefined, false, true]) {
  test(`More Word wrap state ${codeWrapping} sends only a display toggle`, async () => {
    const f = fixture();
    const getConfiguration = vscode.workspace.getConfiguration;
    try {
      vscode.workspace.getConfiguration = () => assert.fail("Word wrap must not access configuration");
      f.provider.attachments.attachments.push({ id: "context", label: "context", content: "keep" });
      f.provider.send = async () => assert.fail("Word wrap must not submit the composer");
      f.provider.runBackground = async () => assert.fail("Word wrap must not start an agent");
      f.select("wordWrap");
      const select = vscode.window.showQuickPick;
      vscode.window.showQuickPick = async (...args: Parameters<typeof select>) => {
        const item = await select(...args);
        assert.equal(item.label, "Word wrap");
        assert.equal(item.description, `${codeWrapping ? "On" : "Off"} · Wrap long code lines for display only`);
        return item;
      };
      if (codeWrapping === undefined) await f.provider.showMoreActions("keep this draft", 37);
      else await f.provider.showMoreActions("keep this draft", 37, codeWrapping);
      assert.deepEqual(f.posted, [{ type: "toggleCodeWrapping" }]);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.runtimeCalls, []);
      assert.equal(f.provider.attachments.summaries.length, 1);
      assert.equal(f.listeners.size, 1);
      assert.equal(f.eventListeners.size, 1);
    } finally {
      vscode.workspace.getConfiguration = getConfiguration;
      f.dispose();
    }
  });
}

test("More message routes the optional wrapping state without changing the draft", async () => {
  const f = fixture();
  const calls: unknown[][] = [];
  try {
    f.provider.showMoreActions = async (...args: unknown[]) => calls.push(args);
    await f.provider.handleMessage({ type: "showMoreActions", text: "keep this draft", revision: 37 });
    for (const codeWrapping of [false, true]) {
      await f.provider.handleMessage({ type: "showMoreActions", text: "keep this draft", revision: 37, codeWrapping });
    }
    assert.deepEqual(calls, [
      ["keep this draft", 37, undefined],
      ["keep this draft", 37, false],
      ["keep this draft", 37, true],
    ]);
    assert.deepEqual(f.posted, []);
    assert.deepEqual(f.runtimeCalls, []);
  } finally {
    f.dispose();
  }
});

test("More rejects invalid wrapping values before opening the picker", async () => {
  const f = fixture();
  try {
    vscode.window.showQuickPick = async () => assert.fail("invalid wrapping state must not open the menu");
    for (const codeWrapping of [null, 0, "true", [], {}]) {
      await f.provider.handleMessage({ type: "showMoreActions", text: "keep this draft", revision: 37, codeWrapping });
    }
    assert.deepEqual(f.posted, []);
    assert.deepEqual(f.runtimeCalls, []);
    assert.deepEqual(f.commands, []);
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
      await f.provider.showMoreActions("keep this draft", 37, true);
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

for (const [action, change] of ["terminal", "wordWrap", "details"].flatMap((action) =>
  ["sessionId", "sessionFile", "cwd", "connection", "replacement-round-trip"].map(
    (change) => [action, change] as const,
  ),
)) {
  test(`More ${action} rejects a stale ${change} origin after the picker returns`, async () => {
    const f = fixture();
    try {
      f.select(action, () => {
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

for (const change of ["dispose", "replace"]) {
  test(`More Word wrap cannot target a ${change}d webview`, async () => {
    const f = fixture();
    try {
      f.provider.view = {};
      f.select("wordWrap", () => {
        f.provider.view = change === "dispose" ? undefined : {};
      });
      await assert.rejects(f.provider.showMoreActions("keep this draft", 37, true), /session changed/);
      assert.deepEqual(f.posted, []);
      assert.deepEqual(f.runtimeCalls, []);
      assert.equal(f.listeners.size, 1);
      assert.equal(f.eventListeners.size, 1);
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

for (const [action, event] of ["terminal", "wordWrap", "details"].flatMap((action) =>
  ["extension_ui_reset", "process_exit"].map((event) => [action, event] as const),
)) {
  test(`More ${action} rejects a replaced client or same-session control after ${event}`, async () => {
    const f = fixture();
    try {
      f.select(action, () => f.emitEvent(event));
      await assert.rejects(f.provider.showMoreActions("keep this draft", 37), /session changed/);
      assert.deepEqual(f.runtimeCalls, []);
      assert.deepEqual(f.commands, []);
      assert.deepEqual(f.posted, []);
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

for (const connected of [false, true]) {
  for (const busy of [false, true]) {
    for (const action of ["details", "wordWrap"]) {
      test(`More ${action} stays read-only when connected=${connected}, busy=${busy}`, async () => {
        const f = fixture();
        const cancelCapture = f.provider.fileCompletion.cancel;
        try {
          f.runtime.currentState.connected = connected;
          f.runtime.currentState.busy = busy;
          f.provider.attachments.attachments.push({ id: "context", label: "context", content: "keep" });
          f.provider.fileCompletion.cancel = () => assert.fail("read-only More must not cancel draft capture");
          f.provider.send = async () => assert.fail("read-only More must not send");
          f.provider.runBackground = async () => assert.fail("read-only More must not start an agent");
          f.select(action);
          await f.provider.handleMessage({ type: "showMoreActions", text: "keep this draft", revision: 37 });
          assert.deepEqual(f.posted, [
            { type: action === "details" ? "showConversationDetails" : "toggleCodeWrapping" },
          ]);
          assert.equal(f.provider.attachments.summaries.length, 1);
          assert.deepEqual(f.runtimeCalls, []);
          assert.deepEqual(f.commands, []);
        } finally {
          f.provider.fileCompletion.cancel = cancelCapture;
          f.dispose();
        }
      });
    }
  }
}

for (const action of routes.map(([action]) => action).filter((action) => action !== "returnTerminal")) {
  for (const blocker of ["busy", "disconnected", "request", "background", "proposal", "dialog", "queue"]) {
    test(`More ${action} cannot bypass the ${blocker} lock`, async () => {
      const f = fixture();
      let release: (() => void) | undefined;
      try {
        if (blocker === "busy") f.runtime.currentState.busy = true;
        else if (blocker === "disconnected") f.runtime.currentState.connected = false;
        else if (blocker === "request") release = f.provider.requestGate.acquire();
        else if (blocker === "background") release = f.provider.backgroundSubmissionGate.acquire();
        else if (blocker === "proposal")
          f.provider.proposals.proposals.set("active", {
            state: { status: "applying" },
            disposed: false,
          });
        else if (blocker === "dialog") f.runtime.hasPendingExtensionDialogs = true;
        else f.runtime.currentState.queue = { steering: ["pending"], followUp: [] };
        f.select(action);
        await assert.rejects(f.provider.showMoreActions("draft", 37), /Wait for Pi|Reconnect/);
        assert.deepEqual(f.runtimeCalls, []);
        assert.deepEqual(f.commands, []);
        assert.deepEqual(f.posted, []);
      } finally {
        release?.();
        f.dispose();
      }
    });
  }
}

function settingsFixture() {
  const f = fixture();
  f.runtime.currentState.model = { provider: "provider", id: "current", name: "Current model" };
  f.runtime.currentState.thinkingLevel = "unknown-current";
  f.runtime.currentState.availableModels = [{ provider: "provider", id: "next", name: "Next model" }];
  f.runtime.currentState.availableThinkingLevels = ["off", "low", "runtime-custom"];
  f.runtime.setModel = async (...args: unknown[]) => f.runtimeCalls.push(["setModel", ...args]);
  f.runtime.setThinkingLevel = async (...args: unknown[]) => f.runtimeCalls.push(["setThinkingLevel", ...args]);
  return f;
}

test("combined composer message routes without cancelling a draft capture", async () => {
  const f = settingsFixture();
  const cancelCapture = f.provider.fileCompletion.cancel;
  try {
    let opens = 0;
    f.provider.pickComposerSettings = async () => opens++;
    f.provider.fileCompletion.cancel = () => assert.fail("settings must not cancel capture");
    await f.provider.handleMessage({ type: "pickComposerSettings" });
    assert.equal(opens, 1);
    assert.deepEqual(f.runtimeCalls, []);
    assert.deepEqual(f.posted, []);
  } finally {
    f.provider.fileCompletion.cancel = cancelCapture;
    f.dispose();
  }
});

for (const action of ["model", "thinking"]) {
  test(`combined composer changes only ${action} and shows current values`, async () => {
    const f = settingsFixture();
    try {
      vscode.window.showQuickPick = async (items: any[], options: any) => {
        if (options.title === "Pi Model and Thinking") {
          assert.deepEqual(
            items.map(({ label, description }) => [label, description]),
            [
              ["Change Model", "Current model"],
              ["Change Thinking Level", "unknown-current"],
            ],
          );
          return items.find((item) => item.action === action);
        }
        return action === "model" ? items[0] : items[2];
      };
      await f.provider.handleMessage({ type: "pickComposerSettings" });
      assert.deepEqual(
        f.runtimeCalls,
        action === "model" ? [["setModel", "provider", "next"]] : [["setThinkingLevel", "runtime-custom"]],
      );
      assert.deepEqual(f.posted, []);
      assert.deepEqual(f.commands, []);
      assert.equal(f.listeners.size, 1);
      assert.equal(f.eventListeners.size, 1);
    } finally {
      f.dispose();
    }
  });
}

for (const levels of [[], ["only"], ["0", "1"], ["off", "low", "runtime-custom"]]) {
  for (const selection of [undefined, "only", "0", "1", "runtime-custom", "unknown-current", "invalid"]) {
    test(`thinking preserves runtime levels ${JSON.stringify(levels)} and validates ${selection}`, async () => {
      const f = settingsFixture();
      try {
        f.runtime.currentState.availableThinkingLevels = levels;
        vscode.window.showQuickPick = async (items: string[]) => {
          assert.deepEqual(items, levels, "unknown current level is not added or silently replaced");
          return selection;
        };
        await f.provider.pickThinkingLevel();
        assert.deepEqual(
          f.runtimeCalls,
          selection !== undefined && levels.includes(selection) ? [["setThinkingLevel", selection]] : [],
        );
        assert.deepEqual(f.posted, []);
      } finally {
        f.dispose();
      }
    });
  }
}

for (const entry of ["combined-model", "combined-thinking", "model", "thinking"]) {
  for (const selection of ["cancel", "unknown", "separator", "forged"]) {
    test(`${entry} ignores ${selection} without dispatch or draft changes`, async () => {
      const f = settingsFixture();
      try {
        vscode.window.showQuickPick = async (items: any[], options: any) => {
          if (options.title === "Pi Model and Thinking") {
            return selection === "cancel"
              ? undefined
              : selection === "separator"
                ? { label: "Invalid", kind: -1, action: "model" }
                : { label: "Invalid", action: selection === "forged" ? "model" : "unknown" };
          }
          return selection === "cancel"
            ? undefined
            : entry === "thinking"
              ? "invalid"
              : {
                  ...items[0],
                  ...(selection === "unknown" ? { id: "invalid" } : {}),
                };
        };
        if (entry.startsWith("combined")) await f.provider.pickComposerSettings();
        else if (entry === "model") await f.provider.pickModel();
        else await f.provider.pickThinkingLevel();
        assert.deepEqual(f.runtimeCalls, []);
        assert.deepEqual(f.posted, []);
        assert.deepEqual(f.commands, []);
      } finally {
        f.dispose();
      }
    });
  }
}

for (const action of ["model", "thinking"]) {
  for (const outcome of ["cancel", "invalid", "unavailable", "failure"]) {
    test(`combined ${action} second choice ${outcome} does not dispatch or change the draft`, async () => {
      const f = settingsFixture();
      try {
        vscode.window.showQuickPick = async (items: any[], options: any) => {
          if (options.title === "Pi Model and Thinking") return items.find((item) => item.action === action);
          if (outcome === "cancel") return undefined;
          if (outcome === "failure") throw new Error("picker failed");
          if (outcome === "unavailable") {
            if (action === "model") f.runtime.currentState.availableModels = [];
            else f.runtime.currentState.availableThinkingLevels = [];
            return items[0];
          }
          return action === "model" ? { ...items[0] } : "not-a-runtime-level";
        };
        if (outcome === "failure") await assert.rejects(f.provider.pickComposerSettings(), /picker failed/);
        else await f.provider.pickComposerSettings();
        assert.deepEqual(f.runtimeCalls, []);
        assert.deepEqual(f.posted, []);
        assert.deepEqual(f.commands, []);
        assert.equal(f.listeners.size, 1);
        assert.equal(f.eventListeners.size, 1);
      } finally {
        f.dispose();
      }
    });
  }
}

const settingChanges = [
  "sessionId",
  "sessionFile",
  "cwd",
  "disconnected",
  "connection-round-trip",
  "client-reset",
  "process-exit",
  "view-replaced",
  "view-disposed",
  "provider-disposed",
  "busy",
  "request",
  "background",
  "dialog",
  "queue",
] as const;
for (const entry of ["combined", "nested-model", "nested-thinking", "model", "thinking"]) {
  for (const change of settingChanges) {
    test(`${entry} rejects ${change} after the asynchronous choice`, async () => {
      const f = settingsFixture();
      let release: (() => void) | undefined;
      try {
        f.provider.view = {};
        vscode.window.showQuickPick = async (items: any[], options: any) => {
          if (options.title === "Pi Model and Thinking" && entry.startsWith("nested")) {
            return items.find((item) => item.action === (entry === "nested-model" ? "model" : "thinking"));
          }
          if (change === "sessionId" || change === "sessionFile") f.runtime.currentState[change] = "changed";
          else if (change === "cwd") f.runtime.currentCwd = "/other";
          else if (change === "disconnected" || change === "connection-round-trip") {
            f.runtime.currentState.connected = false;
            f.emit();
            if (change === "connection-round-trip") {
              f.runtime.currentState.connected = true;
              f.emit();
            }
          } else if (change === "client-reset") f.emitEvent("extension_ui_reset");
          else if (change === "process-exit") f.emitEvent("process_exit");
          else if (change === "view-replaced") f.provider.view = {};
          else if (change === "view-disposed") f.provider.view = undefined;
          else if (change === "provider-disposed") f.provider.dispose();
          else if (change === "busy") f.runtime.currentState.busy = true;
          else if (change === "request") release = f.provider.requestGate.acquire();
          else if (change === "background") release = f.provider.backgroundSubmissionGate.acquire();
          else if (change === "dialog") f.runtime.hasPendingExtensionDialogs = true;
          else f.runtime.currentState.queue = { steering: ["pending"], followUp: [] };
          return items[0];
        };
        const picking =
          entry === "model"
            ? f.provider.pickModel()
            : entry === "thinking"
              ? f.provider.pickThinkingLevel()
              : f.provider.pickComposerSettings();
        await assert.rejects(picking, /session changed|Wait for Pi|Reconnect/);
        assert.deepEqual(f.runtimeCalls, []);
        assert.deepEqual(f.commands, []);
        assert.deepEqual(f.posted, []);
        if (change !== "provider-disposed") {
          assert.equal(f.listeners.size, 1);
          assert.equal(f.eventListeners.size, 1);
        }
      } finally {
        release?.();
        f.dispose();
      }
    });
  }
}

for (const entry of ["pickComposerSettings", "pickModel", "pickThinkingLevel"]) {
  for (const change of ["busy", "disconnected"]) {
    test(`${entry} rejects ${change} before opening a native picker`, async () => {
      const f = settingsFixture();
      try {
        if (change === "busy") f.runtime.currentState.busy = true;
        else f.runtime.currentState.connected = false;
        vscode.window.showQuickPick = async () => assert.fail("locked settings must not open a picker");
        await assert.rejects(f.provider[entry](), /Wait for Pi|Reconnect/);
        assert.deepEqual(f.runtimeCalls, []);
        assert.deepEqual(f.posted, []);
      } finally {
        f.dispose();
      }
    });
  }
}

for (const type of ["setModel", "setThinking"]) {
  for (const state of ["idle", "busy", "disconnected", "invalid"]) {
    test(`legacy ${type} route validates ${state} selections`, async () => {
      const f = settingsFixture();
      try {
        if (state === "busy") f.runtime.currentState.busy = true;
        if (state === "disconnected") f.runtime.currentState.connected = false;
        await f.provider.handleMessage(
          type === "setModel"
            ? { type, provider: "provider", modelId: state === "invalid" ? "invalid" : "next" }
            : { type, level: state === "invalid" ? "invalid" : "runtime-custom" },
        );
        assert.deepEqual(
          f.runtimeCalls,
          state === "idle"
            ? type === "setModel"
              ? [["setModel", "provider", "next"]]
              : [["setThinkingLevel", "runtime-custom"]]
            : [],
        );
        assert.equal(
          f.posted.some((message) => ["setInput", "clearInput", "appendDraft"].includes(message.type)),
          false,
        );
      } finally {
        f.dispose();
      }
    });
  }
}

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
