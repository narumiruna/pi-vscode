#!/usr/bin/env node
// Deterministic RPC subprocess for native UI tests. Never invokes a provider or tool.
if (process.argv.some((value) => value.endsWith("pi-isolated-helper.ts"))) {
  // The native runner embeds an absolute test-module URL in its disposable copy.
  void import("../../src/test/fixtures/isolated-pi-fixture.mjs");
  return;
}
const fs = require("node:fs");
const path = require("node:path");
const directory = process.env.PI_VSCODE_UI_FIXTURE;
if (!directory) throw new Error("An isolated native UI fixture is required");
const sessionArgument = process.argv.indexOf("--session");
let sessionFile = sessionArgument >= 0 ? process.argv[sessionArgument + 1] : path.join(directory, "session.jsonl");
let sessionId = fs.existsSync(sessionFile) ? JSON.parse(fs.readFileSync(sessionFile, "utf8").split("\n")[0]).id : "native-ui-session";
if (!fs.existsSync(sessionFile)) fs.writeFileSync(
  sessionFile,
  `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: process.cwd(), timestamp: new Date().toISOString() })}\n`,
);
fs.appendFileSync(path.join(directory, "pids.jsonl"), `${process.pid}\n`);
const sessionDir = path.join(directory, "configured-sessions");
fs.mkdirSync(sessionDir, { recursive: true });
let entries = [];
let messages = [];
let leafId = null;
const branch = (leaf = leafId) => {
  const result = [];
  while (leaf !== null) {
    const entry = entries.find((item) => item.id === leaf);
    if (!entry) throw new Error("Unknown fixture branch entry");
    result.unshift(entry);
    leaf = entry.parentId;
  }
  return result;
};
const refresh = () => { messages = branch().filter((entry) => entry.type === "message").map((entry) => entry.message); };
const load = () => {
  const [header, ...saved] = fs.readFileSync(sessionFile, "utf8").trimEnd().split("\n").map(JSON.parse);
  sessionId = header.id;
  entries = saved;
  leafId = entries.at(-1)?.id ?? null;
  refresh();
};
const persist = () => fs.writeFileSync(sessionFile, [
  { type: "session", version: 3, id: sessionId, cwd: fs.realpathSync(process.cwd()), timestamp: new Date().toISOString() },
  ...entries,
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
const append = (message) => {
  if (message.role === "assistant") Object.assign(message, {
    api: "fixture", provider: "fixture", model: "fixture",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  });
  const id = `${message.role}-${require("node:crypto").randomUUID()}`;
  entries.push({ type: "message", id, parentId: leafId, timestamp: new Date().toISOString(), message });
  leafId = id;
  refresh();
  persist();
};
load();
const extensionPaths = process.argv.flatMap((argument, index) => argument === "--extension" ? [process.argv[index + 1]] : []);
const markerNames = {
  "pi-control.ts": "vscode-pi-control",
  "pi-bridge.ts": "vscode-pi-bridge-ready",
  "pi-permission-gate.ts": "vscode-pi-permission-ready",
  "pi-read-only-gate.ts": "vscode-pi-read-only-ready",
};
const tree = () => {
  const nodes = new Map(entries.map((entry) => [entry.id, { entry, children: [] }]));
  const roots = [];
  for (const node of nodes.values()) {
    const parent = nodes.get(node.entry.parentId);
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
};
let queue = { steering: [], followUp: [] };
let heldTimer;
let pendingShell;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Test-only inbound UI events; never uses a provider or the production bridge.
setInterval(() => {
  const file = path.join(directory, "extension-dialog.json");
  if (!fs.existsSync(file)) return;
  const event = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  if (event.type === "fixture_exit") process.exit(0);
  emit(event);
}, 50).unref();
const onLine = (line) => {
  const request = JSON.parse(line);
  if (request.type === "bash") {
    if (request.command !== "printf pi-shell-fixture") {
      emit({ type: "response", id: request.id, command: "bash", success: false, error: "Only the harmless native shell fixture is supported" });
      return;
    }
    pendingShell = request;
    emit({ type: "extension_ui_request", id: "native-shell-policy", method: "confirm", title: "PI_VSCODE_DIRECT_SHELL_V1", message: JSON.stringify({ command: request.command, cwd: fs.realpathSync(process.cwd()), excludeFromContext: request.excludeFromContext, sessionId }) });
    return;
  }
  if (request.type === "extension_ui_response" && request.id === "native-shell-policy") {
    const shell = pendingShell;
    pendingShell = undefined;
    if (!shell) return;
    if (!request.confirmed) {
      emit({ type: "response", id: shell.id, command: "bash", success: false, error: "Native shell policy rejected" });
      return;
    }
    fs.appendFileSync(path.join(directory, "shell.jsonl"), `${JSON.stringify(shell)}\n`);
    const result = { output: "pi-shell-fixture\n<img src=x>\n", exitCode: 0, cancelled: false, truncated: false };
    emit({ type: "bash_execution_update", id: "stale-shell-command", delta: "DO_NOT_RENDER" });
    emit({ type: "bash_execution_update", id: shell.id, delta: result.output });
    append({ role: "bashExecution", command: shell.command, excludeFromContext: shell.excludeFromContext, timestamp: Date.now(), ...result });
    emit({ type: "response", id: shell.id, command: "bash", success: true, data: result });
    return;
  }
  if (request.type === "extension_ui_response") {
    fs.appendFileSync(path.join(directory, "extension-dialog-responses.jsonl"), `${JSON.stringify(request)}\n`);
    return;
  }
  let data = {};
  if (request.type === "prompt" && request.message.startsWith("/vscode-pi-control ")) {
    const payload = JSON.parse(request.message.slice(request.message.indexOf(" ") + 1));
    if (payload.sessionId !== sessionId || (payload.leafId !== undefined && payload.leafId !== leafId) || payload.cwd !== fs.realpathSync(process.cwd())) throw new Error("Stale native control fixture");
    if (payload.action === "session-location") {
      const hash = require("node:crypto").createHash("sha256");
      for (const entry of entries) hash.update(JSON.stringify(entry)).update("\n");
      emit({ type: "extension_ui_request", id: "location-result", method: "notify", message: `PI_VSCODE_CONTROL_RESULT:${JSON.stringify({ token: payload.token, sessionId, sessionFile: fs.realpathSync(sessionFile), sessionDir: fs.realpathSync(sessionDir), leafId, entriesHash: hash.digest("hex") })}` });
    } else if (payload.action === "navigate") {
      const target = entries.find((entry) => entry.id === payload.targetId);
      if (!target) throw new Error("Unknown native entry");
      leafId = target.message?.role === "user" ? target.parentId : target.id;
      refresh();
      emit({ type: "extension_ui_request", id: "control-result", method: "notify", message: `PI_VSCODE_CONTROL_RESULT:${JSON.stringify({ token: payload.token, cancelled: false })}` });
    } else if (payload.action !== "reload") throw new Error("Unsupported fixture control");
    fs.appendFileSync(path.join(directory, "controls.jsonl"), `${JSON.stringify(payload)}\n`);
    emit({ type: "response", id: request.id, command: request.type, success: true, data: { disposition: "handled" } });
    return;
  }
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
  if (request.type === "get_commands") data = { commands: extensionPaths.flatMap((resource) => {
    const name = markerNames[path.basename(resource)];
    const descriptions = { "pi-permission-gate.ts": "VS Code direct-shell policy; Pi 1.3.0", "pi-read-only-gate.ts": "VS Code read-only direct-shell policy v1" };
    return name ? [{ name, description: descriptions[path.basename(resource)], source: "extension", sourceInfo: { path: resource } }] : [];
  }) };
  if (request.type === "get_tree") data = { tree: tree(), leafId };
  if (request.type === "get_fork_messages") data = { messages: entries.filter((entry) => entry.message?.role === "user").map((entry) => ({ entryId: entry.id, text: entry.message.content[0].text })) };
  if (request.type === "switch_session") {
    sessionFile = request.sessionPath;
    load();
    data = { cancelled: false };
    fs.appendFileSync(path.join(directory, "switches.jsonl"), `${JSON.stringify({ sessionFile, sessionId })}\n`);
  }
  if (request.type === "export_html") {
    fs.writeFileSync(request.outputPath, `<html><body>${JSON.stringify(entries).replaceAll("<", "&lt;")}</body></html>`);
    data = { path: request.outputPath };
  }
  if (request.type === "fork" || request.type === "clone") {
    const selected = entries.find((entry) => entry.id === request.entryId);
    if (request.type === "fork" && !selected) throw new Error("Unknown fork entry");
    entries = branch(request.type === "fork" ? selected.parentId : leafId);
    leafId = entries.at(-1)?.id ?? null;
    sessionId = `native-branch-${Date.now()}`;
    sessionFile = path.join(sessionDir, `${sessionId}.jsonl`);
    refresh();
    persist();
    data = { cancelled: false, ...(selected ? { text: selected.message.content[0].text } : {}) };
  }
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
    const uiFile = path.join(directory, "extension-ui.json");
    if (fs.existsSync(uiFile)) {
      JSON.parse(fs.readFileSync(uiFile, "utf8")).forEach((event, index) => {
        emit({ type: "extension_ui_request", id: `fixture-ui-${index}`, ...event });
      });
    }
    fs.appendFileSync(path.join(directory, "prompts.jsonl"), `${JSON.stringify(request)}\n`);
    const text = fs.readFileSync(path.join(directory, "response.txt"), "utf8");
    const imageFile = path.join(directory, "interface-images.json");
    const images = fs.existsSync(imageFile) ? JSON.parse(fs.readFileSync(imageFile, "utf8")) : [];
    if (images.length) fs.unlinkSync(imageFile);
    const user = { role: "user", content: [{ type: "text", text: request.message }, ...images], timestamp: Date.now() };
    const thinkingFile = path.join(directory, "thinking.json");
    if (fs.existsSync(thinkingFile)) {
      const thinking = JSON.parse(fs.readFileSync(thinkingFile, "utf8"));
      fs.unlinkSync(thinkingFile);
      const assistant = { role: "assistant", content: thinking.content, stopReason: "stop", timestamp: Date.now() };
      const thinkingOnly = {
        role: "assistant",
        content: [{ type: "thinking", thinking: "Thinking-only response." }],
        stopReason: "stop",
        timestamp: Date.now() + 1,
      };
      append(user);
      emit({ type: "agent_start" });
      emit({ type: "message_end", message: user });
      emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: assistant.timestamp } });
      for (const update of thinking.updates) emit({ type: "message_update", assistantMessageEvent: update });
      heldTimer = setInterval(() => {
        if (!fs.existsSync(path.join(directory, "thinking-release"))) return;
        clearInterval(heldTimer);
        append(assistant);
        append(thinkingOnly);
        emit({ type: "message_end", message: assistant });
        emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: thinkingOnly.timestamp } });
        emit({ type: "message_end", message: thinkingOnly });
        emit({ type: "agent_end", messages });
        emit({ type: "agent_settled" });
      }, 50);
      return;
    }
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
      timestamp: Date.now(),
    };
    append(user);
    append(assistant);
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
    if (calls.length) {
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    }
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
};
// Match the public strict-JSONL framing: Unicode LS/PS are valid string content, not records.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
  let newline;
  while ((newline = input.indexOf("\n")) >= 0) {
    const line = input.slice(0, newline).replace(/\r$/, "");
    input = input.slice(newline + 1);
    if (line) onLine(line);
  }
});
