import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import vm from "node:vm";
import { transformSync } from "esbuild";
import type { PiRpcClient, PiRpcEvent } from "../piRpcClient";
import type { PiRuntimeState } from "../piRuntime";
import { installVscodeMock } from "./vscodeMock";

const mock = installVscodeMock();
const { PiRuntimeControl } = require("../piRuntimeControl") as typeof import("../piRuntimeControl");
afterAll(() => mock.restore());
const compiled = transformSync(readFileSync(path.resolve("resources/pi-control.ts"), "utf8"), {
  loader: "ts",
  format: "cjs",
  target: "es2022",
}).code;

async function fixture(saved = true) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-snapshot-")));
  const sessionDir = path.join(root, "configured-sessions");
  await mkdir(sessionDir);
  const sessionFile = path.join(root, "external.jsonl");
  if (saved) await writeFile(sessionFile, "fixture");
  const entries = [
    {
      type: "custom",
      id: "a",
      parentId: null,
      timestamp: "2026-01-01T00:00:00.000Z",
      customType: "fixture",
      data: "not returned in RPC",
    },
  ];
  let handler: ((args: string, ctx: unknown) => Promise<void>) | undefined;
  const module = { exports: {} as { default: (pi: unknown) => void } };
  vm.runInNewContext(compiled, { module, exports: module.exports, require, Buffer });
  module.exports.default({
    registerCommand: (_name: string, options: any) => {
      handler = options.handler;
    },
  });
  assert.ok(handler);
  const events = new Set<(event: PiRpcEvent) => void>();
  const state = { connected: true, sessionId: "fixture", sessionFile, busy: false } as PiRuntimeState;
  let resets = 0;
  let stops = 0;
  let prompts = 0;
  let wrongToken = false;
  let malformed = false;
  let disposition = "handled";
  const client = {
    isRunning: true,
    getCommands: async () =>
      [
        ["vscode-pi-control", "pi-control.ts"],
        ["vscode-pi-bridge-ready", "pi-bridge.ts"],
        ["vscode-pi-read-only-ready", "pi-read-only-gate.ts"],
      ].map(([name, file]) => ({
        name,
        source: "extension",
        sourceInfo: { path: path.resolve("resources", file), origin: "cli" },
      })),
    onEvent: (callback: (event: PiRpcEvent) => void) => {
      events.add(callback);
      return { dispose: () => events.delete(callback) };
    },
    prompt: async (prompt: string) => {
      prompts++;
      const args = prompt.slice(prompt.indexOf(" ") + 1);
      await handler!(args, {
        cwd: root,
        isIdle: () => true,
        sessionManager: {
          getSessionId: () => "fixture",
          getSessionFile: () => sessionFile,
          getSessionDir: () => sessionDir,
          getLeafId: () => "a",
          getEntries: () => entries,
        },
        ui: {
          notify: (message: string) => {
            assert.ok(Buffer.byteLength(message) <= 16_384);
            assert.ok(!message.includes("not returned in RPC"));
            if (wrongToken) message = message.replace(JSON.parse(args).token, "wrong-token");
            if (malformed) message = message.replace(/[a-f0-9]{64}/, "bad-hash");
            for (const event of events) event({ type: "extension_ui_request", method: "notify", message });
          },
        },
      });
      return disposition;
    },
    stop: async () => {
      stops++;
    },
  } as unknown as PiRpcClient;
  const control = new PiRuntimeControl({
    context: { extensionUri: mock.Uri.file(process.cwd()) } as any,
    cwd: root,
    resource: mock.Uri.file(root),
    state,
    client,
    hasPendingDialogs: false,
    queuePending: false,
    owned: async (action) => action(),
    start: async () => {},
    startSession: async () => {},
    stop: async () => {},
    refresh: async () => {},
    emit: () => {
      resets++;
    },
    resetUi: () => {
      resets++;
    },
    terminalOptions: async () => ({ executablePath: "unused", cwd: root }),
  });
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(root) }];
  mock.workspace.getWorkspaceFolder = () => mock.workspace.workspaceFolders[0];
  mock.workspace.isTrusted = true;
  return {
    root,
    sessionDir,
    sessionFile,
    entries,
    client,
    control,
    check: async () => {},
    stops: () => stops,
    resets: () => resets,
    prompts: () => prompts,
    wrongToken: () => {
      wrongToken = true;
    },
    malformed: () => {
      malformed = true;
    },
    fallback: () => {
      disposition = "started";
    },
    cleanup: async () => {
      control.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("read-only snapshot uses authoritative configured directory, bounded digest and no UI invalidation", async () => {
  const f = await fixture();
  try {
    const snapshot = await f.control.getSessionTransferSnapshot(f.client, f.check, "a");
    assert.equal(snapshot.sessionDir, f.sessionDir);
    assert.notEqual(snapshot.sessionDir, path.dirname(f.sessionFile));
    const expectedHash = createHash("sha256")
      .update(f.entries.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
      .digest("hex");
    assert.equal(snapshot.entriesHash, expectedHash);
    assert.equal(snapshot.sessionFile, f.sessionFile);
    assert.equal(f.resets(), 0);
    assert.equal(f.stops(), 0);
    const changed = structuredClone(f.entries);
    changed[0]!.data = "different in-memory body at same leaf";
    assert.notEqual(
      createHash("sha256")
        .update(changed.map((entry) => `${JSON.stringify(entry)}\n`).join(""))
        .digest("hex"),
      snapshot.entriesHash,
    );
  } finally {
    await f.cleanup();
  }
});
test("read-only import location is available before Pi writes its assigned session file", async () => {
  const f = await fixture(false);
  try {
    const snapshot = await f.control.getSessionTransferSnapshot(f.client, f.check, "a");
    assert.equal(snapshot.sessionFile, f.sessionFile);
    assert.equal(snapshot.sessionDir, f.sessionDir);
    await assert.rejects(realpath(f.sessionFile), (error: NodeJS.ErrnoException) => error.code === "ENOENT");
    assert.equal(f.stops(), 0);
    assert.equal(f.resets(), 0);
  } finally {
    await f.cleanup();
  }
});

for (const mode of ["wrongToken", "malformed", "fallback"] as const) {
  test(`snapshot ${mode} fails closed without replay`, async () => {
    const f = await fixture();
    try {
      f[mode]();
      await assert.rejects(f.control.getSessionTransferSnapshot(f.client, f.check), /uncertain/);
      assert.equal(f.prompts(), 1);
      assert.equal(f.stops(), 1);
      assert.equal(f.resets(), 0);
    } finally {
      await f.cleanup();
    }
  });
}
for (const mode of ["missing", "shadowed"] as const) {
  test(`snapshot ${mode} command metadata rejects before prompt dispatch`, async () => {
    const f = await fixture();
    try {
      const commands = await f.client.getCommands();
      const getCommands = vi.spyOn(f.client, "getCommands").mockResolvedValue(
        mode === "missing"
          ? []
          : commands.map((command) => ({
              ...(command as Record<string, unknown>),
              sourceInfo: { path: path.resolve("README.md") },
            })),
      );
      try {
        await assert.rejects(f.control.getSessionTransferSnapshot(f.client, f.check), /Unsupported Pi control route/);
        assert.equal(f.prompts(), 0);
        assert.equal(f.stops(), 0);
        assert.equal(f.resets(), 0);
      } finally {
        getCommands.mockRestore();
      }
    } finally {
      await f.cleanup();
    }
  });
}

test("packaged entry digest rejects excessive count and serialized bytes without a response", async () => {
  const f = await fixture();
  try {
    const original = f.entries[0];
    assert.ok(original);
    f.entries.push(...Array(50_000).fill(original));
    await assert.rejects(f.control.getSessionTransferSnapshot(f.client, f.check), /50,000/);
    f.entries.splice(0, f.entries.length, ...Array(33).fill({ ...original, data: "x".repeat(1024 * 1024) }));
    await assert.rejects(f.control.getSessionTransferSnapshot(f.client, f.check), /32 MiB/);
    assert.equal(f.resets(), 0);
  } finally {
    await f.cleanup();
  }
});
