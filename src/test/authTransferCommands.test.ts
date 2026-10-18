import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type * as vscode from "vscode";
import type { HelperRequest } from "../isolatedPi";
import { resolveNativeAgentDirectory } from "../nativePiFiles";
import type { PiRuntimeManager } from "../piRuntime";
import { hashSessionEntries, validateSessionJsonl } from "../sessionTransfer";
import { installVscodeMock } from "./vscodeMock";

const mock = installVscodeMock();
mock.ProgressLocation = { Notification: 15 };
mock.CancellationTokenSource = class {
  token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
  cancel() {
    this.token.isCancellationRequested = true;
  }
  dispose() {}
};
const { registerProviderAuthentication } = require("../providerAuth") as typeof import("../providerAuth");
const { registerSessionTransfer } =
  require("../sessionTransferController") as typeof import("../sessionTransferController");
const helper = require("../isolatedPi") as typeof import("../isolatedPi");
const share = require("../sessionShare") as typeof import("../sessionShare");
afterAll(() => mock.restore());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "pi-transfer-command-"));
  const source = path.join(root, "source.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  const bytes = Buffer.from(
    [
      { type: "session", version: 3, id: "fixture", cwd: root, timestamp },
      {
        type: "message",
        id: "a",
        parentId: null,
        timestamp,
        message: { role: "user", content: "fixture-secret", timestamp: 0 },
      },
    ]
      .map((value) => JSON.stringify(value))
      .join("\n") + "\n",
  );
  await writeFile(source, bytes);
  const context = {
    subscriptions: [],
    extensionUri: mock.Uri.file(process.cwd()),
  } as unknown as vscode.ExtensionContext;
  let stale = false;
  let refreshed = 0;
  let switched = 0;
  const notices: string[] = [];
  const requests: HelperRequest[] = [];
  const checks = async () => {
    if (stale) throw new Error("Pi operation origin changed.");
  };
  const client = {
    getTree: async () => ({ entries: [], leafId: "a" }),
    getState: async () => ({ sessionFile: source, sessionId: "fixture" }),
    switchSession: async (_target: string) => {
      switched++;
      return { cancelled: true };
    },
    exportHtml: async (target: string) => {
      await writeFile(target, "<!doctype html><p>full Pi renderer</p>");
      return target;
    },
  };
  const runtime = {
    currentCwd: root,
    currentState: { sessionFile: source, sessionId: "fixture" },
    withWorkspaceOperation: async (_label: string, action: (check: () => Promise<void>) => Promise<void>) => {
      await checks();
      return action(checks);
    },
    withForegroundOperation: async (
      _label: string,
      action: (client: unknown, check: () => Promise<void>) => Promise<void>,
    ) => {
      await checks();
      return action(client, checks);
    },
    getSessionTransferSnapshot: async (_client: unknown, check: () => Promise<void>, expectedLeaf?: string | null) => {
      await check();
      assert.ok(expectedLeaf === undefined || expectedLeaf === "a");
      return {
        sessionDir: root,
        sessionFile: source,
        sessionId: "fixture",
        leafId: "a",
        entriesHash: hashSessionEntries(validateSessionJsonl(bytes).entries),
      };
    },
    activateImportedSession: async (_client: unknown, target: string) => {
      await client.switchSession(target);
      throw new Error("cancelled");
    },
  } as unknown as PiRuntimeManager;
  mock.window.withProgress = async (_options: unknown, action: any) =>
    action({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  mock.window.showWarningMessage = async (message: string) => {
    notices.push(message);
    return undefined;
  };
  mock.window.showInformationMessage = async (message: string) => {
    notices.push(message);
    return undefined;
  };
  mock.window.showQuickPick = async () => undefined;
  mock.window.showOpenDialog = async () => undefined;
  mock.window.showSaveDialog = async () => undefined;
  mock.env.remoteName = "ssh-remote";
  mock.workspace.workspaceFolders = [{ uri: mock.Uri.file(root) }];
  mock.workspace.getWorkspaceFolder = () => mock.workspace.workspaceFolders[0];
  vi.spyOn(helper, "runIsolatedPi").mockImplementation(async (_invocation, _helper, request) => {
    requests.push(request);
    if (request.operation === "discover")
      return { status: "providers", providers: [{ id: "fixture", methods: ["api_key", "oauth"] }] };
    if (request.operation === "export" || request.operation === "import") {
      await writeFile(request.output, bytes);
      return { status: "complete" };
    }
    return { status: "changed" };
  });
  const cleanup = async () => {
    for (const disposable of context.subscriptions) disposable.dispose();
    await rm(root, { recursive: true, force: true });
  };
  return {
    root,
    source,
    bytes,
    context,
    runtime,
    client,
    notices,
    requests,
    cleanup,
    stale: () => {
      stale = true;
    },
    refreshed: () => refreshed,
    switched: () => switched,
    imported: async () => {
      refreshed++;
    },
  };
}

test("registering native auth/transfer commands or opening metadata never authenticates", async () => {
  const f = await fixture();
  try {
    registerProviderAuthentication(f.context, f.runtime);
    registerSessionTransfer(f.context, f.runtime);
    assert.equal(f.requests.length, 0);
    assert.ok(mock.registrations.has("pi.signInProvider"));
    assert.ok(mock.registrations.has("pi.signOutProvider"));
    assert.ok(mock.registrations.has("pi.importSession"));
    assert.ok(mock.registrations.has("pi.exportSession"));
    assert.ok(mock.registrations.has("pi.shareSession"));
    mock.window.showQuickPick = async (items: any[]) => items[0];
    await mock.registrations.get("pi.signOutProvider")();
    assert.deepEqual(
      f.requests.map((value) => value.operation),
      ["discover"],
    );
    assert.ok(f.notices.some((value) => value.includes("remote Extension Host") && value.includes("does not revoke")));
  } finally {
    await f.cleanup();
  }
});
test("credential inputs use dedicated native masking, redirects remain complete and no secrets enter notices", async () => {
  const f = await fixture();
  try {
    registerProviderAuthentication(f.context, f.runtime);
    mock.window.showQuickPick = async (items: any[]) => items[0];
    mock.window.showWarningMessage = async (message: string) => {
      f.notices.push(message);
      return "Sign In";
    };
    mock.window.showInputBox = async (options: vscode.InputBoxOptions) => {
      assert.equal(options.password, true);
      return "fixture-secret";
    };
    vi.mocked(helper.runIsolatedPi).mockImplementation(async (_invocation, _helper, request, interaction) => {
      f.requests.push(request);
      if (request.operation === "discover")
        return { status: "providers", providers: [{ id: "fixture", methods: ["api_key"] }] };
      assert.ok(interaction);
      for (const kind of ["text", "secret", "manual_code"] as const)
        assert.equal(await interaction.prompt({ id: 1, kind }, new AbortController().signal), "fixture-secret");
      return { status: "changed-refresh-failed" };
    });
    await mock.registrations.get("pi.signInProvider")();
    assert.deepEqual(
      f.requests.map((value) => value.operation),
      ["discover", "login"],
    );
    assert.ok(f.notices.some((value) => value.includes("catalog refresh failed")));
    assert.ok(!JSON.stringify(f.notices).includes("fixture-secret"));
    assert.equal(f.refreshed(), 0, "auth must not replace the conversation");
  } finally {
    await f.cleanup();
  }
});
test("stale auth confirmation cannot write credentials or open a browser", async () => {
  const f = await fixture();
  try {
    registerProviderAuthentication(f.context, f.runtime);
    mock.window.showQuickPick = async (items: any[]) => items[0];
    mock.window.showWarningMessage = async () => {
      f.stale();
      return "Sign In";
    };
    await mock.registrations.get("pi.signInProvider")();
    assert.deepEqual(
      f.requests.map((value) => value.operation),
      ["discover"],
    );
  } finally {
    await f.cleanup();
  }
});
test("same-host provider operations serialize the selected Pi store across workspaces", async () => {
  const f = await fixture();
  try {
    registerProviderAuthentication(f.context, f.runtime);
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    vi.mocked(helper.runIsolatedPi).mockImplementation(async () => {
      entered?.();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { status: "providers", providers: [] };
    });
    const first = mock.registrations.get("pi.signInProvider")();
    await started;
    await mock.registrations.get("pi.signOutProvider")();
    assert.ok(f.notices.some((value) => value.includes("Another authentication operation")));
    release?.();
    await first;
  } finally {
    await f.cleanup();
  }
});
test("auth store uses Pi tilde expansion rather than a literal workspace tilde directory", () => {
  assert.equal(
    resolveNativeAgentDirectory("/fixture/workspace", { PI_CODING_AGENT_DIR: "~/custom" }, "/fixture/home"),
    path.resolve("/fixture/home/custom"),
  );
  assert.equal(
    resolveNativeAgentDirectory("/fixture/workspace", { PI_CODING_AGENT_DIR: "~" }, "/fixture/home"),
    path.resolve("/fixture/home"),
  );
});
test("relative auth store uses the selected workspace, not the Extension Host working directory", async () => {
  const f = await fixture();
  try {
    vi.stubEnv("PI_CODING_AGENT_DIR", "relative-auth-store");
    registerProviderAuthentication(f.context, f.runtime);
    await mock.registrations.get("pi.signInProvider")();
    assert.equal(f.requests[0]?.operation, "discover");
    assert.equal(
      f.requests[0] && "agentDir" in f.requests[0] ? f.requests[0].agentDir : undefined,
      path.join(f.root, "relative-auth-store"),
    );
  } finally {
    await f.cleanup();
  }
});
test("auth store alias retarget after approval rejects login against another store", async () => {
  const f = await fixture();
  try {
    const first = path.join(f.root, "first-store");
    const second = path.join(f.root, "second-store");
    const alias = path.join(f.root, "store-alias");
    await mkdir(first);
    await mkdir(second);
    await symlink(first, alias);
    vi.stubEnv("PI_CODING_AGENT_DIR", alias);
    registerProviderAuthentication(f.context, f.runtime);
    mock.window.showQuickPick = async (items: any[]) => items[0];
    mock.window.showWarningMessage = async () => {
      await unlink(alias);
      await symlink(second, alias);
      return "Sign In";
    };
    await mock.registrations.get("pi.signInProvider")();
    assert.deepEqual(
      f.requests.map((request) => request.operation),
      ["discover"],
    );
    assert.equal(f.requests[0] && "agentDir" in f.requests[0] ? f.requests[0].agentDir : undefined, first);
  } finally {
    await f.cleanup();
  }
});
test("metadata discovery has native cancellation before any credential operation", async () => {
  const f = await fixture();
  try {
    registerProviderAuthentication(f.context, f.runtime);
    mock.window.withProgress = async (_options: unknown, action: any) =>
      action({}, { isCancellationRequested: true, onCancellationRequested: () => ({ dispose() {} }) });
    vi.mocked(helper.runIsolatedPi).mockImplementation(async (_invocation, _helper, request, _interaction, signal) => {
      assert.equal(signal?.aborted, true);
      f.requests.push(request);
      return { status: "providers", providers: [] };
    });
    await mock.registrations.get("pi.signInProvider")();
    assert.deepEqual(
      f.requests.map((request) => request.operation),
      ["discover"],
    );
  } finally {
    await f.cleanup();
  }
});
test("cancelled local export selection writes nothing and launches no helper", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    mock.window.showQuickPick = async (items: any[]) => items[1];
    await mock.registrations.get("pi.exportSession")();
    assert.deepEqual(await readdir(f.root), ["source.jsonl"]);
    assert.deepEqual(f.requests, []);
  } finally {
    await f.cleanup();
  }
});
test("local active-branch export is exact and collision-safe; HTML keeps Pi's own renderer", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    const output = path.join(f.root, "export.jsonl");
    mock.window.showQuickPick = async (items: any[]) => items[1];
    mock.window.showSaveDialog = async () => mock.Uri.file(output);
    await mock.registrations.get("pi.exportSession")();
    assert.deepEqual(await readFile(output), f.bytes);
    await mock.registrations.get("pi.exportSession")();
    assert.deepEqual(await readFile(output), f.bytes);
    assert.ok(f.notices.some((value) => /EEXIST/.test(value)));
    mock.window.showQuickPick = async (items: any[]) => items[0];
    mock.window.showSaveDialog = async () => mock.Uri.file(path.join(f.root, "export.html"));
    await mock.registrations.get("pi.exportSession")();
    assert.equal(await readFile(path.join(f.root, "export.html"), "utf8"), "<!doctype html><p>full Pi renderer</p>");
  } finally {
    await f.cleanup();
  }
});
for (const operation of ["html", "jsonl", "import", "share", "failed-html"] as const) {
  test(`${operation} canonicalizes owned staging under an aliased TMPDIR and cleans it`, async () => {
    const f = await fixture();
    try {
      const physical = await realpath(f.root);
      const temporary = path.join(physical, "temporary");
      const alias = path.join(physical, "temporary-alias");
      await mkdir(temporary);
      await symlink(temporary, alias, "junction");
      vi.stubEnv(process.platform === "win32" ? "TEMP" : "TMPDIR", alias);
      const staged: string[] = [];
      vi.spyOn(f.client, "exportHtml").mockImplementation(async (output) => {
        staged.push(output);
        assert.equal(await realpath(path.dirname(output)), path.dirname(output));
        if (operation === "failed-html") throw new Error("fixture HTML failure");
        await writeFile(output, "<p>HTML fixture</p>");
        return output;
      });
      let inspected = "";
      let provider: vscode.TextDocumentContentProvider | undefined;
      mock.workspace.registerTextDocumentContentProvider = (
        _scheme: string,
        value: vscode.TextDocumentContentProvider,
      ) => {
        provider = value;
        return { dispose() {} };
      };
      mock.workspace.openTextDocument = async (uri: vscode.Uri) => ({
        uri,
        getText: () => provider?.provideTextDocumentContent(uri, {} as vscode.CancellationToken),
      });
      mock.window.showTextDocument = async (document: vscode.TextDocument) => {
        inspected = document.getText();
      };
      registerSessionTransfer(f.context, f.runtime);
      const output = path.join(
        physical,
        operation === "html" || operation === "failed-html" ? "export.html" : "export.jsonl",
      );
      mock.window.showSaveDialog = async () => mock.Uri.file(output);
      mock.window.showOpenDialog = async () => [mock.Uri.file(f.source)];
      let step = 0;
      mock.window.showQuickPick = async (items: any[]) =>
        operation === "share" ? (step++ < 2 ? items[0] : undefined) : items[operation === "jsonl" ? 1 : 0];
      mock.window.showWarningMessage = async (message: string) => {
        f.notices.push(message);
        return "Import Copy";
      };
      const upload = vi.spyOn(share, "uploadSessionGist");
      await mock.registrations.get(
        operation === "import" ? "pi.importSession" : operation === "share" ? "pi.shareSession" : "pi.exportSession",
      )();
      for (const request of f.requests) {
        if (request.operation === "export" || request.operation === "import")
          staged.push(request.input, request.output);
      }
      assert.ok(staged.length > 0, "the operation must reach its staging callback");
      for (const filename of staged) assert.ok(filename.startsWith(temporary + path.sep), filename);
      assert.deepEqual(await readdir(temporary), [], "owned staging must be removed after success or failure");
      assert.equal((await lstat(alias)).isSymbolicLink(), true, "cleanup must not remove the TMPDIR alias");
      assert.deepEqual(await readFile(f.source), f.bytes);
      if (operation === "html") assert.equal(await readFile(output, "utf8"), "<p>HTML fixture</p>");
      if (operation === "jsonl") assert.deepEqual(await readFile(output), f.bytes);
      if (operation === "import") {
        assert.equal(f.switched(), 1);
        assert.equal((await readdir(f.root)).filter((name) => name.startsWith("import-")).length, 1);
      }
      if (operation === "share") {
        assert.equal(inspected, f.bytes.toString());
        assert.equal(upload.mock.calls.length, 0);
      }
      if (operation === "failed-html") {
        assert.ok(f.notices.some((value) => value.includes("fixture HTML failure")));
        await assert.rejects(readFile(output), { code: "ENOENT" });
      }
    } finally {
      await f.cleanup();
    }
  });
}
test("cancelled import activation retains a unique copy and source, without clearing the old draft/history", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    mock.window.showOpenDialog = async () => [mock.Uri.file(f.source)];
    mock.window.showWarningMessage = async (message: string) => {
      f.notices.push(message);
      return "Import Copy";
    };
    await mock.registrations.get("pi.importSession")();
    const copies = (await readdir(f.root)).filter((name) => name.startsWith("import-"));
    assert.equal(copies.length, 1);
    assert.deepEqual(await readFile(path.join(f.root, copies[0] ?? "missing")), f.bytes);
    assert.deepEqual(await readFile(f.source), f.bytes);
    assert.equal(f.switched(), 1);
    assert.equal(f.refreshed(), 0);
    assert.ok(f.notices.some((value) => value.includes("copy remains at") && value.includes("no switch was retried")));
  } finally {
    await f.cleanup();
  }
});
test("stale import approval cannot copy or activate; unsafe Radius route stays blocked", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    mock.window.showOpenDialog = async () => [mock.Uri.file(f.source)];
    mock.window.showWarningMessage = async () => {
      f.stale();
      return "Import Copy";
    };
    await mock.registrations.get("pi.importSession")();
    assert.deepEqual(await readdir(f.root), ["source.jsonl"]);
    assert.equal(f.requests.length, 0);
  } finally {
    await f.cleanup();
  }
});
test("share inspection is exact/read-only/network-free; cancelled final approval cannot upload", async () => {
  const f = await fixture();
  try {
    let provider: vscode.TextDocumentContentProvider | undefined;
    let inspected = "";
    mock.workspace.registerTextDocumentContentProvider = (
      _scheme: string,
      value: vscode.TextDocumentContentProvider,
    ) => {
      provider = value;
      return { dispose() {} };
    };
    mock.workspace.openTextDocument = async (uri: vscode.Uri) => ({
      uri,
      getText: () => provider?.provideTextDocumentContent(uri, {} as vscode.CancellationToken),
    });
    mock.window.showTextDocument = async (document: vscode.TextDocument) => {
      inspected = document.getText();
    };
    registerSessionTransfer(f.context, f.runtime);
    let step = 0;
    mock.window.showQuickPick = async (items: any[]) => items[step++ === 0 ? 0 : step === 2 ? 0 : 2];
    const upload = vi.spyOn(share, "uploadSessionGist").mockResolvedValue("https://gist.github.com/fixture/abcd");
    await mock.registrations.get("pi.shareSession")();
    assert.equal(inspected, f.bytes.toString());
    assert.equal(upload.mock.calls.length, 0);
    assert.ok(
      f.notices.some((value) => value.includes("anyone with the link") && value.includes("thinking signatures")),
    );
  } finally {
    await f.cleanup();
  }
});
test("import into an externally resumed session uses Pi's configured directory, not the source dirname", async () => {
  const f = await fixture();
  try {
    const configured = path.join(f.root, "configured-sessions");
    await mkdir(configured);
    const query = f.runtime.getSessionTransferSnapshot.bind(f.runtime);
    vi.spyOn(f.runtime, "getSessionTransferSnapshot").mockImplementation(async (...args) => ({
      ...(await query(...args)),
      sessionDir: configured,
    }));
    registerSessionTransfer(f.context, f.runtime);
    mock.window.showOpenDialog = async () => [mock.Uri.file(f.source)];
    mock.window.showWarningMessage = async () => "Import Copy";
    await mock.registrations.get("pi.importSession")();
    assert.equal((await readdir(configured)).filter((name) => name.startsWith("import-")).length, 1);
    assert.equal((await readdir(f.root)).filter((name) => name.startsWith("import-")).length, 0);
    assert.equal(f.switched(), 1);
    assert.deepEqual(await readFile(f.source), f.bytes);
  } finally {
    await f.cleanup();
  }
});

test("same-leaf persisted body mismatch rejects export before SDK handoff", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    await writeFile(f.source, f.bytes.toString().replace("fixture-secret", "changed-body"));
    mock.window.showQuickPick = async (items: any[]) => items[1];
    mock.window.showSaveDialog = async () => mock.Uri.file(path.join(f.root, "export.jsonl"));
    await mock.registrations.get("pi.exportSession")();
    assert.equal(f.requests.length, 0);
    assert.ok(f.notices.some((message) => message.includes("does not match Pi's active entries")));
    assert.deepEqual(await readdir(f.root), ["source.jsonl"]);
  } finally {
    await f.cleanup();
  }
});

test("same-leaf in-memory change after upload approval rejects the inspected payload", async () => {
  const f = await fixture();
  try {
    const query = f.runtime.getSessionTransferSnapshot.bind(f.runtime);
    let changed = false;
    vi.spyOn(f.runtime, "getSessionTransferSnapshot").mockImplementation(async (...args) => {
      const snapshot = await query(...args);
      return changed ? { ...snapshot, entriesHash: "f".repeat(64) } : snapshot;
    });
    mock.workspace.registerTextDocumentContentProvider = () => ({ dispose() {} });
    mock.workspace.openTextDocument = async (uri: vscode.Uri) => ({ uri, getText: () => f.bytes.toString() });
    mock.window.showTextDocument = async () => {};
    registerSessionTransfer(f.context, f.runtime);
    let step = 0;
    mock.window.showQuickPick = async (items: any[]) => items[step++ === 0 ? 0 : step === 2 ? 0 : 2];
    mock.window.showWarningMessage = async (message: string) => {
      f.notices.push(message);
      changed = true;
      return "Upload Inspected Payload";
    };
    const upload = vi.spyOn(share, "uploadSessionGist");
    await mock.registrations.get("pi.shareSession")();
    assert.equal(upload.mock.calls.length, 0);
    assert.ok(f.notices.some((message) => message.includes("branch or source file changed")));
  } finally {
    await f.cleanup();
  }
});

test("Radius is an explicit blocked destination with no helper or upload request", async () => {
  const f = await fixture();
  try {
    registerSessionTransfer(f.context, f.runtime);
    mock.window.showQuickPick = async (items: any[]) => items[1];
    const upload = vi.spyOn(share, "uploadSessionGist");
    await mock.registrations.get("pi.shareSession")();
    assert.equal(upload.mock.calls.length, 0);
    assert.equal(f.requests.length, 0);
    assert.ok(f.notices.some((value) => value.includes("Radius sharing is blocked")));
  } finally {
    await f.cleanup();
  }
});
