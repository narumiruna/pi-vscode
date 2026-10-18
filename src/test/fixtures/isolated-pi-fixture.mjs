#!/usr/bin/env node
// Deterministic stdin/stdout fixture. No model, provider, server, or credential store.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const protocol = "pi-vscode-isolated-v1";
const mode = process.argv.at(-1);
// Test scenario stays beside the disposable executable, not in production configuration.
const nativeMode = () => {
  try {
    return readFileSync(path.join(path.dirname(process.argv[1]), "auth-mode.txt"), "utf8");
  } catch {
    return "secret";
  }
};
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
const onLine = (line) => {
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
    if (value.operation === "export" || value.operation === "import") {
      // Only deterministic v3 tree/branch semantics. Real Pi is checked by test-isolated-sdk.mjs.
      const bytes = readFileSync(value.input);
      assert.ok(bytes.length <= 32 * 1024 * 1024 && bytes.at(-1) === 10);
      const [header, ...entries] = bytes.toString("utf8").slice(0, -1).split("\n").map(JSON.parse);
      assert.equal(header.version, 3);
      assert.equal(header.cwd, value.cwd);
      assert.ok(entries.length <= 50_000);
      const byId = new Map();
      for (const entry of entries) {
        assert.ok(!byId.has(entry.id) && (entry.parentId === null || byId.has(entry.parentId)));
        byId.set(entry.id, entry);
      }
      let selected = entries;
      if (value.operation === "export") {
        selected = [];
        let leaf = value.leaf;
        while (leaf !== null) {
          const entry = byId.get(leaf);
          assert.ok(entry);
          selected.unshift(entry);
          leaf = entry.parentId;
        }
        header.id = "fixture-exported-branch";
      }
      writeFileSync(value.output, `${[header, ...selected].map((entry) => JSON.stringify(entry)).join("\n")}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      send({ type: "complete" });
      process.exit(0);
    }
    if (value.operation === "discover") {
      if (nativeMode() === "unsupported") send({ type: "unsupported" });
      else send({ type: "providers", providers: [{ id: "fixture", methods: ["api_key", "oauth"] }] });
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
    if (nativeMode() === "url-cancel") {
      send({ type: "url", url: "https://example.invalid/native-fixture-never-open" });
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
};
// LF alone delimits records. Unicode LS/PS are valid JSON string content.
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (buffer.includes("\n")) {
    const newline = buffer.indexOf("\n");
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line) onLine(line);
  }
});
