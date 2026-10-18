import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SidebarAssistantStream } from "../sidebarAssistantStream";
import type { SidebarMessage } from "../sidebarState";
import { installVscodeMock, MockUri } from "./vscodeMock";

const fixture = require("../../scripts/fixtures/thinking.cjs");

test("native subprocess fixture emits indexed thinking, thinking-only completion and authoritative messages", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-thinking-rpc-"));
  try {
    await writeFile(path.join(directory, "response.txt"), "Fixture answer.");
    await writeFile(path.join(directory, "thinking.json"), JSON.stringify(fixture));
    await writeFile(path.join(directory, "thinking-release"), "settle");
    const result = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/fixtures/native-pi.cjs")], {
      cwd: directory,
      env: { ...process.env, PI_VSCODE_UI_FIXTURE: directory },
      input: `${JSON.stringify({ type: "prompt", id: "prompt", message: "fixture" })}\n`,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(result.status, 0, result.stderr);
    const events = result.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.deepEqual(
      events.filter((event) => event.type === "message_update").map((event) => event.assistantMessageEvent),
      fixture.updates,
    );
    const completed = events.filter((event) => event.type === "message_end" && event.message.role === "assistant");
    assert.equal(completed.length, 2);
    assert.deepEqual(completed[0].message.content, fixture.content);
    assert.deepEqual(completed[1].message.content, [{ type: "thinking", thinking: "Thinking-only response." }]);
    assert.equal(events.at(-1).type, "agent_settled");
    const restored = spawnSync(process.execPath, [path.resolve(__dirname, "../../scripts/fixtures/native-pi.cjs")], {
      cwd: directory,
      env: { ...process.env, PI_VSCODE_UI_FIXTURE: directory },
      input: `${JSON.stringify({ type: "get_messages", id: "history" })}\n`,
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(restored.status, 0, restored.stderr);
    const history = JSON.parse(restored.stdout.trim()).data.messages;
    assert.deepEqual(
      history.filter((message: { role: string }) => message.role === "assistant"),
      completed.map((event) => event.message),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("indexed thinking and answer streams replace partial blocks and completed message content", () => {
  const stream = new SidebarAssistantStream("assistant", 250_000);
  let message: SidebarMessage | undefined;
  for (const update of fixture.updates)
    message = stream.update({ ...update, partial: { thinkingSignature: "secret" } });
  assert.equal(message?.content, "Fixture answer.");
  assert.equal(message?.thinking?.[0]?.text, "Authoritative visible thinking.");
  assert.equal(message?.thinking?.[1]?.contentIndex, 3);
  const final = stream.complete(fixture.content);
  assert.equal(final.thinking?.length, 3);
  assert.equal(final.thinking?.[1]?.redacted, true);
  assert.doesNotMatch(JSON.stringify(final), /SIGNATURE|MUST_NOT_LEAK|Partial|partial/);
  assert.equal(stream.complete([{ type: "toolCall", name: "read" }]).thinking, undefined);
});

test("stream validation bounds malformed, oversized, control and repeated block updates", () => {
  const stream = new SidebarAssistantStream("bounded", 20);
  for (const value of [
    null,
    {},
    { type: "thinking_delta", contentIndex: -1, delta: "bad" },
    { type: "thinking_delta", contentIndex: 0.5, delta: "bad" },
    { type: "thinking_delta", contentIndex: 0, delta: 1 },
  ]) {
    assert.equal(stream.update(value), undefined);
  }
  stream.update({ type: "thinking_delta", contentIndex: 5, delta: "abc\u0000\u202e\n" });
  assert.equal(stream.update({ type: "thinking_start", contentIndex: 5 })?.thinking?.[0]?.text, "abc\n");
  assert.equal(stream.update({ type: "text_delta", contentIndex: 5, delta: "wrong block" }), undefined);
  let message = stream.update({ type: "thinking_delta", contentIndex: 5, delta: "x".repeat(300_000) });
  assert.equal(message?.thinking?.[0]?.text.length, 20);
  assert.equal(message?.thinking?.[0]?.truncated, true);
  message = stream.update({ type: "thinking_end", contentIndex: 5, content: "replacement" });
  assert.equal(message?.thinking?.[0]?.text, "replacement");
  assert.equal(message?.thinking?.[0]?.truncated, undefined);
  const many = new SidebarAssistantStream("many", 1000);
  for (let contentIndex = 0; contentIndex < 200; contentIndex += 1) {
    message = many.update({ type: "thinking_start", contentIndex });
  }
  assert.equal(message?.thinking?.length, 128);
  assert.equal(message?.truncated, true);
});

test("sidebar binds thinking to one assistant across tools, retries, abort, history and session changes", async () => {
  const vscode = installVscodeMock();
  vscode.window.registerWebviewViewProvider = () => ({ dispose() {} });
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  let stateChanged: () => void = () => {};
  const runtime: any = {
    currentState: { connected: true, sessionId: "one" },
    currentCwd: process.cwd(),
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: (listener: () => void) => {
      stateChanged = listener;
      return { dispose() {} };
    },
    getMessages: async () => [{ role: "assistant", content: fixture.content, timestamp: 1 }],
  };
  const persisted: unknown[] = [];
  const context: any = {
    workspaceState: { get: () => undefined, update: async (_key: string, value: unknown) => persisted.push(value) },
    extensionUri: MockUri.file("/extension"),
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  const event = (value: unknown) => provider.handleRuntimeEvent(value);
  const start = (timestamp?: number) =>
    event({ type: "message_start", message: { role: "assistant", content: [], timestamp } });
  const delta = (text: string) =>
    event({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: text } });
  try {
    stateChanged();
    start(1);
    for (const update of fixture.updates) event({ type: "message_update", assistantMessageEvent: update });
    assert.equal(provider.messages.length, 1);
    event({ type: "message_end", message: { role: "toolResult", content: [] } });
    event({ type: "message_end", message: { role: "assistant", content: fixture.content } });
    assert.equal(provider.messages.length, 1);
    assert.equal(provider.messages[0].thinking.length, 3);
    const firstId = provider.messages[0].id;
    start();
    event({ type: "message_end", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } });
    assert.equal(provider.messages.length, 1, "tool-only turns do not reuse earlier thinking");
    start();
    delta("interrupted");
    event({ type: "auto_retry_start" });
    delta("late retry delta");
    assert.equal(provider.messages.at(-1).thinking[0].text, "interrupted");
    start();
    delta("retry thinking");
    event({
      type: "message_end",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "aborted final" }], stopReason: "aborted" },
    });
    event({ type: "agent_settled", aborted: true });
    delta("late abort delta");
    assert.equal(provider.messages.at(-1).thinking[0].text, "aborted final");
    await provider.syncMessagesFromPi();
    assert.equal(provider.messages.length, 1, "history replaces all partial presentation");
    assert.equal(provider.messages[0].thinking.length, 3);
    assert.equal(
      provider.messages[0].id,
      firstId,
      "public timestamps keep disclosure identity through history replacement",
    );
    start(1);
    delta("same timestamp, separate message");
    assert.notEqual(provider.messages.at(-1).id, firstId);
    event({ type: "message_end", message: { role: "assistant", content: [] } });
    assert.equal(provider.messages.length, 1, "an empty authoritative message removes its partial thinking");
    assert.doesNotMatch(JSON.stringify(persisted), /thinking|SIGNATURE|MUST_NOT_LEAK/);
    start();
    delta("old session partial");
    runtime.currentState.sessionId = "two";
    stateChanged();
    delta("must be ignored");
    assert.equal(provider.messages.length, 1, "session change clears the incomplete message immediately");
    start();
    delta("new session");
    event({ type: "process_exit" });
    delta("late exit delta");
    assert.equal(provider.messages.at(-1).thinking[0].text, "new session");
    assert.doesNotMatch(JSON.stringify(provider.messages), /SIGNATURE|MUST_NOT_LEAK|old session|must be ignored/);
    let completeHistory: (messages: unknown[]) => void = () => {};
    runtime.getMessages = () =>
      new Promise<unknown[]>((resolve) => {
        completeHistory = resolve;
      });
    const staleHistory = provider.syncMessagesFromPi();
    runtime.currentState.sessionId = "three";
    stateChanged();
    start();
    delta("current session partial");
    completeHistory([{ role: "assistant", content: [{ type: "thinking", thinking: "stale history" }] }]);
    await staleHistory;
    assert.equal(provider.messages.at(-1).thinking[0].text, "current session partial");
    assert.doesNotMatch(JSON.stringify(provider.messages), /stale history/);
  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
    vscode.restore();
  }
});
