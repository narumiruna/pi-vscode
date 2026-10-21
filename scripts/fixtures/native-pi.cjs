#!/usr/bin/env node
// Deterministic RPC subprocess for native UI tests. Never invokes a provider.
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
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
// Test-only inbound UI events; never uses a provider or the production bridge.
setInterval(() => {
  const file = path.join(directory, "extension-dialog.json");
  if (!fs.existsSync(file)) return;
  const event = JSON.parse(fs.readFileSync(file, "utf8"));
  fs.unlinkSync(file);
  if (event.type === "fixture_exit") process.exit(0);
  if (event.type === "fixture_invalid_json" && fs.existsSync(path.join(directory, "output-diagnostics-only"))) {
    // Exercise the real RPC parser and private stderr buffer, not a synthetic host notice.
    if (typeof event.text !== "string" || event.text.includes("\n")) throw new Error("Invalid diagnostic fixture input");
    process.stderr.write(`${event.text}\n`);
    process.stdout.write(`not-json ${event.text}\n`);
    return;
  }
  emit(event);
}, 50).unref();
// Exercise the real authenticated bridge from the actual foreground child. Private
// credentials and origins stay in this process; file IPC returns metadata only.
if (fs.existsSync(path.join(directory, "annotations-only"))) {
  const net = require("node:net");
  let retainedOrigin;
  let currentOrigin;
  let busy = false;
  const bridge = (method, params) => new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port: Number(process.env.PI_VSCODE_BRIDGE_PORT) });
    let input = "";
    const fail = () => { socket.destroy(); reject(new Error("Annotation fixture bridge transport failed")); };
    socket.setTimeout(5000, fail);
    socket.on("error", fail);
    socket.on("connect", () => socket.write(JSON.stringify({
      id: "native-annotation", token: process.env.PI_VSCODE_BRIDGE_TOKEN, method, params,
    }) + "\n"));
    socket.on("data", (chunk) => {
      input += chunk;
      if (input.length > 16384) return fail();
      const end = input.indexOf("\n");
      if (end < 0) return;
      socket.destroy();
      try { resolve(JSON.parse(input.slice(0, end))); } catch { reject(new Error("Invalid annotation fixture response")); }
    });
    socket.on("end", () => { if (!input.includes("\n")) fail(); });
  });
  setInterval(async () => {
    const file = path.join(directory, "annotation-request.json");
    if (busy || !fs.existsSync(file)) return;
    busy = true;
    const request = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.unlinkSync(file);
    let result;
    try {
      if (request.action === "remember") {
        retainedOrigin = currentOrigin;
        result = { ok: true, remembered: typeof retainedOrigin === "string" };
      } else {
        let origin = retainedOrigin;
        if (request.action !== "stale") {
          const params = {
            credential: process.env.PI_VSCODE_ANNOTATION_TOKEN,
            sessionId,
            cwd: fs.realpathSync(process.cwd()),
          };
          if (request.reject === "terminal") delete params.credential;
          if (request.reject === "credential") params.credential = "0".repeat(64);
          if (request.reject === "session") params.sessionId = "forged-native-session";
          if (request.reject === "cwd") params.cwd = directory;
          const response = await bridge("annotationOrigin", params);
          if (!response.ok) result = { ok: false, stage: "origin" };
          else {
            if (!/^[a-f0-9]{64}$/.test(response.result?.origin)) throw new Error("Invalid origin metadata");
            origin = response.result.origin;
            currentOrigin = origin;
          }
        }
        if (!result) {
          const response = await bridge("annotate", {
            origin, path: path.resolve(process.cwd(), request.path), annotations: request.annotations,
          });
          result = response.ok
            ? { ok: true, count: response.result.count, visible: response.result.visible }
            : { ok: false, stage: "annotate" };
        }
      }
    } catch {
      result = { ok: false, stage: "fixture" };
    }
    fs.writeFileSync(path.join(directory, "annotation-result.tmp"), JSON.stringify({ id: request.id, ...result }));
    fs.renameSync(path.join(directory, "annotation-result.tmp"), path.join(directory, "annotation-result.json"));
    busy = false;
  }, 50).unref();
}
const onLine = (line) => {
  const request = JSON.parse(line);
  if (request.type === "bash") {
    if (request.command !== "printf pi-shell-fixture") {
      emit({ type: "response", id: request.id, command: "bash", success: false, error: "Only the harmless native shell fixture is supported" });
      return;
    }
    fs.appendFileSync(path.join(directory, "shell.jsonl"), `${JSON.stringify(request)}\n`);
    const result = { output: "pi-shell-fixture\n<img src=x>\n", exitCode: 0, cancelled: false, truncated: false };
    emit({ type: "bash_execution_update", id: "stale-shell-command", delta: "DO_NOT_RENDER" });
    emit({ type: "bash_execution_update", id: request.id, delta: result.output });
    append({ role: "bashExecution", command: request.command, excludeFromContext: request.excludeFromContext, timestamp: Date.now(), ...result });
    emit({ type: "response", id: request.id, command: "bash", success: true, data: result });
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
  if (request.type === "get_messages") {
    const historyOverride = path.join(directory, "history.json");
    data = { messages: fs.existsSync(historyOverride) ? JSON.parse(fs.readFileSync(historyOverride, "utf8")) : messages };
  }
  if (request.type === "get_session_stats") data = { contextUsage: { percent: 12 } };
  if (request.type === "get_available_models") data = { models: [] };
  if (request.type === "get_available_thinking_levels") data = { levels: [] };
  if (request.type === "get_commands") data = { commands: extensionPaths.flatMap((resource) => {
    const name = markerNames[path.basename(resource)];
    const descriptions = { "pi-read-only-gate.ts": "VS Code read-only direct-shell policy v1; Pi 1.3.0" };
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
    emit({ type: "agent_start" });
    emit({ type: "message_end", message: user });
    const toolsFile = path.join(directory, "tools.json");
    const calls = fs.existsSync(toolsFile) ? JSON.parse(fs.readFileSync(toolsFile, "utf8")) : [];
    if (calls.length) {
      fs.unlinkSync(toolsFile);
      const toolTurn = {
        role: "assistant",
        content: calls.map(([name, args], index) => ({
          type: "toolCall", id: `native-tool-${index}`, name, arguments: args,
        })),
        stopReason: "toolUse",
        timestamp: Date.now(),
      };
      append(toolTurn);
      emit({ type: "message_start", message: { role: "assistant", content: [], timestamp: toolTurn.timestamp } });
      emit({ type: "message_end", message: toolTurn });
    }
    const recordResult = (index) => {
      const [toolName, , result, isError] = calls[index];
      const message = {
        role: "toolResult", toolCallId: `native-tool-${index}`, toolName,
        content: result.content ?? [{ type: "text", text: JSON.stringify(result) }],
        isError: !!isError, timestamp: Date.now(),
      };
      append(message);
      emit({ type: "message_end", message });
    };
    calls.forEach(([toolName, args, result, isError], index) => {
      const toolCallId = `native-tool-${index}`;
      emit({ type: "tool_execution_start", toolName, args, toolCallId });
      emit({ type: "tool_execution_update", toolCallId, partialResult: result });
      if (index < calls.length - 1) {
        emit({ type: "tool_execution_end", toolCallId, result, isError: !!isError });
        recordResult(index);
      }
    });
    if (calls.length) {
      emit({ type: "message_start", message: { role: "assistant", content: [] } });
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text } });
    }
    append(assistant);
    emit({ type: "message_end", message: assistant });
    const finish = () => {
      if (calls.length) {
        emit({
          type: "tool_execution_end",
          toolCallId: `native-tool-${calls.length - 1}`,
          result: calls.at(-1)[2],
          isError: !!calls.at(-1)[3],
        });
        recordResult(calls.length - 1);
      }
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
