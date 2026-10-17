#!/usr/bin/env node
// Deterministic RPC subprocess for native UI tests. Never invokes a provider or tool.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const directory = process.env.PI_VSCODE_UI_FIXTURE;
if (!directory) throw new Error("An isolated native UI fixture is required");
const sessionFile = path.join(directory, "session.jsonl");
const sessionId = "native-ui-session";
fs.writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`,
);
fs.appendFileSync(path.join(directory, "pids.jsonl"), `${process.pid}\n`);
const messages = [];
let queue = { steering: [], followUp: [] };
let heldTimer;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  let data = {};
  if (request.type === "get_state")
    data = {
      sessionFile,
      sessionId,
      isStreaming: false,
      model: { id: "fixture", provider: "fixture", name: "Native UI fixture" },
    };
  if (request.type === "get_messages") data = { messages };
  if (request.type === "get_session_stats") data = { contextUsage: { percent: 12 } };
  if (request.type === "get_available_models") data = { models: [] };
  if (request.type === "get_available_thinking_levels") data = { levels: [] };
  if (request.type === "get_commands") data = { commands: [] };
  if (request.type === "steer" || request.type === "follow_up") {
    queue[request.type === "steer" ? "steering" : "followUp"].push(request.message);
    fs.appendFileSync(path.join(directory, "queued.jsonl"), `${JSON.stringify(request)}\n`);
    emit({ type: "queue_update", ...queue });
  }
  if (request.type === "clear_queue") {
    data = queue;
    queue = { steering: [], followUp: [] };
    emit({ type: "queue_update", ...queue });
  }
  if (request.type === "get_queue") data = queue;
  emit({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "prompt") {
    fs.appendFileSync(path.join(directory, "prompts.jsonl"), `${JSON.stringify(request)}\n`);
    const text = fs.readFileSync(path.join(directory, "response.txt"), "utf8");
    const imageFile = path.join(directory, "interface-images.json");
    const images = fs.existsSync(imageFile) ? JSON.parse(fs.readFileSync(imageFile, "utf8")) : [];
    if (images.length) fs.unlinkSync(imageFile);
    const user = { role: "user", content: [{ type: "text", text: request.message }, ...images], timestamp: Date.now() };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    messages.push(user, assistant);
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: user });
    const toolsFile = path.join(directory, "tools.json");
    const calls = fs.existsSync(toolsFile) ? JSON.parse(fs.readFileSync(toolsFile, "utf8")) : [];
    if (calls.length) fs.unlinkSync(toolsFile);
    calls.forEach(([toolName, args, result, isError], index) => {
      const toolCallId = `native-tool-${index}`;
      emit({ type: "tool_execution_start", toolName, args, toolCallId });
      emit({ type: "tool_execution_update", toolCallId, partialResult: result });
      if (index < calls.length - 1) emit({ type: "tool_execution_end", toolCallId, result, isError: !!isError });
    });
    if (calls.length) emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: text } });
    emit({ type: "message_end", message: assistant });
    const finish = () => {
      if (calls.length)
        emit({
          type: "tool_execution_end",
          toolCallId: `native-tool-${calls.length - 1}`,
          result: calls.at(-1)[2],
          isError: false,
        });
      emit({ type: "agent_end", messages });
      emit({ type: "agent_settled" });
    };
    if (fs.existsSync(path.join(directory, "interface-hold"))) {
      heldTimer = setInterval(() => {
        if (fs.existsSync(path.join(directory, "interface-hold"))) return;
        clearInterval(heldTimer);
        finish();
      }, 50);
    } else if (!calls.length) finish();
    else {
      const timer = setInterval(() => {
        if (!fs.existsSync(path.join(directory, "tools-release"))) return;
        clearInterval(timer);
        finish();
      }, 50);
    }
  }
  if (request.type === "abort") {
    clearInterval(heldTimer);
    emit({ type: "agent_settled" });
  }
});
