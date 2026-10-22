import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
const vscodePi = require("../vscodePi") as typeof import("../vscodePi");
afterAll(() => mock.restore());

async function fixture(action: (runtime: any, internal: any, root: string, starts: () => number) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-startup-")));
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

for (const change of ["dispose", "model", "approval", "executablePath"] as const) {
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
            key ===
            (change === "model" ? "model" : change === "executablePath" ? "executablePath" : "approveProjectResources")
              ? change === "model"
                ? "changed-model"
                : change === "executablePath"
                  ? "changed-pi"
                  : true
              : fallback,
        });
      release({});
      await assert.rejects(startup, /disposed|launch settings changed/);
      assert.equal(starts(), 0);
    });
  });
}

for (const failure of ["missing-assets", "post-start", "settings-changed"] as const) {
  test(`packaged ${failure} failure preserves the saved session without fresh-session fallback`, async () => {
    await fixture(async (_runtime, internal, root, starts) => {
      const savedSession = path.join(root, "saved.jsonl");
      await writeFile(savedSession, `${JSON.stringify({ type: "session", cwd: root })}\n`);
      let saved: string | undefined = savedSession;
      internal.context.workspaceState.get = () => saved;
      internal.context.workspaceState.update = async (_key: string, value: string | undefined) => {
        saved = value;
      };
      const create = vi.spyOn(internal, "createAndStartClient");
      if (failure === "missing-assets") vscodePi.initializePiRuntime(root);
      else if (failure === "post-start")
        vi.mocked(PiRpcClient.prototype.start).mockRejectedValue(new Error("startup failed"));
      else
        internal.bridgeEnvironment = async () => {
          mock.workspace.getConfiguration = () => ({
            get: (key: string, fallback: unknown) => (key === "executablePath" ? "pi" : fallback),
          });
          return {};
        };
      try {
        await assert.rejects(internal.startClient(), /Packaged Pi|startup failed|settings changed/);
        assert.equal(saved, savedSession);
        assert.equal(create.mock.calls.length, 1);
        assert.equal(create.mock.calls[0]?.[0], savedSession);
        assert.equal(starts(), failure === "post-start" ? 1 : 0);
        assert.equal(internal.client, undefined);
      } finally {
        create.mockRestore();
        vscodePi.initializePiRuntime(process.cwd());
      }
    });
  });
}

for (const replacement of ["", "other-pi", "approval"] as const) {
  test(`external startup policy change (${replacement || "packaged"}) cannot clear the saved session or start another writer`, async () => {
    await fixture(async (_runtime, internal, root, starts) => {
      const savedSession = path.join(root, "saved.jsonl");
      await writeFile(savedSession, `${JSON.stringify({ type: "session", cwd: root })}\n`);
      let saved: string | undefined = savedSession;
      let changed = false;
      internal.context.workspaceState.get = () => saved;
      internal.context.workspaceState.update = async (_key: string, value: string | undefined) => {
        saved = value;
      };
      mock.workspace.getConfiguration = () => ({
        get: (key: string, fallback: unknown) => {
          if (key === "executablePath") return changed && replacement !== "approval" ? replacement : "pi";
          if (key === "approveProjectResources") return changed && replacement === "approval";
          return fallback;
        },
      });
      internal.bridgeEnvironment = async () => {
        changed = true;
        return {};
      };
      const create = vi.spyOn(internal, "createAndStartClient");
      try {
        await assert.rejects(internal.startClient(), /settings changed/);
        assert.equal(saved, savedSession);
        assert.equal(create.mock.calls.length, 1);
        assert.equal(create.mock.calls[0]?.[0], savedSession);
        assert.equal(starts(), 0);
        assert.equal(internal.client, undefined);
      } finally {
        create.mockRestore();
      }
    });
  });
}

test("unchanged external startup policy retains the existing saved-session fallback", async () => {
  await fixture(async (_runtime, internal, root) => {
    mock.workspace.getConfiguration = () => ({
      get: (key: string, fallback: unknown) => (key === "executablePath" ? "pi" : fallback),
    });
    const savedSession = path.join(root, "saved.jsonl");
    let saved: string | undefined = savedSession;
    internal.context.workspaceState.get = () => saved;
    internal.context.workspaceState.update = async (_key: string, value: string | undefined) => {
      saved = value;
    };
    const create = vi
      .spyOn(internal, "createAndStartClient")
      .mockRejectedValueOnce(new Error("external session failed"))
      .mockResolvedValueOnce(undefined);
    try {
      await internal.startClient();
      assert.equal(saved, undefined);
      assert.equal(create.mock.calls.length, 2);
      assert.equal(create.mock.calls[0]?.[0], savedSession);
      assert.equal(create.mock.calls[1]?.[0], undefined);
    } finally {
      create.mockRestore();
    }
  });
});

test("foreground launch retains runtime prefix, environment, unsets and private bridge credentials", async () => {
  await fixture(async (_runtime, internal, root) => {
    const read = vi.spyOn(vscodePi, "readPiInvocationOptions").mockReturnValue({
      executablePath: process.execPath,
      executableArgs: ["/extension path/pi cli.js"],
      cwd: root,
      env: { ELECTRON_RUN_AS_NODE: "1", PI_SKIP_VERSION_CHECK: "1" },
      unsetEnv: ["PI_PACKAGE_DIR", "PI_MANAGED_INSTALL_ROOT"],
    });
    internal.bridgeEnvironment = async () => ({ PI_VSCODE_BRIDGE_TOKEN: "private-bridge" });
    try {
      await internal.createAndStartClient(undefined);
      const options = internal.client.options;
      assert.deepEqual(options.executableArgs, ["/extension path/pi cli.js"]);
      assert.deepEqual(options.unsetEnv, ["PI_PACKAGE_DIR", "PI_MANAGED_INSTALL_ROOT"]);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(options.env.PI_SKIP_VERSION_CHECK, "1");
      assert.equal(options.env.PI_VSCODE_BRIDGE_TOKEN, "private-bridge");
      assert.match(options.env.PI_VSCODE_ANNOTATION_TOKEN, /^[a-f0-9]{64}$/);
    } finally {
      read.mockRestore();
    }
  });
});

test("disposal during a synchronous reset listener cannot start the already-assigned client", async () => {
  await fixture(async (runtime, internal, _root, starts) => {
    runtime.onEvent((event: { type: string }) => {
      if (event.type === "extension_ui_reset") runtime.dispose();
    });
    await assert.rejects(internal.createAndStartClient(undefined), /disposed|replaced/);
    assert.equal(starts(), 0);
  });
});
