import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  authUrl,
  buildIsolatedPiHelperArguments,
  buildIsolatedPiHelperEnvironment,
  type IsolatedPiAuthInteraction,
  IsolatedPiHelperError,
  runIsolatedPiHelper,
} from "../isolatedPi";

let directory: string;
let executablePath: string;
beforeAll(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "pi-helper-fixture-"));
  executablePath = path.join(directory, "custom pi");
  await copyFile(path.resolve("src/test/fixtures/isolated-pi-fixture.mjs"), executablePath);
  await chmod(executablePath, 0o700);
});
afterAll(async () => {
  await rm(directory, { recursive: true, force: true });
});
const request = {
  operation: "login" as const,
  agentDir: "/fixture-private-store",
  provider: "fixture",
  method: "api_key" as const,
};
const interaction: IsolatedPiAuthInteraction = {
  prompt: async () => "fixture-super-secret-token",
  openUrl: async () => true,
};
function run(mode: string, callbacks = interaction, signal?: AbortSignal) {
  return runIsolatedPiHelper({ executablePath, cwd: directory }, mode, request, callbacks, signal);
}

test("helper bootstrap is offline, private, and cannot inherit credentials, bridge tokens, resources or Node hooks", () => {
  const environment = buildIsolatedPiHelperEnvironment("/disposable", "/workspace", {
    PATH: "/bin:relative",
    HOME: "/real-home",
    PI_CODING_AGENT_DIR: "/real-store",
    NODE_OPTIONS: "--require dangerous",
    OPENAI_API_KEY: "secret",
    PI_VSCODE_BRIDGE_TOKEN: "secret",
    GH_TOKEN: "secret",
    HTTP_PROXY: "http://proxy.invalid",
  });
  assert.equal(environment.HOME, "/disposable");
  assert.equal(environment.PI_CODING_AGENT_DIR, "/disposable/agent");
  assert.equal(environment.PI_OFFLINE, "1");
  assert.equal(environment.NODE_OPTIONS, undefined);
  assert.equal(environment.OPENAI_API_KEY, undefined);
  assert.equal(environment.PI_VSCODE_BRIDGE_TOKEN, undefined);
  assert.equal(environment.GH_TOKEN, undefined);
  assert.ok(buildIsolatedPiHelperArguments("helper.ts").includes("--no-approve"));
  assert.ok(buildIsolatedPiHelperArguments("helper.ts").includes("--no-extensions"));
  assert.ok(buildIsolatedPiHelperArguments("helper.ts").includes("--no-mcp"));
  assert.ok(!buildIsolatedPiHelperArguments("helper.ts").includes("/real-store"));
});

test("configured custom executable discovers provider methods without auth or model calls", async () => {
  const result = await runIsolatedPiHelper({ executablePath, cwd: directory }, "discover", {
    operation: "discover",
    agentDir: "/unused",
  });
  assert.deepEqual(result.providers, [{ id: "fixture", methods: ["api_key", "oauth"] }]);
});
test("dedicated secret and optional selection input stays on stdin, never argv", async () => {
  const prompts: string[] = [];
  const result = await run("prompts", {
    ...interaction,
    prompt: async (prompt) => {
      prompts.push(prompt.kind);
      return prompt.kind === "select" ? "optional" : "fixture-super-secret-token";
    },
  });
  assert.equal(result.status, "changed");
  assert.deepEqual(prompts, ["secret", "select"]);
});
test("device and complete remote auth URLs are preserved; manual redirects remain stdin-only", async () => {
  for (const mode of ["url", "device", "manual"]) {
    const urls: string[] = [];
    const result = await run(mode, {
      prompt: async () => "https://remote.invalid/callback?state=fixture&code=fixture-super-secret-token",
      openUrl: async (url, code) => {
        urls.push(url, code ?? "");
        return true;
      },
    });
    assert.equal(result.status, "changed");
    if (mode === "url")
      assert.ok(urls[0]?.includes("redirect_uri=https%3A%2F%2Fremote.invalid%2Ffull%3Fa%3D1&state=fixture"));
    if (mode === "device") assert.equal(urls[1], "FIXTURE-1234");
  }
});
test("logout and credential-changed/catalog-refresh-failed are distinct verified outcomes", async () => {
  assert.equal(
    (
      await runIsolatedPiHelper({ executablePath, cwd: directory }, "logout", {
        operation: "logout",
        agentDir: "/unused",
        provider: "fixture",
      })
    ).status,
    "changed",
  );
  assert.equal((await run("partial")).status, "changed-refresh-failed");
});
for (const mode of ["unsupported", "wrong-version", "bad-json", "oversize", "unsafe-url", "secret-error", "exit"]) {
  test(`helper rejects ${mode} with no raw provider diagnostics or secrets`, async () => {
    await assert.rejects(run(mode), (error: unknown) => {
      assert.ok(error instanceof IsolatedPiHelperError);
      assert.ok(!error.message.includes("fixture-super-secret-token"));
      assert.ok(!error.message.includes("command:"));
      return true;
    });
  });
}
test("browser cancellation and process cancellation stop only the owned helper", async () => {
  await assert.rejects(run("url", { ...interaction, openUrl: async () => false }), IsolatedPiHelperError);
  const controller = new AbortController();
  const result = run(
    "hang",
    {
      ...interaction,
      prompt: async (_prompt, signal) => {
        controller.abort();
        return new Promise<string | undefined>((resolve) => {
          signal.addEventListener("abort", () => resolve(undefined), { once: true });
          if (signal.aborted) resolve(undefined);
        });
      },
    },
    controller.signal,
  );
  await assert.rejects(
    result,
    (error: unknown) => error instanceof IsolatedPiHelperError && error.category === "uncertain",
  );
});
test("out-of-band callback dismisses a pending masked prompt and discards late answers", async () => {
  let dismissed = false;
  const result = await run("dismiss", {
    ...interaction,
    prompt: async (_prompt, signal) =>
      new Promise((resolve) => {
        signal.addEventListener(
          "abort",
          () => {
            dismissed = true;
            resolve("late-secret");
          },
          { once: true },
        );
      }),
  });
  assert.equal(result.status, "changed");
  assert.equal(dismissed, true);
});
test("auth URLs reject unsafe schemes, controls, credentials, fragments and excessive lengths", () => {
  for (const value of [
    "command:bad",
    "http://example.invalid",
    "https://u:p@example.invalid/",
    "https://example.invalid/#secret",
    "https://example.invalid/\n",
    "https:\\example.invalid",
    `https://example.invalid/${"a".repeat(4_096)}`,
  ])
    assert.throws(() => authUrl(value));
  assert.equal(
    authUrl("https://example.invalid/auth?state=abc&redirect_uri=https%3A%2F%2Fremote.invalid%2Fcomplete%3Fa%3D1"),
    "https://example.invalid/auth?state=abc&redirect_uri=https%3A%2F%2Fremote.invalid%2Fcomplete%3Fa%3D1",
  );
});
