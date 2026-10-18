// Local JSONL MCP fixture. No network, credentials, or external dependencies.
import { appendFileSync } from "node:fs";

const [log, mode = "normal"] = process.argv.slice(2);
const record = (event) => appendFileSync(log, `${JSON.stringify({ pid: process.pid, mode, ...event })}\n`);
record({ event: "start" });
process.on("exit", () => record({ event: "exit" }));
process.on("SIGTERM", () => process.exit(0));
process.stdin.on("end", () => process.exit(0));
process.stderr.write(`fixture MCP ${mode}\n`);
const tools = ["echo", "mutate", "get_alpha", "get_exact"].map((name) => ({
  name,
  description: `fixture ${name} deterministic local result`,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  annotations: { readOnlyHint: name !== "mutate", destructiveHint: name === "mutate" },
}));
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (buffer.length > 1024 * 1024) process.exit(2);
  while (buffer.includes("\n")) {
    const index = buffer.indexOf("\n");
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line) continue;
    const request = JSON.parse(line);
    record({ event: "request", method: request.method, params: request.params });
    if (request.id === undefined) continue;
    let result;
    switch (request.method) {
      case "initialize":
        result =
          mode === "malformed"
            ? { protocolVersion: 7, capabilities: "invalid" }
            : {
                protocolVersion: request.params.protocolVersion,
                capabilities: { tools: {}, resources: {} },
                serverInfo: { name: "local-fixture", version: "1" },
                instructions: "Deterministic local fixture only",
              };
        break;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools };
        break;
      case "tools/call":
        result = {
          content: [{ type: "text", text: `fixture:${request.params.name}` }],
          structuredContent: { fixture: request.params.name },
        };
        break;
      case "resources/list":
        result = { resources: [{ uri: "fixture://note", name: "Fixture note", mimeType: "text/plain" }] };
        break;
      case "resources/templates/list":
        result = { resourceTemplates: [] };
        break;
      case "resources/read":
        result = { contents: [{ uri: "fixture://note", mimeType: "text/plain", text: "fixture resource bytes" }] };
        break;
      default:
        process.stdout.write(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: { code: -32601, message: "Fixture method not found" },
          })}\n`,
        );
        continue;
    }
    process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: request.id, result })}\n`);
  }
});
