import assert from "node:assert/strict";
import { discoverSlashCommands, parseSidebarSlashCommand, sidebarSlashCommands } from "../slashCommands";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
afterAll(() => vscode.restore());

test("the local slash catalog has unique names and parses only complete local command names", () => {
  assert.equal(new Set(sidebarSlashCommands.map((command) => command.name)).size, sidebarSlashCommands.length);
  for (const command of sidebarSlashCommands) {
    assert.ok(command.description);
    assert.deepEqual(parseSidebarSlashCommand(` /${command.name} \n`), { name: command.name, arguments: "" });
  }
  assert.deepEqual(parseSidebarSlashCommand("/compact Keep the API\nand tests"), {
    name: "compact",
    arguments: "Keep the API\nand tests",
  });
  for (const text of ["/", "/newer", "/skill:review", "/custom", "explain /model", "/MODEL"])
    assert.equal(parseSidebarSlashCommand(text), undefined, text);
});

test("discovery preserves exact Pi skill names and excludes local collisions and internal commands", () => {
  const commands = [
    { name: "skill:review", description: "Review code", source: "skill" },
    { name: "skill:review", source: "skill" },
    { name: "template", source: "prompt" },
    { name: "skill:not-a-skill", source: "extension" },
    { name: "new", source: "extension" },
    { name: "vscode-pi-control", source: "extension" },
    { name: "VSCODE-PI-CONTROL", source: "skill" },
    { name: "bad name", source: "skill" },
    { name: "/bad", source: "skill" },
    { name: "x".repeat(201), source: "skill" },
    { name: 3 },
  ];
  assert.deepEqual(
    discoverSlashCommands(commands).map((command) => command.name),
    ["skill:review", "template", "skill:not-a-skill"],
  );
  assert.deepEqual(discoverSlashCommands(commands, true), [
    { name: "skill:review", description: "Review code", source: "skill" },
  ]);
});

function fixture(connected = true) {
  const posted: any[] = [];
  const calls: unknown[][] = [];
  const stateListeners = new Set<() => void>();
  const eventListeners = new Set<(event: { type: string }) => void>();
  const runtime: any = {
    currentCwd: process.cwd(),
    clientGeneration: 1,
    currentState: {
      connected,
      busy: false,
      sessionId: "slash-session",
      commands: [],
      availableModels: [{ provider: "test", id: "model", name: "Test model" }],
      availableThinkingLevels: ["off", "high"],
    },
    hasPendingExtensionDialogs: false,
    onDidChangeState: (listener: () => void) => {
      stateListeners.add(listener);
      return { dispose: () => stateListeners.delete(listener) };
    },
    onEvent: (listener: (event: { type: string }) => void) => {
      eventListeners.add(listener);
      return { dispose: () => eventListeners.delete(listener) };
    },
    ensureStarted: async () => {
      calls.push(["start"]);
      runtime.currentState.connected = true;
    },
    setModel: async (...args: unknown[]) => calls.push(["setModel", ...args]),
    setThinkingLevel: async (...args: unknown[]) => calls.push(["setThinkingLevel", ...args]),
    prompt: async () => assert.fail("A local slash command must not send a model prompt"),
  };
  const context: any = {
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  provider.postState = () => {};
  provider.scheduleState = () => {};
  provider.postMessage = (message: unknown) => posted.push(message);
  provider.postNotice = (...args: unknown[]) => posted.push({ type: "notice", args });
  provider.navigate = (type: string) => posted.push({ type });
  provider.runRequest = async () => assert.fail("A local slash command must not run an agent request");
  vscode.window.showQuickPick = async () => undefined;
  vscode.commands.executeCommand = async (...args: unknown[]) => calls.push(args);
  return {
    provider,
    runtime,
    calls,
    posted,
    emit: () => {
      for (const listener of stateListeners) listener();
    },
    event: (type: string) => {
      for (const listener of eventListeners) listener({ type });
    },
    dispose: () => {
      for (const disposable of context.subscriptions) disposable.dispose();
    },
  };
}

for (const [command, method] of [
  ["new", "newSession"],
  ["model", "pickModel"],
  ["thinking", "pickThinkingLevel"],
  ["resume", "quickSwitchSession"],
  ["reconnect", "reconnect"],
  ["reload", "reloadResources"],
] as const) {
  for (const entry of ["send", "sendInNewSession"]) {
    test(`/${command} uses the existing host route from ${entry} without a model request`, async () => {
      const f = fixture();
      try {
        f.provider[method] = async () => {
          f.calls.push([method]);
          return true;
        };
        const text = `/${command} `;
        await f.provider[entry](text, 7);
        assert.deepEqual(f.calls, [[method]]);
        assert.ok(
          f.posted.some(
            (message) =>
              message.type === "clearInput" && message.expectedText === text && message.expectedRevision === 7,
          ),
        );
        if (command === "new") assert.ok(f.posted.some((message) => message.type === "showSessionDetail"));
      } finally {
        f.dispose();
      }
    });
  }
}

for (const [command, action] of [
  ["settings", "pi.openPiConfiguration"],
  ["extension-settings", "pi.openSettings"],
  ["session", undefined],
] as const) {
  test(`/${command} remains process-free while disconnected`, async () => {
    const f = fixture(false);
    try {
      await f.provider.send(`/${command}`, 5);
      assert.deepEqual(f.calls, action ? [[action]] : []);
      assert.equal(f.runtime.currentState.connected, false);
      if (!action) assert.equal(f.posted[0].type, "showConversationDetails");
      assert.equal(f.posted.at(-1).type, "clearInput");
    } finally {
      f.dispose();
    }
  });
}

test("/model starts Pi only on execution and then uses the existing guarded picker", async () => {
  const f = fixture(false);
  try {
    vscode.window.showQuickPick = async (items: any[], options: any) => {
      assert.deepEqual(f.calls, [["start"]]);
      assert.equal(options.title, "Choose Pi Model");
      return items[0];
    };
    await f.provider.send("/model", 2);
    assert.deepEqual(f.calls, [["start"], ["setModel", "test", "model"]]);
  } finally {
    f.dispose();
  }
});

for (const command of ["skills", "commands"]) {
  test(`/${command} discovers Pi resources and inserts a revision-bound command without executing it`, async () => {
    const f = fixture(false);
    try {
      f.runtime.currentState.commands = [
        { name: "skill:review", description: "Review code", source: "skill" },
        { name: "template", source: "prompt" },
        { name: "extension", source: "extension" },
        { name: "settings", source: "extension" },
        { name: "vscode-pi-control", source: "extension" },
      ];
      vscode.window.showQuickPick = async (items: any[], options: any) => {
        assert.deepEqual(f.calls, [["start"]]);
        assert.equal(options.title, command === "skills" ? "Pi Skills" : "Pi Commands, Prompts, and Skills");
        assert.equal(options.matchOnDetail, true);
        assert.equal(options.matchOnDescription, true);
        assert.deepEqual(
          items.map((item) => item.command),
          command === "skills" ? ["skill:review"] : ["skill:review", "template", "extension"],
        );
        return items[0];
      };
      await f.provider.send(`/${command} `, 11);
      assert.deepEqual(f.posted, [
        { type: "setInput", text: "/skill:review ", expectedText: `/${command} `, expectedRevision: 11 },
        { type: "sendRejected" },
      ]);
    } finally {
      f.dispose();
    }
  });
}

test("cancelling /skills keeps the command draft and releases pending submission", async () => {
  const f = fixture();
  try {
    f.runtime.currentState.commands = [{ name: "skill:review", source: "skill" }];
    await f.provider.send("/skills", 4);
    assert.deepEqual(f.posted, [{ type: "sendRejected" }]);
    assert.deepEqual(f.calls, []);
  } finally {
    f.dispose();
  }
});

test("empty skill discovery explains configuration and reload without changing approval or sending a prompt", async () => {
  const f = fixture();
  try {
    await f.provider.send("/skills", 4);
    assert.equal(f.posted[0].type, "notice");
    assert.match(f.posted[0].args[0], /project-resource approval.*\/reload/);
    assert.deepEqual(f.posted.at(-1), { type: "sendRejected" });
    assert.deepEqual(f.calls, []);
  } finally {
    f.dispose();
  }
});

for (const transition of ["session", "client", "busy", "reset", "view"]) {
  test(`/skills rejects a stale ${transition} while choosing a skill`, async () => {
    const f = fixture();
    try {
      f.runtime.currentState.commands = [{ name: "skill:review", source: "skill" }];
      vscode.window.showQuickPick = async (items: any[]) => {
        if (transition === "session") f.runtime.currentState.sessionId = "other";
        if (transition === "client") f.runtime.clientGeneration++;
        if (transition === "busy") f.runtime.currentState.busy = true;
        if (transition === "reset") f.event("extension_ui_reset");
        if (transition === "view") f.provider.view = {};
        f.emit();
        return items[0];
      };
      await assert.rejects(f.provider.send("/skills", 3), /changed|Wait for Pi/);
      assert.equal(
        f.posted.some((message) => message.type === "setInput"),
        false,
      );
    } finally {
      f.dispose();
    }
  });
}

for (const blocker of ["busy", "attachments", "dialogs", "queue", "pendingQueue", "background", "prepared"]) {
  test(`local commands reject ${blocker} before starting Pi or opening controls`, async () => {
    const f = fixture(false);
    let release: (() => void) | undefined;
    try {
      if (blocker === "busy") f.runtime.currentState.busy = true;
      if (blocker === "attachments") f.provider.attachments.attachments.push({ id: "a", label: "a", content: "keep" });
      if (blocker === "dialogs") f.runtime.hasPendingExtensionDialogs = true;
      if (blocker === "queue") f.runtime.currentState.queue = { steering: ["pending"], followUp: [] };
      if (blocker === "pendingQueue") f.runtime.currentState.pendingQueue = { steering: [], followUp: [{}] };
      if (blocker === "background") release = f.provider.backgroundSubmissionGate.acquire();
      if (blocker === "prepared") f.provider.preparedEditorRequest = { id: "prepared" };
      await assert.rejects(f.provider.sendSlashCommand("/skills", 3), /Wait for Pi|Remove attachments|editor action/);
      assert.deepEqual(f.calls, []);
      assert.equal(
        f.posted.some((message) => message.type === "setInput" || message.type === "clearInput"),
        false,
      );
    } finally {
      release?.();
      f.dispose();
    }
  });
}

for (const change of ["workspace", "view", "prepared", "busy", "disposed"]) {
  test(`cold slash execution rejects a changed ${change} after startup`, async () => {
    const f = fixture(false);
    try {
      f.runtime.ensureStarted = async () => {
        f.runtime.currentState.connected = true;
        if (change === "workspace") f.runtime.currentCwd += "/other";
        if (change === "view") f.provider.view = {};
        if (change === "prepared") f.provider.preparedEditorRequest = { id: "new-action" };
        if (change === "busy") f.runtime.currentState.busy = true;
        if (change === "disposed") f.provider.dispose();
      };
      await assert.rejects(f.provider.send("/skills", 8), /changed|Wait for Pi/);
      assert.equal(
        f.posted.some((message) => message.type === "setInput" || message.type === "clearInput"),
        false,
      );
    } finally {
      f.dispose();
    }
  });
}

test("unknown arguments and reserved controls cannot fall through to a model request", async () => {
  const f = fixture(false);
  try {
    for (const text of ["/new prompt text", "/model provider/model", "/skills review", "/settings extra"])
      await assert.rejects(f.provider.send(text, 1), /does not accept arguments/);
    for (const text of ["/vscode-pi-control {}", " /VSCODE-PI-CONTROL {}"])
      await assert.rejects(f.provider.send(text, 1), /Internal Pi controls/);
    assert.deepEqual(f.calls, []);
    assert.deepEqual(f.posted, []);
  } finally {
    f.dispose();
  }
});

test("/compact clears only after acceptance and a cancelled /reload retains its draft", async () => {
  const f = fixture();
  try {
    f.provider.compact = async (instructions: string, accepted: () => void) => {
      assert.equal(instructions, "Preserve tests");
      assert.deepEqual(f.posted, []);
      accepted();
    };
    await f.provider.send("/compact Preserve tests", 4);
    assert.deepEqual(f.posted, [{ type: "clearInput", expectedText: "/compact Preserve tests", expectedRevision: 4 }]);
    f.posted.length = 0;
    f.provider.reloadResources = async () => false;
    await f.provider.send("/reload", 5);
    assert.deepEqual(f.posted, [{ type: "sendRejected" }]);
  } finally {
    f.dispose();
  }
});
