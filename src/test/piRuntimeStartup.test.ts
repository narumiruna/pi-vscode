import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
afterAll(() => mock.restore());

async function fixture(action: (runtime: any, internal: any, root: string, starts: () => number) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-startup-"));
  const folder = { uri: MockUri.file(root) };
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: { get: () => undefined, update: async () => {} },
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
  const internal = runtime as any;
  internal.bridgeEnvironment = async () => ({});
  internal.refreshState = async () => {};
  const start = vi.spyOn(PiRpcClient.prototype, "start").mockResolvedValue(undefined);
  try {
    await action(runtime, internal, root, () => start.mock.calls.length);
  } finally {
    runtime.dispose();
    start.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
}

test("only controlled recovery permits an assigned unsaved path; existing foreign headers still fail", async () => {
  await fixture(async (_runtime, internal, root, starts) => {
    const session = path.join(root, "assigned.jsonl");
    await assert.rejects(internal.createAndStartClient(session), /ENOENT/);
    assert.equal(starts(), 0);
    await internal.createAndStartClient(session, true, root);
    assert.equal(starts(), 1);
    await internal.stopClient();
    await writeFile(session, JSON.stringify({ type: "session", cwd: process.cwd() }) + "\n");
    await assert.rejects(internal.createAndStartClient(session, true, root), /another working directory/);
    assert.equal(starts(), 1);
  });
});

for (const change of ["dispose", "model", "approval"] as const) {
  test(`startup rejects ${change} during asynchronous preparation before spawning`, async () => {
    await fixture(async (runtime, internal, _root, starts) => {
      let release!: (env: Record<string, string>) => void;
      let ready!: () => void;
      const preparing = new Promise<void>((resolve) => {
        ready = resolve;
      });
      internal.bridgeEnvironment = () =>
        new Promise<Record<string, string>>((resolve) => {
          release = resolve;
          ready();
        });
      const startup = internal.createAndStartClient(undefined);
      await preparing;
      if (change === "dispose") runtime.dispose();
      else
        mock.workspace.getConfiguration = () => ({
          get: (key: string, fallback: unknown) =>
            key === (change === "model" ? "model" : "approveProjectResources")
              ? change === "model"
                ? "changed-model"
                : true
              : fallback,
        });
      release({});
      await assert.rejects(startup, /disposed|launch settings changed/);
      assert.equal(starts(), 0);
    });
  });
}

test("disposal during a synchronous reset listener cannot start the already-assigned client", async () => {
  await fixture(async (runtime, internal, _root, starts) => {
    runtime.onEvent((event: { type: string }) => {
      if (event.type === "extension_ui_reset") runtime.dispose();
    });
    await assert.rejects(internal.createAndStartClient(undefined), /disposed|replaced/);
    assert.equal(starts(), 0);
  });
});
