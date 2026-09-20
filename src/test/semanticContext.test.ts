import assert from "node:assert/strict";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { queryCodeContext, semanticAttachmentText } =
  require("../semanticContext") as typeof import("../semanticContext");
const range = (start = 0, end = start) => ({ start: { line: start, character: 0 }, end: { line: end, character: 1 } });
async function fixture(run: (root: string, uri: any, document: any) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "pi-semantic-"));
  const uri = MockUri.file(path.join(root, "source.ts"));
  const folder = { uri: MockUri.file(root), name: "Fixture" };
  const document = {
    uri,
    version: 1,
    isClosed: false,
    lineCount: 100,
    lineAt: () => ({ text: "source code" }),
    offsetAt: (position: any) => position.line * 12 + position.character,
    positionAt: (offset: number) => ({ line: Math.floor(offset / 12), character: offset % 12 }),
    getText: () => "source code\n",
  };
  await writeFile(uri.fsPath, "source code\n");
  vscode.workspace.isTrusted = true;
  vscode.workspace.getWorkspaceFolder = (target: any) =>
    target.scheme === "file" && target.fsPath.startsWith(`${root}${path.sep}`) ? folder : undefined;
  vscode.workspace.openTextDocument = async (target: any) => ({ ...document, uri: target });
  try {
    await run(root, uri, document);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("semantic context normalizes locations/links, deduplicates and excludes escaped results", async () =>
  fixture(async (root, uri) => {
    const target = MockUri.file(path.join(root, "target.ts"));
    await writeFile(target.fsPath, "target");
    await symlink("/etc/passwd", path.join(root, "link"));
    const commands: string[] = [];
    vscode.commands.executeCommand = async (command: string) => {
      commands.push(command);
      return [
        { uri: target, range: range(1) },
        { targetUri: target, targetRange: range(1), targetSelectionRange: range(1) },
        { uri: MockUri.file("/outside"), range: range() },
        { uri: MockUri.file(path.join(root, "link")), range: range() },
        { uri: target, range: { start: { line: -1, character: 0 }, end: { line: 2, character: 0 } } },
      ];
    };
    const result = await queryCodeContext("definition", uri, new vscode.Position(0, 0));
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.path, "target.ts");
    assert.equal(commands[0], "vscode.executeDefinitionProvider");
    assert.doesNotMatch(JSON.stringify(result), /source code/);
    assert.match(await semanticAttachmentText(result), /source code/);
    const refs = await queryCodeContext("references", uri, new vscode.Position(0, 0));
    assert.equal(refs.items.length, 1);
    assert.equal(commands.at(-1), "vscode.executeReferenceProvider");
  }));

test("semantic context supports hierarchical and flat symbols, call directions, result bounds and no provider", async () =>
  fixture(async (_root, uri) => {
    const child = { name: "child", kind: 11, range: range(1), selectionRange: range(1) };
    vscode.commands.executeCommand = async () => [
      { name: "parent", kind: 4, range: range(0, 2), children: [child] },
      { name: "flat", kind: 11, location: { uri, range: range(3) } },
    ];
    const symbols = await queryCodeContext("documentSymbols", uri, new vscode.Position(0, 0));
    assert.deepEqual(
      symbols.items.map((item) => item.name),
      ["parent", "child", "flat"],
    );
    const calls: string[] = [];
    vscode.commands.executeCommand = async (command: string) => {
      calls.push(command);
      return command === "vscode.prepareCallHierarchy"
        ? [{ uri, name: "root", range: range() }]
        : [
            {
              from: { uri, name: "caller", range: range(1) },
              to: { uri, name: "callee", range: range(2) },
              fromRanges: [range(3)],
            },
          ];
    };
    assert.equal((await queryCodeContext("callers", uri, new vscode.Position(0, 0))).items[0]?.name, "caller");
    assert.equal((await queryCodeContext("callees", uri, new vscode.Position(0, 0))).items[0]?.name, "callee");
    assert.ok(calls.includes("vscode.provideIncomingCalls"));
    assert.ok(calls.includes("vscode.provideOutgoingCalls"));
    vscode.commands.executeCommand = async () =>
      Array.from({ length: 51 }, (_, index) => ({ uri, range: range(index) }));
    const bounded = await queryCodeContext("references", uri, new vscode.Position(0, 0));
    assert.equal(bounded.items.length, 50);
    assert.equal(bounded.truncated, true);
    vscode.commands.executeCommand = async () => undefined;
    assert.equal((await queryCodeContext("references", uri, new vscode.Position(0, 0))).items.length, 0);
  }));

test("semantic context trust, positions, cancellation and provider errors fail without guessing", async () =>
  fixture(async (_root, uri) => {
    let calls = 0;
    vscode.commands.executeCommand = async () => {
      calls++;
      throw new Error("provider failed");
    };
    vscode.workspace.isTrusted = false;
    await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(0, 0)), /trusted/);
    vscode.workspace.isTrusted = true;
    await assert.rejects(
      queryCodeContext("definition", new MockUri("virtual", "/source") as any, new vscode.Position(0, 0)),
      /virtual/,
    );
    await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(-1, 0)), /position/);
    await assert.rejects(
      queryCodeContext("definition", uri, new vscode.Position(0, 0), { isCancellationRequested: true } as any),
      /cancelled/,
    );
    assert.equal(calls, 0);
    await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(0, 0)), /provider failed/);
  }));

test("semantic context cancels an outstanding provider call and rejects changed source versions", async () =>
  fixture(async (_root, uri, document) => {
    let cancel: (() => void) | undefined;
    let started!: () => void;
    let finish!: (value: unknown) => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vscode.commands.executeCommand = () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const request = queryCodeContext("definition", uri, new vscode.Position(0, 0), {
      isCancellationRequested: false,
      onCancellationRequested: (callback: () => void) => {
        cancel = callback;
        return { dispose() {} };
      },
    } as any);
    await began;
    cancel?.();
    await assert.rejects(request, /cancelled/);
    finish([]);
    vscode.workspace.openTextDocument = async () => document;
    vscode.commands.executeCommand = async () => {
      document.version++;
      return [{ uri, range: range() }];
    };
    await assert.rejects(queryCodeContext("definition", uri, new vscode.Position(0, 0)), /changed/);
  }));

test("semantic provider deadline settles once and releases cancellation listeners", async () =>
  fixture(async (_root, uri) => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let started!: () => void;
    let finish!: (value: unknown) => void;
    let disposed = 0;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    vscode.commands.executeCommand = () => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    try {
      const request = queryCodeContext("definition", uri, new vscode.Position(0, 0), {
        isCancellationRequested: false,
        onCancellationRequested: () => ({
          dispose: () => {
            disposed++;
          },
        }),
      } as any);
      const rejection = assert.rejects(request, /timed out/);
      await began;
      await vi.advanceTimersByTimeAsync(5_000);
      await rejection;
      finish([]);
      await Promise.resolve();
      assert.equal(disposed, 1);
      assert.equal(vi.getTimerCount(), 0);
    } finally {
      vi.useRealTimers();
    }
  }));

test("semantic attachments remain inspectable snapshots, respect aggregate bounds and consume only accepted items", async () =>
  fixture(async (_root, uri, document) => {
    vscode.ProgressLocation = { Notification: 1 };
    vscode.window.activeTextEditor = { document, selection: { active: new vscode.Position(0, 0) } };
    vscode.window.withProgress = async (_options: unknown, fn: any) =>
      fn({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
    vscode.commands.executeCommand = async () => [{ uri, range: range() }];
    const notices: string[] = [];
    const { SidebarAttachmentManager } = require("../sidebarAttachments") as typeof import("../sidebarAttachments");
    const manager = new SidebarAttachmentManager({
      maxAttachments: 8,
      maxImageAttachments: 5,
      maxImageBytes: 5 * 1024 * 1024,
      maxAttachedCharacters: 80,
      maxTotalContextCharacters: 100,
      imageAssets: {} as any,
      onChange: () => {},
      onNotice: (message) => notices.push(message),
    });
    try {
      await manager.attachSemanticContext("definition");
      assert.equal(manager.values.length, 1);
      assert.match(manager.values[0]!.label, /Definition/);
      assert.ok(manager.values[0]!.content!.length <= 80);
      assert.ok(notices.some((message) => /truncated/.test(message)));
      assert.equal(
        manager.values[0]!.metadata?.sourceVersion,
        undefined,
        "aggregate context cannot refresh from just its source file",
      );
      const accepted = manager.captureSubmission();
      await manager.attachSemanticContext("references");
      assert.ok(manager.textContexts.reduce((sum, item) => sum + item.content.length, 0) <= 100);
      accepted.consumeAccepted();
      assert.equal(manager.values.length, 1);
      assert.match(manager.values[0]!.label, /References/);
    } finally {
      manager.dispose();
    }
  }));

test("authenticated bridge codeContext returns metadata and rejects invalid targets/operations/positions", async () =>
  fixture(async (_root, uri) => {
    const { VscodeBridgeServer } = require("../vscodeBridge") as typeof import("../vscodeBridge");
    const bridge = new VscodeBridgeServer();
    const env = await bridge.start();
    vscode.commands.executeCommand = async () => [{ uri, range: range() }];
    const request = (params: unknown, token = env.PICODE_BRIDGE_TOKEN) =>
      new Promise<any>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port: Number(env.PICODE_BRIDGE_PORT) });
        let output = "";
        socket.on("connect", () =>
          socket.write(JSON.stringify({ id: "test", token, method: "codeContext", params }) + "\n"),
        );
        socket.on("data", (chunk) => {
          output += chunk;
        });
        socket.on("end", () => resolve(JSON.parse(output)));
        socket.on("error", reject);
      });
    try {
      const result = await request({ path: uri.fsPath, operation: "definition" });
      assert.equal(result.ok, true);
      assert.equal(result.result.items.length, 1);
      assert.doesNotMatch(JSON.stringify(result), /source code/);
      assert.equal((await request({ path: uri.fsPath, operation: "definition" }, "bad")).ok, false);
      for (const params of [
        { path: uri.fsPath, operation: "execute" },
        { path: "/outside", operation: "references" },
        { path: uri.fsPath, operation: "references", line: -1 },
      ])
        assert.equal((await request(params)).ok, false);
      vscode.workspace.isTrusted = false;
      assert.equal((await request({ path: uri.fsPath, operation: "definition" })).ok, false);
    } finally {
      bridge.dispose();
    }
  }));
