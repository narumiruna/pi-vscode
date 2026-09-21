import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Uri } from "vscode";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { queryCodeContext, semanticAttachmentText } =
  require("../semanticContext") as typeof import("../semanticContext");
const range = (start = 0, end = start) => ({ start: { line: start, character: 0 }, end: { line: end, character: 1 } });
async function fixture(run: (root: string, uri: any, document: any) => Promise<void>, aliasRoot = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-semantic-"));
  const canonicalRoot = path.join(directory, "workspace");
  await mkdir(canonicalRoot);
  const root = aliasRoot ? path.join(directory, "alias") : canonicalRoot;
  if (aliasRoot) await symlink(canonicalRoot, root, "junction");
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
    await rm(directory, { recursive: true, force: true });
  }
}

test.each([false, true])("semantic targets and excerpts (workspace alias: %s)", async (aliasRoot) =>
  fixture(async (root, uri) => {
    const target = MockUri.file(path.join(root, "target.ts"));
    await writeFile(target.fsPath, "target");
    await symlink("/etc/passwd", path.join(root, "link"));
    await mkdir(path.join(root, "nested"));
    await writeFile(path.join(root, "nested", "target.ts"), "nested");
    await symlink(path.join(root, "nested"), path.join(root, "directory-link"), "junction");
    const commands: string[] = [];
    vscode.commands.executeCommand = async (command: string) => {
      commands.push(command);
      return [
        { uri: target, range: range(1) },
        { targetUri: target, targetRange: range(1), targetSelectionRange: range(1) },
        { uri: MockUri.file("/outside"), range: range() },
        { uri: MockUri.file(path.join(root, "link")), range: range() },
        { uri: MockUri.file(path.join(root, "directory-link", "target.ts")), range: range() },
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
    await assert.rejects(
      queryCodeContext(
        "definition",
        MockUri.file(path.join(root, "link")) as unknown as Uri,
        new vscode.Position(0, 0),
      ),
      /Symlink/,
    );
  }, aliasRoot),
);

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

test("semantic ranges sort by path then numeric start/end coordinates, independent of provider order", async () =>
  fixture(async (root, uri) => {
    const firstFile = MockUri.file(path.join(root, "a.ts"));
    await writeFile(firstFile.fsPath, "first file\n");
    const coordinates = [
      [0, 0, 0, 1],
      [2, 2, 2, 2],
      [2, 2, 2, 10],
      [2, 2, 2, 100],
      [2, 2, 10, 0],
      [2, 2, 100, 0],
      [2, 10, 2, 10],
      [2, 100, 2, 100],
      [10, 0, 10, 1],
      [100, 0, 100, 1],
    ] as const;
    const locations = coordinates.map(([startLine, startColumn, endLine, endColumn]) => ({
      uri,
      range: new vscode.Range(startLine, startColumn, endLine, endColumn),
    }));
    const values = [...locations, locations[0], { uri: firstFile, range: range(100) }];
    for (const providerOrder of [values, [...values].reverse()]) {
      vscode.commands.executeCommand = async () => providerOrder;
      const result = await queryCodeContext("references", uri, new vscode.Position(0, 0));
      assert.equal(result.truncated, false);
      assert.equal(result.items[0]?.path, "a.ts", "File path precedes coordinate ordering");
      assert.deepEqual(
        result.items
          .slice(1)
          .map(({ range: value }) => [value.start.line, value.start.column, value.end.line, value.end.column]),
        coordinates,
      );
    }
  }));

test("semantic result and excerpt limits retain the earliest numeric locations after deduplication", async () =>
  fixture(async (_root, uri) => {
    const values = Array.from({ length: 101 }, (_, line) => ({ uri, range: range(line) }));
    // The repeated early result must not displace another unique result from the budget.
    vscode.commands.executeCommand = async () => [...values].reverse().flatMap((value) => [value, value]);
    const result = await queryCodeContext("references", uri, new vscode.Position(0, 0));
    assert.equal(result.truncated, true);
    assert.deepEqual(
      result.items.map((item) => item.range.start.line),
      Array.from({ length: 50 }, (_, line) => line),
    );
    const attachment = await semanticAttachmentText(result);
    const headings = [...attachment.matchAll(/^source\.ts:(\d+) · document version 1$/gm)].map((match) =>
      Number(match[1]),
    );
    assert.deepEqual(
      headings,
      Array.from({ length: 20 }, (_, line) => line + 1),
    );
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

test.each([false, true])("authenticated semantic bridge (workspace alias: %s)", async (aliasRoot) =>
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
  }, aliasRoot),
);
