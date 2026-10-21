import assert from "node:assert/strict";
import type { ConversationHistoryWindow } from "../conversationHistory";
import { ImageAssetCache } from "../imageAssets";
import {
  limitSidebarMessages,
  persistableSidebarMessages,
  restoreSidebarMessages,
  type SidebarMessage,
} from "../sidebarState";
import { installVscodeMock, MockUri } from "./vscodeMock";

function toolMessage(id: string, input = "arguments", output = "result"): SidebarMessage {
  return {
    id: `tool-${id}`,
    role: "tool",
    content: "",
    tool: { id, name: "read", status: "success", summary: "file.ts", input, output },
  };
}

function imageCache(): ImageAssetCache {
  return new ImageAssetCache({ maxImageBytes: 100, maxTotalBytes: 1024, maxAssets: 10 });
}

function sidebarFixture() {
  const vscode = installVscodeMock();
  vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  let stateChanged = () => {};
  const runtime: any = {
    currentState: { connected: true, sessionId: "one" },
    currentCwd: process.cwd(),
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: (listener: () => void) => {
      stateChanged = listener;
      return { dispose() {} };
    },
    ensureStarted: async () => {},
    getMessages: async () => [],
    prompt: async () => undefined,
  };
  const persisted: unknown[] = [];
  const context: any = {
    workspaceState: { get: () => undefined, update: async (_key: string, value: unknown) => persisted.push(value) },
    extensionUri: MockUri.file("/extension"),
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  return {
    provider,
    runtime,
    persisted,
    stateChanged: () => stateChanged(),
    event: (value: unknown) => provider.handleRuntimeEvent(value),
    dispose: () => {
      for (const disposable of context.subscriptions) disposable.dispose();
      vscode.restore();
    },
  };
}

test("live tools keep their chronological position across thinking, text, results and the next request", async () => {
  const fixture = sidebarFixture();
  const { provider, event } = fixture;
  try {
    provider.messages = [{ id: "request", role: "user", content: "first request" }];
    event({ type: "agent_start" });
    event({ type: "message_start", message: { role: "assistant", timestamp: 1 } });
    event({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Inspect first" },
    });
    event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Inspect first" },
          { type: "text", text: "Reading files" },
        ],
      },
    });
    event({ type: "tool_execution_start", toolCallId: "read", toolName: "read", args: { path: "first.ts" } });
    event({ type: "tool_execution_start", toolCallId: "bash", toolName: "bash", args: { command: "pwd" } });
    const order = provider.messages.map((message: SidebarMessage) => message.id);
    event({
      type: "tool_execution_update",
      toolCallId: "read",
      partialResult: { content: [{ type: "text", text: "partial" }] },
    });
    event({ type: "tool_execution_end", toolCallId: "bash", result: "second result", isError: true });
    event({ type: "tool_execution_end", toolCallId: "read", result: { content: [{ type: "text", text: "final" }] } });
    assert.deepEqual(
      provider.messages.map((message: SidebarMessage) => message.id),
      order,
    );
    assert.equal(provider.messages[1].thinking[0].text, "Inspect first");
    assert.equal(provider.messages[2].tool.output, "final");
    assert.equal(provider.messages[3].tool.status, "error");
    event({ type: "message_start", message: { role: "assistant", timestamp: 2 } });
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "Done" }] } });
    event({ type: "agent_settled" });
    event({ type: "agent_start" });
    assert.equal(provider.messages.filter((message: SidebarMessage) => message.role === "tool").length, 2);
    await assert.rejects(provider.runRequest("next request", [], [], undefined, undefined, "read-only"));
    assert.deepEqual(
      provider.messages.map((message: SidebarMessage) => message.role),
      ["user", "assistant", "tool", "tool", "assistant", "user"],
    );
    assert.equal(provider.messages.at(-1).content, "next request");
    event({ type: "tool_execution_update", toolCallId: "read", partialResult: "late replacement" });
    assert.equal(provider.messages[2].tool.output, "late replacement");
    assert.equal(
      provider.messages.at(-1).content,
      "next request",
      "updates do not move a past tool after the new request",
    );
    await provider.persistMessages();
    assert.doesNotMatch(JSON.stringify(fixture.persisted), /first\.ts|second result|late replacement|"role":"tool"/);
  } finally {
    fixture.dispose();
  }
});

test("live tool payloads retain only the newest thirty and use the existing input and output bounds", () => {
  const fixture = sidebarFixture();
  try {
    for (let index = 0; index < 35; index += 1) {
      fixture.event({
        type: "tool_execution_start",
        toolCallId: String(index),
        toolName: "read",
        args: "x".repeat(9000),
      });
      fixture.event({ type: "tool_execution_end", toolCallId: String(index), result: "y".repeat(9000) });
    }
    // The shared character budget can retain fewer than thirty full payloads.
    const messages = fixture.provider.messages as SidebarMessage[];
    assert.ok(messages.length <= 30);
    assert.equal(messages.at(-1)?.id, "tool-34");
    assert.equal(messages.at(-1)?.tool?.input.length, 8000);
    assert.equal(messages.at(-1)?.tool?.output?.length, 8000);
    assert.ok(retainedCharacters(messages) <= 250_000);
    fixture.provider.clearToolMessages();
    for (let index = 0; index < 35; index += 1)
      fixture.event({ type: "tool_execution_start", toolCallId: String(index), toolName: "read", args: {} });
    assert.equal(fixture.provider.messages.length, 30);
    assert.equal(fixture.provider.messages[0].id, "tool-5");
    fixture.event({ type: "tool_execution_end", toolCallId: "0", result: "must not return" });
    assert.equal(fixture.provider.messages.length, 30);
    assert.equal(fixture.provider.tools.length, 30);
  } finally {
    fixture.dispose();
  }
});

test("session and resource resets clear tools while same-session disconnect keeps the transcript", () => {
  const fixture = sidebarFixture();
  const start = () =>
    fixture.event({ type: "tool_execution_start", toolCallId: "private", toolName: "read", args: "private arguments" });
  const assertCleared = () => {
    assert.equal(
      fixture.provider.messages.some((message: SidebarMessage) => message.role === "tool"),
      false,
    );
    assert.deepEqual(fixture.provider.tools, []);
    fixture.event({ type: "tool_execution_end", toolCallId: "private", result: "stale result" });
    assert.doesNotMatch(JSON.stringify(fixture.provider.messages), /private arguments|stale result/);
  };
  try {
    start();
    fixture.runtime.currentState.sessionId = "two";
    fixture.stateChanged();
    assertCleared();
    for (const event of [
      { type: "resources_reloaded", action: "reload" },
      { type: "resources_reloaded", action: "restart" },
    ]) {
      start();
      fixture.event(event);
      assertCleared();
    }
    start();
    fixture.event({ type: "tool_execution_end", toolCallId: "private", result: "completed output" });
    fixture.event({ type: "extension_ui_reset" });
    fixture.event({ type: "process_exit" });
    assert.equal(fixture.provider.messages[0].tool.output, "completed output");
    assert.equal(fixture.provider.messages[0].tool.status, "success");
  } finally {
    fixture.dispose();
  }
});

test("tool roles and injected tool payloads never enter or return from workspace transcript storage", () => {
  const messages: SidebarMessage[] = [
    { id: "user", role: "user", content: "request" },
    toolMessage("private", "secret arguments", "secret result"),
    { id: "assistant", role: "assistant", content: "answer", tool: toolMessage("injected").tool },
  ];
  const persisted = persistableSidebarMessages(messages);
  assert.deepEqual(
    persisted.map((message) => message.role),
    ["user", "assistant"],
  );
  assert.doesNotMatch(JSON.stringify(persisted), /secret|injected|"tool"/);
  const restored = restoreSidebarMessages(messages, 100, 250_000);
  assert.deepEqual(restored, [
    { id: "user", role: "user", content: "request" },
    { id: "assistant", role: "assistant", content: "answer" },
  ]);
});

test("message retention accounts for tool arguments and results in the shared character and message bounds", () => {
  const messages: SidebarMessage[] = [
    { id: "old", role: "assistant", content: "old", thinking: [{ contentIndex: 0, text: "thought" }] },
    toolMessage("a", "12345", "abcdef"),
    { id: "new", role: "assistant", content: "new" },
  ];
  const bounded = limitSidebarMessages(messages, 100, 10);
  assert.deepEqual(
    bounded.map((message) => message.id),
    ["tool-a", "new"],
  );
  assert.equal(bounded[0]?.tool?.input, "12345");
  assert.equal(bounded[0]?.tool?.output, "ef");
  assert.equal(bounded[0]?.truncated, true);
  assert.equal(retainedCharacters(bounded), 10);
  assert.equal(limitSidebarMessages(messages, 1, 100).length, 1);
  const noOutputBudget = limitSidebarMessages([toolMessage("a", "12345", "abcdef")], 100, 5);
  assert.equal(noOutputBudget[0]?.tool?.output, "", "zero remaining budget must not keep slice(-0)");
  assert.equal(
    limitSidebarMessages(
      Array.from({ length: 40 }, (_, index) => toolMessage(String(index))),
      100,
      10000,
    ).length,
    30,
  );
});

test("history reconstructs chronological tools from assistant calls and correlated results without opaque metadata", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    let window: ConversationHistoryWindow | undefined;
    const messages = convertPiMessages(
      [
        { role: "user", content: "request", timestamp: 1 },
        {
          role: "assistant",
          timestamp: 2,
          content: [
            { type: "thinking", thinking: "plan", thinkingSignature: "opaque-thinking" },
            { type: "text", text: "Inspecting", textSignature: "opaque-text" },
            {
              type: "toolCall",
              id: "a",
              name: "read",
              arguments: { path: "file.ts" },
              thoughtSignature: "opaque-tool",
            },
            { type: "toolCall", id: "b", name: "bash", arguments: { command: "pwd" } },
          ],
        },
        {
          role: "toolResult",
          toolCallId: "b",
          toolName: "bash",
          isError: true,
          content: [{ type: "text", text: "failed" }],
        },
        { role: "toolResult", toolCallId: "unrelated", content: [{ type: "text", text: "do not attach" }] },
        { role: "toolResult", toolCallId: "a", toolName: "read", content: [{ type: "text", text: "file contents" }] },
        { role: "assistant", timestamp: 3, content: [{ type: "text", text: "Done" }] },
        { role: "user", content: "next", timestamp: 4 },
      ],
      {
        imageAssets: imageCache(),
        maxMessages: 100,
        onHistoryWindow: (value) => {
          window = value;
        },
      },
    );
    assert.equal(window?.total, 6, "history counts include the inline tool entries");
    assert.equal(window?.truncated, false);
    assert.deepEqual(
      messages.map((message) => message.role),
      ["user", "assistant", "tool", "tool", "assistant", "user"],
    );
    assert.equal(messages[2]?.id, "tool-a");
    assert.equal(messages[2]?.tool?.summary, "file.ts");
    assert.equal(messages[2]?.tool?.output, "file contents");
    assert.equal(messages[3]?.tool?.status, "error");
    assert.equal(messages[3]?.tool?.output, "failed");
    assert.doesNotMatch(JSON.stringify(messages), /opaque|Signature|do not attach/);
    const toolOnly = convertPiMessages(
      [
        {
          role: "assistant",
          content: [{ type: "toolCall", id: "only", name: "codemode", arguments: { code: "return 1;" } }],
        },
        {
          role: "toolResult",
          toolCallId: "only",
          content: [{ type: "text", text: JSON.stringify({ content: [{ type: "text", text: "decoded" }] }) }],
        },
      ],
      { imageAssets: imageCache() },
    );
    assert.equal(toolOnly.length, 1);
    assert.equal(toolOnly[0]?.tool?.output, "decoded");
    const outOfOrder = convertPiMessages(
      [
        { role: "toolResult", toolCallId: "later", content: [{ type: "text", text: "before call" }] },
        { role: "assistant", content: [{ type: "toolCall", id: "later", name: "read", arguments: {} }] },
      ],
      { imageAssets: imageCache() },
    );
    assert.equal(outOfOrder[0]?.tool?.status, "running");
    assert.equal(outOfOrder[0]?.tool?.output, undefined, "a result cannot populate a later call");
  } finally {
    vscode.restore();
  }
});

test("history tools obey payload, shared budget, retention and source-window boundaries", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const history: unknown[] = [];
    for (let index = 0; index < 40; index += 1) {
      history.push({
        role: "assistant",
        timestamp: index,
        content: [{ type: "toolCall", id: String(index), name: "read", arguments: { path: "x".repeat(9000) } }],
      });
      history.push({
        role: "toolResult",
        toolCallId: String(index),
        content: [{ type: "text", text: "y".repeat(9000) }],
      });
    }
    let window: ConversationHistoryWindow | undefined;
    const retained = convertPiMessages(history, {
      imageAssets: imageCache(),
      maxMessages: 100,
      maxCharacters: 1_000_000,
      onHistoryWindow: (value) => {
        window = value;
      },
    });
    assert.equal(retained.length, 30);
    assert.equal(retained[0]?.id, "tool-10");
    assert.equal(retained.at(-1)?.tool?.input.length, 8000);
    assert.equal(retained.at(-1)?.tool?.output?.length, 8000);
    assert.equal(window?.truncated, true);
    assert.equal(window?.total, 40);
    assert.equal(window?.omittedBefore, 10);
    const bounded = convertPiMessages(history, { imageAssets: imageCache(), maxMessages: 100, maxCharacters: 10000 });
    assert.equal(retainedCharacters(bounded), 10000);
    assert.equal(bounded.at(-1)?.tool?.output?.length, 2000);
    assert.equal(bounded.at(-1)?.truncated, true);
    const earlier = convertPiMessages(history, { imageAssets: imageCache(), maxMessages: 2, historyBefore: 3 });
    assert.deepEqual(
      earlier.map((message) => message.id),
      ["tool-0", "tool-1"],
    );
    assert.equal(earlier[0]?.tool?.status, "success");
    assert.equal(earlier[1]?.tool?.status, "running");
    assert.equal(earlier[1]?.tool?.output, undefined, "a later result must not populate an earlier window");
    const latest = convertPiMessages(history, { imageAssets: imageCache(), maxMessages: 2 });
    assert.deepEqual(
      latest.map((message) => message.id),
      ["tool-38", "tool-39"],
    );
    assert.deepEqual(convertPiMessages(history, { imageAssets: imageCache(), maxMessages: 0 }), []);
  } finally {
    vscode.restore();
  }
});

function retainedCharacters(messages: readonly SidebarMessage[]): number {
  return messages.reduce(
    (sum, message) =>
      sum +
      message.content.length +
      (message.thinking?.reduce((count, block) => count + block.text.length, 0) ?? 0) +
      (message.tool?.input.length ?? 0) +
      (message.tool?.output?.length ?? 0),
    0,
  );
}
