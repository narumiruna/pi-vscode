#!/usr/bin/env node
// Deterministic RPC subprocess for native UI tests. Never invokes a provider or tool.
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const directory = process.env.PICODE_UI_FIXTURE;
if (!directory) throw new Error("An isolated native UI fixture is required");
const sessionFile = path.join(directory, "session.jsonl");
const sessionId = "native-ui-session";
fs.writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`,
);
fs.appendFileSync(path.join(directory, "pids.jsonl"), `${process.pid}\n`);
let messages = [];
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
  if (request.type === "get_available_models") data = { models: [] };
  if (request.type === "get_available_thinking_levels") data = { levels: [] };
  if (request.type === "get_commands") data = { commands: [] };
  if (request.type === "get_queue") data = { steering: [], followUp: [] };
  emit({ type: "response", id: request.id, command: request.type, success: true, data });
  if (request.type === "prompt") {
    fs.appendFileSync(path.join(directory, "prompts.jsonl"), `${JSON.stringify(request)}\n`);
    const text = fs.readFileSync(path.join(directory, "response.txt"), "utf8");
    const user = { role: "user", content: [{ type: "text", text: request.message }], timestamp: Date.now() };
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    messages.push(user, assistant);
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: user });
    emit({ type: "message_end", message: assistant });
    emit({ type: "agent_end", messages });
    emit({ type: "agent_settled" });
  }
  if (request.type === "abort") emit({ type: "agent_settled" });
});
