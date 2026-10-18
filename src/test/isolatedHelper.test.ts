import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PassThrough } from "node:stream";
import vm from "node:vm";
import { transformSync } from "esbuild";

const source = readFileSync(path.resolve("resources/pi-isolated-helper.ts"), "utf8");
const compiled = transformSync(source, { loader: "ts", format: "cjs", target: "es2022" }).code;

async function helperFixture(
  operation: string,
  options: { failure?: boolean; partial?: boolean; malformed?: boolean; version?: string } = {},
) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const output: Record<string, unknown>[] = [];
  const calls: { name: string; value?: unknown }[] = [];
  let handler: (() => Promise<void>) | undefined;
  let pending = "";
  const sdk = {
    VERSION: options.version ?? "1.3.0",
    CredentialSynchronizationError: class extends Error {},
    ModelRuntime: {
      create: async (value: Record<string, unknown>) => {
        calls.push({ name: "create", value });
        assert.equal(value.refreshOnCreate, false);
        assert.equal(value.allowModelNetwork, false);
        return {
          getProviders: () => [{ id: "fixture", auth: { apiKey: { login: () => {} }, oauth: { login: () => {} } } }],
          login: async (_provider: string, _method: string, interaction: any) => {
            calls.push({ name: "login" });
            interaction.notify({ type: "progress", message: "must-not-escape fixture-super-secret-token" });
            interaction.notify({
              type: "info",
              message: "must-not-escape fixture-super-secret-token",
              links: [{ url: "https://secret.invalid" }],
            });
            const secret = await interaction.prompt({
              type: "secret",
              message: "must-not-escape fixture-super-secret-token",
            });
            assert.equal(secret, "fixture-super-secret-token\u2028\u2029");
            if (options.failure) throw new Error("must-not-escape fixture-super-secret-token");
            if (options.partial) throw new sdk.CredentialSynchronizationError();
            return { type: "api_key", key: secret };
          },
          logout: async () => {
            calls.push({ name: "logout" });
          },
        };
      },
    },
  };
  const module = { exports: {} as { default: (pi: unknown) => void } };
  vm.runInNewContext(compiled, {
    exports: module.exports,
    module,
    require: (name: string) => {
      if (name === "@earendil-works/pi-coding-agent") return sdk;
      if (name === "node:fs") return { writeSync: (_fd: number, text: string) => stdout.write(text) };
      assert.ok(name.startsWith("node:"), `Only public package root and Node builtins may load: ${name}`);
      return require(name);
    },
    process: { stdin, stdout, env: { PI_CODING_AGENT_DIR: "/disposable/agent" } },
    AbortController,
    TextDecoder,
    Buffer,
    setTimeout,
    clearTimeout,
  });
  module.exports.default({
    on: (name: string, callback: (_event: unknown, ctx: unknown) => Promise<void>) => {
      assert.equal(name, "session_start");
      handler = () => callback({}, { shutdown: () => calls.push({ name: "shutdown" }) });
    },
  });
  stdout.on("data", (chunk: Buffer) => {
    pending += chunk.toString();
    while (pending.includes("\n")) {
      const index = pending.indexOf("\n");
      const value = JSON.parse(pending.slice(0, index));
      pending = pending.slice(index + 1);
      output.push(value);
      if (value.type === "ready")
        queueMicrotask(() =>
          stdin.write(
            options.malformed
              ? "x".repeat(20_000)
              : `${JSON.stringify({
                  protocol: "pi-vscode-isolated-v1",
                  type: "request",
                  operation,
                  agentDir: "/real-private-store",
                  provider: "fixture",
                  method: "api_key",
                })}\n`,
          ),
        );
      if (value.type === "prompt")
        queueMicrotask(() =>
          stdin.write(
            `${JSON.stringify({ protocol: "pi-vscode-isolated-v1", type: "answer", id: value.id, value: "fixture-super-secret-token\u2028\u2029" })}\n`,
          ),
        );
    }
  });
  assert.ok(handler);
  await handler();
  assert.ok(!JSON.stringify(output).includes("fixture-super-secret-token"));
  assert.ok(!JSON.stringify(output).includes("must-not-escape"));
  assert.equal(stdin.listenerCount("data"), 0, "all input listeners must be detached");
  return { output, calls };
}

test("public isolated extension discovers static providers without touching the selected credential store", async () => {
  const result = await helperFixture("discover");
  const create = result.calls.find((call) => call.name === "create")?.value as Record<string, unknown>;
  assert.equal(create.authPath, "/disposable/agent/auth.json");
  assert.equal(create.modelsPath, null);
  assert.deepEqual(
    result.output.map((value) => value.type),
    ["ready", "providers"],
  );
  assert.ok(!result.calls.some((call) => call.name === "login" || call.name === "logout"));
});
test("public login returns only changed status, not returned Credential or provider prose", async () => {
  const result = await helperFixture("login");
  assert.deepEqual(
    result.output.map((value) => value.type),
    ["ready", "prompt", "changed"],
  );
  assert.equal(
    ((result.calls.find((call) => call.name === "create")?.value ?? {}) as Record<string, unknown>).authPath,
    "/real-private-store/auth.json",
  );
});
test("public logout uses the selected Pi store and does not implement a second store", async () => {
  const result = await helperFixture("logout");
  assert.deepEqual(
    result.calls.map((call) => call.name),
    ["create", "logout", "shutdown"],
  );
});
test("provider/store failure and changed-but-unsynchronized are distinct with no secret diagnostics", async () => {
  assert.equal((await helperFixture("login", { failure: true })).output.at(-1)?.category, "failed");
  assert.equal((await helperFixture("login", { partial: true })).output.at(-1)?.category, "changed-refresh-failed");
});
test("unsupported SDK never reaches a credential method", async () => {
  const result = await helperFixture("login", { version: "0.0.0" });
  assert.deepEqual(result.output, [{ protocol: "pi-vscode-isolated-v1", type: "unsupported" }]);
  assert.deepEqual(
    result.calls.map((call) => call.name),
    ["shutdown"],
  );
});
test("unterminated oversized stdin cancels without waiting for a line or leaking listeners", async () => {
  const result = await helperFixture("login", { malformed: true });
  assert.equal(result.output.at(-1)?.category, "cancelled");
});
