import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runIsolatedPiHelper } from "../isolatedPi";
import { checkNativeMcp } from "../nativeMcpDiagnostics";
import { invokePi, type PiInvocationOptions } from "../piClient";
import { PiRpcClient } from "../piRpcClient";

// These fixtures use Node.js only. They load no Pi package, provider, or native application.
const fixture = `
const assert = require("node:assert/strict");
const family = process.argv[2];
const args = process.argv.slice(3);
assert.equal(process.env.PI_LAUNCH_TEST_RUNTIME, "selected");
assert.equal(process.env.PI_LAUNCH_TEST_REMOVE, undefined);
assert.equal(process.env.PI_PACKAGE_DIR, undefined);
if (family === "print prefix") {
  assert.equal(args[0], "--print");
  let input = "";
  process.stdin.on("data", data => input += data);
  process.stdin.on("end", () => console.log(JSON.stringify({args, input})));
} else if (family === "mcp prefix") {
  assert.deepEqual(args, ["mcp", "list", "--json"]);
  assert.equal(process.env.PI_OFFLINE, "1");
  console.log(JSON.stringify({servers: [{name: "fixture", state: "connected", tools: []}], errors: []}));
} else {
  assert.deepEqual(args.slice(0, 2), ["--mode", "rpc"]);
  if (family === "helper prefix") {
    assert.equal(process.env.PI_LAUNCH_TEST_SECRET, undefined);
    assert.equal(process.env.PI_VSCODE_BRIDGE_TOKEN, undefined);
    assert.equal(process.env.NODE_OPTIONS, undefined);
    assert.notEqual(process.cwd(), process.env.PI_LAUNCH_TEST_CWD);
    assert.equal(process.env.PI_CODING_AGENT_DIR, require("node:path").join(process.env.HOME, "agent"));
    assert.equal(process.env.PI_OFFLINE, "1");
    console.log(JSON.stringify({protocol: "pi-vscode-isolated-v1", type: "ready", version: "1.3.0"}));
  }
  require("node:readline").createInterface({input: process.stdin}).on("line", line => {
    const request = JSON.parse(line);
    if (family === "helper prefix") {
      assert.equal(request.operation, "discover");
      console.log(JSON.stringify({protocol: request.protocol, type: "providers", providers: []}));
      process.exit(0);
    }
    console.log(JSON.stringify({type: "response", id: request.id, command: request.type, success: true, data: {args}}));
  });
}
`;

for (const family of ["print", "rpc", "helper", "mcp"] as const) {
  test(`${family} launch retains the argument prefix and selected runtime environment`, async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pi-shared-launch-"));
    const script = path.join(directory, "runtime entry with spaces.cjs");
    await writeFile(script, fixture);
    const keys = [
      "PI_LAUNCH_TEST_REMOVE",
      "PI_PACKAGE_DIR",
      "PI_LAUNCH_TEST_SECRET",
      "PI_VSCODE_BRIDGE_TOKEN",
      "NODE_OPTIONS",
    ];
    const previous = keys.map((key) => process.env[key]);
    process.env.PI_LAUNCH_TEST_REMOVE = "inherited";
    process.env.PI_PACKAGE_DIR = "/unrelated-installation";
    process.env.PI_LAUNCH_TEST_SECRET = "private";
    process.env.PI_VSCODE_BRIDGE_TOKEN = "private";
    process.env.NODE_OPTIONS = "--no-warnings";
    const options: PiInvocationOptions = {
      executablePath: process.execPath,
      executableArgs: [script, `${family} prefix`],
      cwd: directory,
      env: { PI_LAUNCH_TEST_RUNTIME: "selected", PI_LAUNCH_TEST_CWD: directory },
      unsetEnv: ["PI_LAUNCH_TEST_REMOVE", "PI_PACKAGE_DIR"],
    };
    try {
      if (family === "print") {
        const result = JSON.parse(await invokePi("private prompt on stdin", options));
        assert.equal(result.input, "private prompt on stdin");
        assert.deepEqual(result.args, ["--print", "--no-session", "--no-tools"]);
      } else if (family === "rpc") {
        const client = new PiRpcClient(options);
        try {
          await client.start();
          const state = await client.getState();
          assert.deepEqual((state.args as string[]).slice(0, 2), ["--mode", "rpc"]);
        } finally {
          await client.stop();
        }
      } else if (family === "helper") {
        const result = await runIsolatedPiHelper(options, "helper.ts", { operation: "discover", agentDir: "/unused" });
        assert.deepEqual(result.providers, []);
      } else {
        const result = await checkNativeMcp(options, new AbortController().signal);
        assert.equal(result.outcome, "completed");
        assert.deepEqual(result.servers, [{ name: "fixture", state: "connected", toolCount: 0 }]);
      }
    } finally {
      keys.forEach((key, index) => {
        if (previous[index] === undefined) delete process.env[key];
        else process.env[key] = previous[index];
      });
      await rm(directory, { recursive: true, force: true });
    }
  });
}
