import assert from "node:assert/strict";
import { buildPiArguments, invokePi, PiInvocationError, type PiInvocationOptions } from "../piClient";
import { alive, fixturePid, launchFixture, waitUntil } from "./piLaunchFixtures";

test("one-shot launch preserves real arguments and sends the prompt only over stdin", async () => {
  const f = await launchFixture();
  try {
    const model = '%TEMP% "quoted" & | ^ !NAME! 漢字\\';
    const prompt = "source code stays on stdin\n%TEMP%";
    const result = JSON.parse(await invokePi(prompt, { executablePath: f.executable, cwd: f.root, model }));
    assert.equal(result.input, prompt);
    assert.deepEqual(result.args, [...buildPiArguments({ executablePath: f.executable, cwd: f.root, model })]);
  } finally {
    await f.cleanup();
  }
});

for (const failure of ["hang", "overflow", "stdin-failure", "early-exit"]) {
  test(`one-shot ${failure} cleanup stops the actual runtime`, async () => {
    const f = await launchFixture();
    const previous = process.env.PI_FIXTURE_PID;
    process.env.PI_FIXTURE_PID = f.pidFile;
    const controller = new AbortController();
    try {
      const promise = invokePi(
        failure === "stdin-failure" ? "x".repeat(4 * 1024 * 1024) : "input",
        {
          executablePath: f.executable,
          cwd: f.root,
          model: failure,
        },
        controller.signal,
      );
      // Attach rejection handling before observing asynchronous fixture state.
      const rejection = assert.rejects(promise, (error: unknown) => {
        assert.ok(error instanceof PiInvocationError);
        if (failure === "hang") assert.equal(error.kind, "aborted");
        if (failure === "stdin-failure") assert.equal(error.kind, "launch");
        if (failure === "overflow") assert.equal(error.kind, "output");
        if (process.platform === "win32") assert.match(error.details ?? "", /cleanup could not be verified/);
        return true;
      });
      const pid = await fixturePid(f.pidFile);
      if (failure === "hang") controller.abort();
      await rejection;
      await waitUntil(() => !alive(pid));
    } finally {
      controller.abort();
      if (previous === undefined) delete process.env.PI_FIXTURE_PID;
      else process.env.PI_FIXTURE_PID = previous;
      await f.cleanup();
    }
  });
}

test("one-shot early root exit with an inherited pipe cannot hang or claim clean completion", async () => {
  const f = await launchFixture();
  const previous = { ...process.env };
  Object.assign(process.env, f.env);
  try {
    const started = Date.now();
    await assert.rejects(
      invokePi("input", { executablePath: f.executable, cwd: f.root, model: "descendant", provider: "early-exit" }),
      (error: unknown) => {
        assert.ok(error instanceof PiInvocationError);
        if (process.platform === "win32") assert.match(error.details ?? "", /could not be verified/);
        return true;
      },
    );
    assert.ok(Date.now() - started < 3_500);
    const pid = await fixturePid(f.pidFile);
    await waitUntil(() => !alive(pid));
  } finally {
    for (const key of Object.keys(f.env)) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    await f.cleanup();
  }
});

test("one-shot pre-abort and invalid paths remain launch/cancellation errors", async () => {
  const f = await launchFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(invokePi("input", { executablePath: f.executable, cwd: f.root }, controller.signal), {
      kind: "aborted",
    });
    await assert.rejects(invokePi("input", { executablePath: f.executable, cwd: `${f.root}/missing` }), {
      kind: "launch",
    });
    await assert.rejects(invokePi("input", { executablePath: `${f.root}/missing.exe`, cwd: f.root }), {
      kind: "launch",
    });
  } finally {
    await f.cleanup();
  }
});

const baseOptions: PiInvocationOptions = {
  executablePath: "pi",
  cwd: "/workspace",
};

test("buildPiArguments uses isolated one-shot mode", () => {
  assert.deepEqual(buildPiArguments(baseOptions), ["--print", "--no-session", "--no-tools"]);
});

test("buildPiArguments includes only configured Pi overrides", () => {
  assert.deepEqual(
    buildPiArguments({
      ...baseOptions,
      provider: "anthropic",
      model: "claude-sonnet",
      thinkingLevel: "medium",
    }),
    [
      "--print",
      "--no-session",
      "--no-tools",
      "--provider",
      "anthropic",
      "--model",
      "claude-sonnet",
      "--thinking",
      "medium",
    ],
  );
});

test("buildPiArguments never includes prompt content", () => {
  const selectedCode = "const privateValue = 'never put this in argv';";
  const args = buildPiArguments(baseOptions);

  assert.equal(
    args.some((argument) => argument.includes(selectedCode)),
    false,
  );
});
