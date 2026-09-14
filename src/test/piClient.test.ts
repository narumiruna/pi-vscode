import assert from "node:assert/strict";
import { buildPiArguments, type PiInvocationOptions } from "../piClient";

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

  assert.equal(args.some(argument => argument.includes(selectedCode)), false);
});
