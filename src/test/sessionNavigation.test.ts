import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
const history = require("../sessionHistory") as typeof import("../sessionHistory");
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
afterAll(() => vscode.restore());
afterEach(() => vi.restoreAllMocks());

async function fixture() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-session-navigation-")));
  const cwd = path.join(root, "workspace");
  const directory = path.join(root, "sessions");
  await Promise.all([mkdir(cwd), mkdir(directory)]);
  const files = ["a", "b", "c"].map((id) => path.join(directory, `${id}.jsonl`));
  const write = async (index: number, title = "Same title", id = `session-${index}`) => {
    await writeFile(
      files[index]!,
      `${JSON.stringify({ type: "session", version: 3, id, cwd })}\n${JSON.stringify({ type: "session_info", name: title })}\n`,
    );
    await utimes(files[index]!, 30 - index, 30 - index);
  };
  await Promise.all(files.map((_, index) => write(index)));
  const stateListeners = new Set<() => void>();
  const eventListeners = new Set<(event: any) => void>();
  const switches: unknown[][] = [];
  const focus: string[] = [];
  const posted: any[] = [];
  let starts = 0;
  const runtime: any = {
    currentCwd: cwd,
    clientGeneration: 1,
    currentState: { connected: true, busy: false, sessionFile: files[0], sessionId: "session-0", commands: [] },
    hasPendingExtensionDialogs: false,
    ensureStarted: async () => {
      starts++;
    },
    onDidChangeState: (listener: () => void) => {
      stateListeners.add(listener);
      return { dispose: () => stateListeners.delete(listener) };
    },
    onEvent: (listener: (event: any) => void) => {
      eventListeners.add(listener);
      return { dispose: () => eventListeners.delete(listener) };
    },
    getMessages: async () => [{ role: "user", content: `History ${runtime.currentState.sessionId}` }],
    switchSession: async (file: string, id: string) => {
      switches.push([file, id]);
      for (const listener of eventListeners) listener({ type: "extension_ui_reset" });
      runtime.currentState.sessionFile = file;
      runtime.currentState.sessionId = id;
      for (const listener of stateListeners) listener();
    },
  };
  const context: any = {
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [{ uri: MockUri.file(cwd) }];
  vscode.commands.executeCommand = async (id: string) => focus.push(id);
  vscode.window.showQuickPick = async () => undefined;
  const provider = registerPiSidebar(context, runtime) as any;
  provider.postState = () => {};
  provider.scheduleState = () => {};
  provider.postMessage = (message: unknown) => posted.push(message);
  provider.postNotice = (...args: unknown[]) => posted.push({ type: "notice", args });
  provider.navigate = (type: string) => posted.push({ type });
  provider.messages = [{ id: "original", role: "user", content: "Original history" }];
  provider.attachments.attachments.push({ id: "draft-context", label: "Keep until success", content: "draft" });
  return {
    provider,
    runtime,
    switches,
    files,
    directory,
    context,
    focus,
    posted,
    write,
    starts: () => starts,
    emit: (type: string) => {
      for (const listener of eventListeners) listener({ type });
    },
    select: (index: number, before?: (items: any[], options: any) => Promise<void> | void) => {
      vscode.window.showQuickPick = async (items: any[], options: any) => {
        await before?.(items, options);
        return items[index];
      };
    },
    dispose: async () => {
      for (const disposable of context.subscriptions) disposable.dispose();
      vscode.workspace.workspaceFolders = [];
      vscode.workspace.isTrusted = true;
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("registered search filters bounded titles and IDs and shares the authoritative transition", async () => {
  const f = await fixture();
  try {
    await f.write(1, "Unsafe\u001b[31m $(zap)\u202e title");
    f.select(1, (items, options) => {
      assert.equal(options.title, "Switch Pi Session");
      assert.equal(options.matchOnDescription, true);
      assert.equal(options.canPickMany, undefined);
      assert.equal(items.length, 3);
      assert.match(items[0].description, /Current.*session-0/);
      assert.equal(items[2].label, "Same title");
      assert.match(items[2].description, /session-2/);
      for (const forbidden of ["\u001b", "\u202e", "$("]) assert.equal(items[1].label.includes(forbidden), false);
      assert.equal(f.provider.attachments.summaries.length, 1);
    });
    await vscode.registrations.get("pi.switchSession")();
    assert.deepEqual(f.switches, [[f.files[1], "session-1"]]);
    assert.deepEqual(f.focus, ["pi.chatView.focus"]);
    assert.equal(f.provider.attachments.summaries.length, 0);
    assert.ok(f.provider.messages.some((message: any) => message.content === "History session-1"));
    assert.ok(f.posted.some((message) => message.type === "showSessionDetail"));
    assert.equal(f.starts(), 1);
  } finally {
    await f.dispose();
  }
});

for (const selection of [undefined, 0]) {
  test(`search ${selection === undefined ? "cancellation" : "current selection"} keeps drafts and focus`, async () => {
    const f = await fixture();
    try {
      if (selection !== undefined) f.select(selection);
      await f.provider.quickSwitchSession();
      assert.deepEqual(f.switches, []);
      assert.deepEqual(f.focus, []);
      assert.equal(f.provider.attachments.summaries.length, 1);
      assert.equal(f.provider.messages[0].content, "Original history");
    } finally {
      await f.dispose();
    }
  });
}

test("cycle visits three sessions in both directions without modification-time bounce", async () => {
  const f = await fixture();
  try {
    await vscode.registrations.get("pi.nextSession")();
    await utimes(f.files[1]!, 300, 300);
    await vscode.registrations.get("pi.nextSession")();
    await utimes(f.files[2]!, 400, 400);
    await f.provider.cycleSession(1);
    await f.provider.cycleSession(-1);
    await f.provider.cycleSession(-1);
    await f.provider.cycleSession(-1);
    assert.deepEqual(
      f.switches.map(([file]) => file),
      [f.files[1], f.files[2], f.files[0], f.files[2], f.files[1], f.files[0]],
    );
  } finally {
    await f.dispose();
  }
});

test("cycle rebuilds after changed membership, explicit search, resource reset, and generation change", async () => {
  const f = await fixture();
  try {
    await f.provider.cycleSession(1);
    await utimes(f.files[1]!, 300, 300);
    await rm(f.files[2]!);
    await f.provider.cycleSession(1);
    assert.equal(f.switches.at(-1)?.[0], f.files[0]);
    await f.write(2);
    f.select(0); // Explicit search chooses the now-newest session B.
    await f.provider.quickSwitchSession();
    await f.provider.cycleSession(1);
    assert.equal(f.switches.at(-1)?.[0], f.files[0]);
    f.emit("extension_ui_reset");
    assert.equal(f.provider.sessionCycle.length, 0);
    await f.provider.cycleSession(1);
    f.runtime.clientGeneration++;
    await utimes(f.files[0]!, 500, 500);
    await f.provider.cycleSession(1);
    assert.equal(f.provider.sessionCycleOrigin, JSON.stringify([f.runtime.currentCwd, 2]));
  } finally {
    await f.dispose();
  }
});

for (const direction of [-1, 1] as const) {
  test(`unsaved current session is not a cycle target (${direction})`, async () => {
    const f = await fixture();
    try {
      f.runtime.currentState.sessionFile = path.join(f.directory, "unsaved.jsonl");
      f.runtime.currentState.sessionId = "temporary";
      await f.provider.cycleSession(direction);
      assert.deepEqual(f.switches, [[f.files[direction === 1 ? 0 : 2], `session-${direction === 1 ? 0 : 2}`]]);
    } finally {
      await f.dispose();
    }
  });
}

test("empty and single-session cycles do not submit a switch", async () => {
  const f = await fixture();
  try {
    await Promise.all([rm(f.files[1]!), rm(f.files[2]!)]);
    await f.provider.cycleSession(1);
    assert.deepEqual(f.switches, []);
    await rm(f.files[0]!);
    await f.provider.cycleSession(-1);
    await f.provider.quickSwitchSession();
    assert.deepEqual(f.switches, []);
    assert.ok(f.posted.some((message) => message.args?.[0].includes("No saved Pi sessions")));
  } finally {
    await f.dispose();
  }
});

for (const mutate of [
  (f: any) => {
    f.runtime.currentState.busy = true;
  },
  (f: any) => {
    f.runtime.hasPendingExtensionDialogs = true;
  },
  (f: any) => {
    f.runtime.currentState.queue = { steering: ["queued"], followUp: [] };
  },
  (f: any) => {
    f.runtime.currentState.pendingQueue = { steering: [], followUp: ["pending"] };
  },
  (f: any) => {
    f.provider.requestGate.acquire();
  },
  (f: any) => {
    f.provider.backgroundSubmissionGate.acquire();
  },
  () => {
    vscode.workspace.isTrusted = false;
  },
  () => {
    vscode.workspace.workspaceFolders = [{ uri: new MockUri("vscode-vfs", "/virtual") }];
  },
  (f: any) => {
    f.provider.dispose();
  },
]) {
  test(`navigation rejects conflicting or unavailable host state: ${mutate.toString()}`, async () => {
    const f = await fixture();
    try {
      f.select(1);
      mutate(f);
      await assert.rejects(f.provider.quickSwitchSession());
      assert.deepEqual(f.switches, []);
      assert.deepEqual(f.focus, []);
      assert.equal(f.provider.messages[0].content, "Original history");
    } finally {
      await f.dispose();
    }
  });
}

for (const change of ["generation", "session", "workspace", "view", "dispose", "busy", "event"] as const) {
  test(`picker rejects stale ${change} without clearing the draft`, async () => {
    const f = await fixture();
    try {
      f.select(1, () => {
        if (change === "generation") f.runtime.clientGeneration++;
        if (change === "session") f.runtime.currentState.sessionId = "replacement";
        if (change === "workspace") f.runtime.currentCwd = path.dirname(f.runtime.currentCwd);
        if (change === "view") f.provider.view = {};
        if (change === "dispose") f.provider.disposed = true;
        if (change === "busy") f.runtime.currentState.busy = true;
        if (change === "event") f.emit("extension_ui_reset");
      });
      await assert.rejects(f.provider.quickSwitchSession());
      assert.deepEqual(f.switches, []);
      assert.deepEqual(f.focus, []);
      assert.equal(f.provider.attachments.summaries.length, 1);
    } finally {
      await f.dispose();
    }
  });
}

test("discovery failure never authorizes switching through a cached sidebar index", async () => {
  const f = await fixture();
  try {
    f.provider.recentSessions = await history.listRecentPiSessions(f.files[0]!, f.runtime.currentCwd);
    vi.spyOn(history, "listRecentPiSessions").mockResolvedValue(undefined);
    f.select(1);
    await assert.rejects(f.provider.quickSwitchSession(), /discovery failed/);
    await assert.rejects(f.provider.cycleSession(1), /discovery failed/);
    assert.deepEqual(f.switches, []);
    assert.equal(f.provider.attachments.summaries.length, 1);
  } finally {
    await f.dispose();
  }
});

for (const change of ["generation", "view", "resource-reset", "trust", "virtual"] as const) {
  test(`metadata discovery ${change} cannot open a stale picker`, async () => {
    const f = await fixture();
    try {
      vi.spyOn(history, "listRecentPiSessions").mockImplementation(async () => {
        await Promise.resolve();
        if (change === "generation") f.runtime.clientGeneration++;
        if (change === "view") f.provider.view = {};
        if (change === "resource-reset") f.emit("extension_ui_reset");
        if (change === "trust") vscode.workspace.isTrusted = false;
        if (change === "virtual") vscode.workspace.workspaceFolders = [{ uri: new MockUri("vscode-vfs", "/virtual") }];
        return [];
      });
      vscode.window.showQuickPick = async () => assert.fail("A stale discovery must not open the picker");
      await assert.rejects(f.provider.quickSwitchSession(), /changed while choosing|trusted|file-backed/);
      assert.deepEqual(f.switches, []);
      assert.deepEqual(f.focus, []);
    } finally {
      await f.dispose();
    }
  });
}

test("cold navigation restores through normal startup without focusing before acceptance", async () => {
  const f = await fixture();
  try {
    f.runtime.currentState = { connected: false, busy: false };
    let starts = 0;
    f.runtime.ensureStarted = async () => {
      starts++;
      assert.deepEqual(f.focus, []);
      f.runtime.currentState = { connected: true, busy: false, sessionFile: f.files[0], sessionId: "session-0" };
    };
    f.select(1);
    await f.provider.quickSwitchSession();
    assert.equal(starts, 1);
    assert.deepEqual(f.switches, [[f.files[1], "session-1"]]);
    assert.deepEqual(f.focus, ["pi.chatView.focus"]);
  } finally {
    await f.dispose();
  }
});

test("navigation remains exclusive while accepted-switch history is synchronizing", async () => {
  const f = await fixture();
  let finish!: (messages: unknown[]) => void;
  let ready!: () => void;
  const waiting = new Promise<void>((resolve) => {
    ready = resolve;
  });
  try {
    f.runtime.getMessages = () => {
      ready();
      return new Promise<unknown[]>((resolve) => {
        finish = resolve;
      });
    };
    const pending = f.provider.cycleSession(1);
    await waiting;
    assert.equal(f.provider.requestGate.isPending, true);
    await assert.rejects(f.provider.cycleSession(1), /already pending/);
    await assert.rejects(f.provider.quickSwitchSession(), /already pending/);
    assert.equal(f.switches.length, 1);
    finish([{ role: "user", content: "Accepted history" }]);
    await pending;
    assert.equal(f.provider.requestGate.isPending, false);
    assert.equal(f.provider.messages[0].content, "Accepted history");
  } finally {
    await f.dispose();
  }
});

test("forged picker item and cold startup failure do not dispatch or create an alternate session", async () => {
  const f = await fixture();
  try {
    vscode.window.showQuickPick = async (items: any[]) => ({ ...items[1] });
    await assert.rejects(f.provider.quickSwitchSession(), /not offered/);
    f.runtime.ensureStarted = async () => {
      throw new Error("Restore failed");
    };
    await assert.rejects(f.provider.cycleSession(1), /Restore failed/);
    assert.deepEqual(f.switches, []);
    assert.deepEqual(f.focus, []);
  } finally {
    await f.dispose();
  }
});

test("repeated navigation is rejected while a picker or transition is pending", async () => {
  const f = await fixture();
  let accept!: () => void;
  let opened!: () => void;
  const ready = new Promise<void>((resolve) => {
    opened = resolve;
  });
  try {
    vscode.window.showQuickPick = async (items: any[]) => {
      opened();
      await new Promise<void>((resolve) => {
        accept = resolve;
      });
      return items[1];
    };
    const pending = f.provider.quickSwitchSession();
    await ready;
    await assert.rejects(f.provider.cycleSession(1), /already pending/);
    await assert.rejects(f.provider.quickSwitchSession(), /already pending/);
    await f.provider.switchRecentSession("anything");
    assert.equal(f.switches.length, 0);
    accept();
    await pending;
    assert.equal(f.switches.length, 1);
  } finally {
    await f.dispose();
  }
});

for (const failure of ["rpc", "history"] as const) {
  test(`switch ${failure} failure never replays or clears state before acceptance`, async () => {
    const f = await fixture();
    try {
      f.select(1);
      if (failure === "rpc") {
        f.runtime.switchSession = async () => {
          throw new Error("Pi cancelled the switch");
        };
        await assert.rejects(f.provider.quickSwitchSession(), /cancelled/);
        assert.equal(f.provider.attachments.summaries.length, 1);
        assert.equal(f.provider.messages[0].content, "Original history");
        assert.deepEqual(f.focus, []);
      } else {
        f.runtime.getMessages = async () => {
          throw new Error("History unavailable");
        };
        await f.provider.quickSwitchSession();
        assert.equal(f.switches.length, 1);
        assert.equal(f.runtime.currentState.sessionId, "session-1");
        assert.equal(f.provider.historyRecoveryAvailable, true);
        assert.ok(f.posted.some((message) => message.args?.[0].includes("Do not repeat")));
      }
    } finally {
      await f.dispose();
    }
  });
}
