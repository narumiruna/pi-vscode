import assert from "node:assert/strict";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { initializePiRuntime, readPiInvocationOptions, readPiInvocationSettings } =
  require("../vscodePi") as typeof import("../vscodePi");
afterAll(() => mock.restore());

test("runtime settings preserve User, Workspace and folder overrides, including saved legacy pi", () => {
  initializePiRuntime(process.cwd());
  const user = new Map<string, string>();
  const workspace = new Map<string, string>();
  const folder = new Map<string, string>();
  const resource = MockUri.file(path.join(process.cwd(), "sample.ts"));
  mock.workspace.workspaceFolders = [{ uri: MockUri.file(process.cwd()) }];
  mock.workspace.getWorkspaceFolder = () => mock.workspace.workspaceFolders[0];
  mock.workspace.getConfiguration = (_section: string, uri: unknown) => ({
    get: (key: string, fallback: string) =>
      (uri ? folder.get(key) : undefined) ?? workspace.get(key) ?? user.get(key) ?? fallback,
  });
  const bundled = () => assert.equal(readPiInvocationOptions(resource as any).executablePath, process.execPath);
  bundled();
  user.set("executablePath", "pi");
  assert.equal(readPiInvocationOptions(resource as any).executablePath, "pi");
  workspace.set("executablePath", " ./workspace pi ");
  assert.equal(readPiInvocationOptions(resource as any).executablePath, "./workspace pi");
  folder.set("executablePath", "./folder/pi");
  assert.equal(readPiInvocationOptions(resource as any).executablePath, "./folder/pi");
  folder.delete("executablePath");
  assert.equal(readPiInvocationOptions(resource as any).executablePath, "./workspace pi");
  workspace.set("executablePath", " \t ");
  bundled();
  workspace.delete("executablePath");
  assert.equal(readPiInvocationOptions(resource as any).executablePath, "pi", "Reset reveals the saved User override");
  user.delete("executablePath");
  bundled();
  assert.equal(user.size + workspace.size + folder.size, 0, "Reading never rewrites configuration");
});

test("passive settings and cwd reads do not inspect missing packaged runtime assets", () => {
  initializePiRuntime(path.resolve("missing-extension-installation"));
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  const spawn = vi.spyOn(require("node:child_process"), "spawn").mockImplementation(() => {
    throw new Error("Unexpected process");
  });
  try {
    assert.equal(readPiInvocationSettings().executablePath, "");
    assert.equal(readPiInvocationSettings().cwd, process.cwd());
    assert.throws(() => readPiInvocationOptions(), /Packaged Pi is missing or invalid/);
    assert.equal(spawn.mock.calls.length, 0);
  } finally {
    spawn.mockRestore();
    initializePiRuntime(process.cwd());
  }
});
