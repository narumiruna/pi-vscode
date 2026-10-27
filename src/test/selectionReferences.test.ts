import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import type { Disposable, ExtensionContext } from "vscode";
import type { PiConversationController } from "../conversationController";
import type { PiRuntimeManager } from "../piRuntime";
import type { SidebarAttachmentManager } from "../sidebarAttachments";
import type { SidebarMessage } from "../sidebarState";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
vscode.CodeActionKind.RefactorRewrite = { append: () => ({ value: "refactor.rewrite.pi" }) };
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { registerEditorActions } = require("../editorActions") as typeof import("../editorActions");
afterAll(() => vscode.restore());

interface ReferenceProvider extends PiConversationController {
  readonly attachments: SidebarAttachmentManager;
  messages: SidebarMessage[];
  pendingNavigation?: string;
  view?: { webview: { postMessage(message: Record<string, unknown>): Promise<boolean> } };
  postState(): void;
  postMessage(message: Record<string, unknown>): void;
  refreshRecentSessions(): Promise<void>;
  handleMessage(message: unknown): Promise<void>;
  send(text: string, revision: number): Promise<void>;
  queue(kind: "steer" | "followUp", text: string, revision: number): Promise<void>;
}

function fixture(connected = true, busy = false, source = "alpha beta gamma\n", fileName = "references.ts") {
  const calls: { kind: string; session?: string; message?: string }[] = [];
  const posted: Record<string, unknown>[] = [];
  const errors: string[] = [];
  const focusSnapshots: string[][] = [];
  const history: unknown[] = connected
    ? [
        { role: "user", content: "Earlier question" },
        { role: "assistant", content: [{ type: "text", text: "Earlier answer" }] },
      ]
    : [];
  const runtime = {
    currentCwd: process.cwd(),
    currentState: {
      connected,
      busy,
      queueable: busy,
      sessionId: connected ? "current-session" : undefined,
      sessionFile: connected ? "/fixture/current-session.jsonl" : undefined,
      availableModels: [],
      availableThinkingLevels: [],
      commands: [],
    },
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: () => ({ dispose() {} }),
    ensureStarted: async () => {
      if (!runtime.currentState.connected) {
        calls.push({ kind: "start" });
        runtime.currentState = {
          ...runtime.currentState,
          connected: true,
          sessionId: "new-session",
          sessionFile: "/fixture/new-session.jsonl",
        };
      }
    },
    prompt: async (message: string, _resource: unknown, _images: unknown, onAccepted?: () => void) => {
      calls.push({ kind: "prompt", session: runtime.currentState.sessionId, message });
      history.push(
        { role: "user", content: message },
        { role: "assistant", content: [{ type: "text", text: "Reference answer" }] },
      );
      onAccepted?.();
      return "Reference answer";
    },
    getMessages: async () => history,
    queueInstruction: async (_kind: string, message: string) => {
      calls.push({ kind: "queue", session: runtime.currentState.sessionId, message });
    },
    newSession: async () => {
      calls.push({ kind: "newSession" });
      throw new Error("Ask Pi must not replace the current session.");
    },
  };
  const context = {
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [] as Disposable[],
  };
  const extensionContext = context as unknown as ExtensionContext;
  const provider = registerPiSidebar(
    extensionContext,
    runtime as unknown as PiRuntimeManager,
  ) as unknown as ReferenceProvider;
  registerEditorActions(extensionContext, provider);
  provider.postState = () => {};
  provider.postMessage = (message) => posted.push(message);
  provider.refreshRecentSessions = async () => {};
  provider.messages = connected
    ? [
        { id: "earlier-question", role: "user", content: "Earlier question" },
        { id: "earlier-answer", role: "assistant", content: "Earlier answer" },
      ]
    : [];
  let inputPrompts = 0;
  vscode.window.showInputBox = async () => {
    inputPrompts++;
    return "Unexpected immediate question";
  };
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
    return undefined;
  };
  vscode.commands.executeCommand = async (command: string) => {
    assert.equal(command, "pi.chatView.focus");
    focusSnapshots.push(provider.attachments.textContexts.map((item: { content: string }) => item.content));
    vscode.window.activeTextEditor = undefined;
  };
  const document = {
    uri: MockUri.file(path.join(process.cwd(), fileName)),
    languageId: "typescript",
    version: 1,
    getText: (range?: { start: { character: number }; end: { character: number } }) =>
      range ? source.slice(range.start.character, range.end.character) : source,
  };
  return {
    provider,
    runtime,
    calls,
    posted,
    errors,
    focusSnapshots,
    inputPrompts: () => inputPrompts,
    select: (start: number, end: number) => {
      vscode.window.activeTextEditor = {
        document,
        selection: { isEmpty: start === end, start: { line: 0, character: start }, end: { line: 0, character: end } },
      };
    },
    ask: async () => {
      const command = vscode.registrations.get("pi.askSelection");
      assert.ok(command);
      await command();
    },
    dispose: () => {
      for (const disposable of context.subscriptions) disposable.dispose();
    },
  };
}

for (const state of ["idle", "busy", "disconnected"] as const) {
  test(`Ask Pi stages an unsent selection before focus without changing the ${state} session`, async () => {
    const f = fixture(state !== "disconnected", state === "busy");
    try {
      const session = f.runtime.currentState.sessionId;
      f.select(0, 5);
      await f.ask();
      assert.equal(f.inputPrompts(), 0);
      assert.deepEqual(f.errors, []);
      assert.deepEqual(f.calls, []);
      assert.equal(f.runtime.currentState.sessionId, session);
      assert.deepEqual(f.focusSnapshots, [["alpha"]]);
      assert.deepEqual(f.provider.attachments.textContexts, [{ label: "references.ts:1:1-1:6", content: "alpha" }]);
      assert.equal(f.provider.pendingNavigation, "showSessionDetail", "Cold views retain navigation until readiness");
      assert.equal(
        f.posted.some((message) => message.type === "clearInput" || message.type === "setInput"),
        false,
      );
    } finally {
      f.dispose();
    }
  });
}

test("same-line references stay distinct, the same range refreshes, and each reference can be removed", async () => {
  const f = fixture();
  try {
    f.select(0, 5);
    await f.ask();
    f.select(6, 10);
    await f.ask();
    const first = f.provider.attachments.values[0];
    assert.deepEqual(f.provider.attachments.textContexts, [
      { label: "references.ts:1:1-1:6", content: "alpha" },
      { label: "references.ts:1:7-1:11", content: "beta" },
    ]);
    f.select(6, 10);
    await f.ask();
    assert.equal(f.provider.attachments.values.length, 2);
    await f.provider.handleMessage({ type: "removeAttachment", id: first.id });
    assert.deepEqual(f.provider.attachments.textContexts, [{ label: "references.ts:1:7-1:11", content: "beta" }]);
    assert.deepEqual(f.calls, []);
  } finally {
    f.dispose();
  }
});

for (const connected of [true, false]) {
  test(`explicit Send submits remaining references to the ${connected ? "current" : "new"} session`, async () => {
    const f = fixture(connected);
    try {
      f.select(0, 5);
      await f.ask();
      f.select(6, 10);
      await f.ask();
      await f.provider.handleMessage({ type: "removeAttachment", id: f.provider.attachments.values[0].id });
      assert.equal(f.calls.length, 0);

      await f.provider.send("Explain the beta reference, then suggest a change.", 4);

      assert.deepEqual(
        f.calls.map((call) => call.kind),
        connected ? ["prompt"] : ["start", "prompt"],
      );
      const prompt = f.calls.at(-1);
      assert.ok(prompt);
      assert.equal(prompt.session, connected ? "current-session" : "new-session");
      assert.match(prompt.message ?? "", /references\.ts:1:7-1:11/);
      assert.match(prompt.message ?? "", /beta/);
      assert.doesNotMatch(prompt.message ?? "", /alpha|references\.ts:1:1-1:6|PI_VSCODE_POLICY/);
      assert.equal(f.provider.attachments.values.length, 0);
      if (connected)
        assert.equal(
          f.provider.messages.some((message: SidebarMessage) => message.content === "Earlier answer"),
          true,
        );
    } finally {
      f.dispose();
    }
  });
}

test("busy-session references use the normal queue only after an explicit composer submission", async () => {
  const f = fixture(true, true);
  try {
    f.select(0, 5);
    await f.ask();
    f.select(6, 10);
    await f.ask();
    assert.equal(f.calls.length, 0);
    await f.provider.queue("followUp", "Compare alpha with beta.", 8);
    assert.equal(f.calls.length, 1);
    assert.equal(f.calls[0]?.kind, "queue");
    assert.equal(f.calls[0]?.session, "current-session");
    assert.match(f.calls[0]?.message ?? "", /references\.ts:1:1-1:6/);
    assert.match(f.calls[0]?.message ?? "", /references\.ts:1:7-1:11/);
    assert.equal(f.provider.attachments.values.length, 0);
  } finally {
    f.dispose();
  }
});

test("empty selections and the attachment limit reveal inline notices without replacing references", async () => {
  const f = fixture();
  try {
    f.select(0, 0);
    await f.ask();
    assert.deepEqual(f.focusSnapshots, [[]]);
    for (let index = 0; index < 8; index++) {
      f.select(index, index + 1);
      await f.ask();
    }
    const ids = f.provider.attachments.values.map((item: { id: string }) => item.id);
    f.select(9, 10);
    await f.ask();
    assert.equal(f.focusSnapshots.length, 10);
    assert.deepEqual(
      f.provider.attachments.values.map((item: { id: string }) => item.id),
      ids,
    );
    assert.ok(f.posted.some((message) => message.type === "notice" && /maximum of 8/.test(String(message.message))));
    assert.deepEqual(f.calls, []);
  } finally {
    f.dispose();
  }
});

test("cold first-open capture retains both sensitive-content and truncation warnings until readiness", async () => {
  const source = `token=abcdefghijklmnop${"x".repeat(200_000)}`;
  const f = fixture(false, false, source, ".env");
  try {
    f.provider.postMessage = Object.getPrototypeOf(f.provider).postMessage;
    f.select(0, source.length);
    await f.ask();
    assert.equal(f.provider.attachments.textContexts[0]?.content.length, 200_000);
    assert.equal(f.posted.filter((message) => message.type === "notice").length, 0);
    f.provider.view = {
      webview: {
        postMessage: async (message) => {
          f.posted.push(message);
          return true;
        },
      },
    };
    await f.provider.handleMessage({ type: "ready" });
    const notices = f.posted.filter((message) => message.type === "notice");
    assert.equal(notices.length, 1);
    assert.match(String(notices[0]?.message), /Sensitive filename/);
    assert.match(String(notices[0]?.message), /Possible secret pattern/);
    assert.match(String(notices[0]?.message), /truncated/);
    await f.provider.handleMessage({ type: "ready" });
    assert.equal(f.posted.filter((message) => message.type === "notice").length, 1);
    assert.deepEqual(f.calls, []);
  } finally {
    f.dispose();
  }
});

test("Ask Pi keeps its menu command and adds a selection-only shortcut", () => {
  const manifest = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(
    manifest.contributes.menus["pi.selectionMenu"].some(
      (item: { command: string }) => item.command === "pi.askSelection",
    ),
  );
  assert.deepEqual(
    manifest.contributes.keybindings.find((item: { command: string }) => item.command === "pi.askSelection"),
    {
      command: "pi.askSelection",
      key: "ctrl+alt+a",
      mac: "cmd+alt+a",
      when: "editorTextFocus && editorHasSelection",
    },
  );
});
