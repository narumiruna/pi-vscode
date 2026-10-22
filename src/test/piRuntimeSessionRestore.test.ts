import assert from "node:assert/strict";
import { mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
const { PiRpcClient } = require("../piRpcClient") as typeof import("../piRpcClient");
const { initializePiRuntime } = require("../vscodePi") as typeof import("../vscodePi");
afterAll(() => mock.restore());

async function fixture(action: (f: any) => Promise<void>) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-session-restore-")));
  const session = path.join(root, "remembered.jsonl");
  let saved: string | undefined = session;
  const writes: (string | undefined)[] = [];
  const folder = { uri: MockUri.file(root) };
  mock.workspace.isTrusted = true;
  mock.workspace.workspaceFolders = [folder];
  mock.workspace.getWorkspaceFolder = () => folder;
  mock.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(process.cwd()),
    workspaceState: {
      get: () => saved,
      update: async (_key: string, value: string | undefined) => {
        writes.push(value);
        saved = value;
      },
    },
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
  const internal = runtime as any;
  const refresh = internal.refreshState.bind(internal);
  internal.refreshState = async () => {};
  internal.bridgeEnvironment = async () => ({});
  const start = vi.spyOn(PiRpcClient.prototype, "start").mockResolvedValue(undefined);
  const warning = vi.spyOn(mock.window, "showWarningMessage").mockResolvedValue(undefined);
  try {
    await action({ runtime, internal, root, session, saved: () => saved, writes, start, warning, refresh });
  } finally {
    runtime.dispose();
    start.mockRestore();
    warning.mockRestore();
    initializePiRuntime(process.cwd());
    await rm(root, { recursive: true, force: true });
  }
}

for (const [executable, accept] of [
  ["", false],
  ["", true],
  ["pi", false],
  ["pi", true],
] as const) {
  test(`missing legacy restore pointer requires approval (${executable || "bundled"}, ${accept})`, async () => {
    await fixture(async ({ internal, session, saved, writes, start, warning }: any) => {
      mock.workspace.getConfiguration = () => ({
        get: (key: string, fallback: unknown) => (key === "executablePath" ? executable : fallback),
      });
      warning.mockImplementation(async (message: string, options: unknown, choice: string) => {
        assert.ok(!message.includes(session), "The prompt does not disclose session paths");
        assert.deepEqual(options, { modal: true });
        assert.equal(start.mock.calls.length, 0, "Recovery runs before any Pi process starts");
        assert.equal(saved(), session);
        return accept ? choice : undefined;
      });
      if (accept) {
        await internal.startClient();
        assert.equal(saved(), undefined);
        assert.deepEqual(writes, [undefined]);
        assert.equal(start.mock.calls.length, 1);
        assert.equal(internal.client.options.sessionPath, undefined);
        assert.equal(internal.client.options.executablePath, executable || process.execPath);
      } else {
        await assert.rejects(internal.startClient(), { code: "ENOENT" });
        assert.equal(saved(), session);
        assert.deepEqual(writes, []);
        assert.equal(start.mock.calls.length, 0);
      }
      assert.equal(warning.mock.calls.length, 1);
    });
  });
}

for (const change of ["trust", "settings", "approval", "pointer", "file", "workspace", "assets", "dispose"] as const) {
  test(`missing-session recovery rejects a changed ${change} while approval is open`, async () => {
    await fixture(async ({ runtime, internal, root, session, writes, start, warning }: any) => {
      warning.mockImplementation(async () => {
        if (change === "trust") mock.workspace.isTrusted = false;
        if (change === "settings" || change === "approval")
          mock.workspace.getConfiguration = () => ({
            get: (key: string, fallback: unknown) =>
              key === (change === "settings" ? "executablePath" : "approveProjectResources")
                ? change === "settings"
                  ? "pi"
                  : true
                : fallback,
          });
        if (change === "pointer") internal.context.workspaceState.get = () => "another-session";
        if (change === "file") await writeFile(session, `${JSON.stringify({ type: "session", cwd: root })}\n`);
        if (change === "workspace") mock.workspace.workspaceFolders = [{ uri: MockUri.file(process.cwd()) }];
        if (change === "assets") initializePiRuntime(root);
        if (change === "dispose") runtime.dispose();
        return "Start New Session";
      });
      await assert.rejects(internal.startClient());
      assert.deepEqual(writes, []);
      assert.equal(start.mock.calls.length, 0);
    });
  });
}

for (const failure of ["missing-cwd", "foreign-cwd", "invalid-header", "missing-assets", "dangling-link"] as const) {
  test(`saved-session ${failure} is not treated as an absent session file`, async () => {
    if (failure === "dangling-link" && process.platform === "win32") return;
    await fixture(async ({ internal, root, session, saved, writes, start, warning }: any) => {
      if (failure === "missing-assets") initializePiRuntime(root);
      else if (failure === "dangling-link") await symlink(path.join(root, "missing-target"), session);
      else
        await writeFile(
          session,
          failure === "invalid-header"
            ? "not-json\n"
            : `${JSON.stringify({
                type: "session",
                cwd: failure === "missing-cwd" ? path.join(root, "missing-workspace") : process.cwd(),
              })}\n`,
        );
      await assert.rejects(internal.startClient());
      assert.equal(saved(), session);
      assert.deepEqual(writes, []);
      assert.equal(start.mock.calls.length, 0);
      assert.equal(warning.mock.calls.length, 0);
    });
  });
}

test("permission failures preserve the restore pointer without offering a new session", async () => {
  await fixture(async ({ internal, session, saved, writes, start, warning }: any) => {
    const open = vi
      .spyOn(require("node:fs/promises"), "open")
      .mockRejectedValueOnce(Object.assign(new Error("private filesystem error"), { code: "EACCES" }));
    try {
      await assert.rejects(internal.startClient(), { code: "EACCES" });
      assert.equal(saved(), session);
      assert.deepEqual(writes, []);
      assert.equal(start.mock.calls.length, 0);
      assert.equal(warning.mock.calls.length, 0);
    } finally {
      open.mockRestore();
    }
  });
});

test("storage failure during approved recovery prevents a replacement process", async () => {
  await fixture(async ({ internal, session, saved, start, warning }: any) => {
    warning.mockResolvedValue("Start New Session");
    internal.context.workspaceState.update = async () => {
      throw Object.assign(new Error("storage failure"), { code: "ENOSPC" });
    };
    await assert.rejects(internal.startClient(), { code: "ENOSPC" });
    assert.equal(saved(), session);
    assert.equal(start.mock.calls.length, 0);
  });
});

for (const change of ["settings", "trust", "ownership", "pointer"] as const) {
  test(`approved recovery cannot start Pi after ${change} changes during storage cleanup`, async () => {
    await fixture(async ({ internal, start, warning }: any) => {
      warning.mockResolvedValue("Start New Session");
      const update = internal.context.workspaceState.update;
      internal.context.workspaceState.update = async (key: string, value: string | undefined) => {
        await update(key, value);
        if (change === "settings")
          mock.workspace.getConfiguration = () => ({
            get: (key: string, fallback: unknown) => (key === "executablePath" ? "other-pi" : fallback),
          });
        if (change === "trust") mock.workspace.isTrusted = false;
        if (change === "ownership") internal.control.persistedOwnership = "invalid";
        if (change === "pointer") internal.context.workspaceState.get = () => "newer-session";
      };
      await assert.rejects(internal.startClient());
      assert.equal(start.mock.calls.length, 0);
    });
  });
}

for (const state of ["unsaved", "saved", "no-path", "invalid-header", "missing-cwd"] as const) {
  test(`state refresh persists only a saved session (${state})`, async () => {
    await fixture(async ({ runtime, internal, root, session, saved, writes, refresh }: any) => {
      if (state === "saved" || state === "missing-cwd")
        await writeFile(
          session,
          `${JSON.stringify({ type: "session", cwd: state === "saved" ? root : path.join(root, "missing") })}\n`,
        );
      if (state === "invalid-header") await writeFile(session, "invalid\n");
      const sessionFile = state === "no-path" ? undefined : session;
      internal.client = {
        isRunning: true,
        getState: async () => ({ sessionId: "active-session", sessionFile }),
        getSessionStats: async () => ({}),
      };
      try {
        if (state === "invalid-header" || state === "missing-cwd") {
          await assert.rejects(refresh(false));
          assert.equal(saved(), session);
          assert.deepEqual(writes, []);
        } else {
          await refresh(false);
          assert.equal(saved(), state === "saved" ? session : undefined);
          assert.deepEqual(writes, [state === "saved" ? session : undefined]);
          assert.equal(runtime.currentState.sessionFile, sessionFile, "In-memory assigned paths remain available");
          if (state !== "saved") {
            internal.client = undefined;
            await internal.startClient();
            assert.equal(internal.client.options.sessionPath, undefined, "Reload does not restore an unwritten path");
          }
        }
      } finally {
        if (internal.client && !(internal.client instanceof PiRpcClient)) internal.client = undefined;
      }
    });
  });
}

test("a stale state refresh cannot change the stored restore pointer", async () => {
  await fixture(async ({ internal, writes, refresh }: any) => {
    internal.client = {
      isRunning: true,
      getState: async () => {
        internal.refreshRevision++;
        return { sessionFile: undefined };
      },
      getSessionStats: async () => ({}),
    };
    try {
      await refresh(false);
      assert.deepEqual(writes, []);
    } finally {
      internal.client = undefined;
    }
  });
});
