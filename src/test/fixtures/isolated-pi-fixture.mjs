#!/usr/bin/env node
// Deterministic stdin/stdout fixture. No model, provider, server, or credential store.
import { createInterface } from "node:readline";

const protocol = "pi-vscode-isolated-v1";
const mode = process.argv.at(-1);
const send = (fields) => process.stdout.write(`${JSON.stringify({ protocol, ...fields })}\n`);
if (mode === "unsupported") {
  send({ type: "unsupported" });
  process.exit(0);
}
if (mode === "bad-json") {
  process.stdout.write("not json\n");
  process.exit(0);
}
if (mode === "oversize") {
  process.stdout.write("x".repeat(20_000));
  process.exit(0);
}
if (mode === "wrong-version") {
  send({ type: "ready", version: "9.0.0" });
  process.exit(0);
}
send({ type: "ready", version: "1.3.0" });
let step = 0;
const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const value = JSON.parse(line);
  if (value.protocol !== protocol) process.exit(2);
  if (value.type === "request") {
    if (mode === "secret-error") {
      process.stderr.write("fixture-super-secret-token");
      send({ type: "failure", category: "failed" });
      process.exit(0);
    }
    if (mode === "partial") {
      send({ type: "failure", category: "changed-refresh-failed" });
      process.exit(0);
    }
    if (mode === "exit") process.exit(2);
    if (value.operation === "discover") {
      send({ type: "providers", providers: [{ id: "fixture", methods: ["api_key", "oauth"] }] });
      process.exit(0);
    }
    if (value.operation === "logout") {
      send({ type: "changed" });
      process.exit(0);
    }
    if (mode === "unsafe-url") {
      send({ type: "url", url: "command:workbench.action.files.openFolder" });
      return;
    }
    if (mode === "url" || mode === "device") {
      send(
        mode === "url"
          ? {
              type: "url",
              url: "https://example.invalid/auth?redirect_uri=https%3A%2F%2Fremote.invalid%2Ffull%3Fa%3D1&state=fixture",
            }
          : { type: "device", url: "https://example.invalid/device", code: "FIXTURE-1234" },
      );
    }
    send({ type: "prompt", kind: mode === "manual" ? "manual_code" : "secret", id: 1 });
    if (mode === "dismiss") {
      setTimeout(() => {
        send({ type: "dismiss", id: 1 });
        send({ type: "changed" });
        setTimeout(() => process.exit(0), 10);
      }, 25);
    }
  } else if (value.type === "answer") {
    if (process.argv.join(" ").includes(value.value)) process.exit(3);
    if (mode === "prompts" && step++ === 0) {
      send({ type: "prompt", kind: "select", id: 2, options: [{ id: "optional", label: "Optional fixture choice" }] });
      return;
    }
    send({ type: "changed" });
    process.exit(0);
  }
});
