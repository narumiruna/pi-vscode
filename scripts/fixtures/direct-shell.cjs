#!/usr/bin/env node
// Isolated shell RPC fixture. Only fixed local Node subprocesses can run.
const { spawn } = require("node:child_process");
const readline = require("node:readline");
const messages = [];
let active;
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const reply = (request, data = {}, success = true, error) => emit({ type: "response", id: request.id, command: request.type, success, data, error });
readline.createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.type === "get_state") return reply(request, { sessionId: "shell-fixture", isStreaming: false });
  if (request.type === "get_messages") return reply(request, { messages });
  if (request.type === "prompt") {
    emit({ type: "fixture_model_context", messages: messages.filter((message) => !message.excludeFromContext) });
    return reply(request, { disposition: "handled" });
  }
  if (request.type === "abort_bash") {
    if (active?.command === "fixture:failed-abort") return reply(request, {}, false, "Fixture abort unavailable");
    if (active?.command === "fixture:unsettled-abort") return reply(request);
    if (active) { active.cancelled = true; active.child.kill("SIGTERM"); }
    return reply(request);
  }
  if (request.type !== "bash") return reply(request);
  const code = {
    "fixture:hello": 'process.stdout.write("\\u001b[31mhello\\u001b[0m\\n"); process.exitCode=7;',
    "fixture:flood": 'process.stdout.write("x".repeat(200000));',
    "fixture:hang": 'process.stdout.write("waiting\\n"); setInterval(()=>{},1000);',
    "fixture:failed-abort": 'process.stdout.write("waiting\\n"); setInterval(()=>{},1000);',
    "fixture:unsettled-abort": 'process.stdout.write("waiting\\n"); setInterval(()=>{},1000);',
  }[request.command];
  if (!code) return reply(request, {}, false, "Unsupported harmless fixture command");
  if (active) return reply(request, {}, false, "Fixture shell already active");
  const child = spawn(process.execPath, ["-e", code], { cwd: process.cwd(), shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const execution = { child, cancelled: false, command: request.command };
  active = execution;
  let output = "";
  // A stale command ID must never enter the current shell's output.
  emit({ type: "bash_execution_update", id: "wrong-origin", delta: "DO_NOT_RENDER" });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    const delta = chunk.toString("utf8");
    output += delta;
    emit({ type: "bash_execution_update", id: request.id, delta });
  });
  child.once("exit", (exitCode) => {
    active = undefined;
    const data = { output, ...(exitCode === null ? {} : { exitCode }), cancelled: execution.cancelled, truncated: false };
    messages.push({ role: "bashExecution", command: request.command, excludeFromContext: request.excludeFromContext, timestamp: Date.now(), ...data });
    reply(request, data);
  });
});
process.on("SIGTERM", () => { active?.child.kill("SIGKILL"); process.exit(0); });
