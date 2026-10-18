import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { composerFileToken, isFileCompletionMessage } from "../composerFileToken";
import { ImageAssetCache } from "../imageAssets";
import { installVscodeMock, MockUri } from "./vscodeMock";

const token = (text: string, cursor = text.length, end = cursor, composing = false) =>
  composerFileToken(text, cursor, end, composing);

test("file token grammar covers cursor, selection, quotes, punctuation, multiline, Unicode and separators", () => {
  assert.deepEqual(token("Read @src/file.ts now", 9), {
    kind: "attachment",
    start: 5,
    end: 17,
    cursor: 9,
    query: "src",
  });
  assert.equal(token("@src/file.ts", 5, 7), undefined);
  assert.equal(token('Read @"some path/日本.ts"')?.query, "some path/日本.ts");
  assert.equal(token("Read './some path/a.ts'")?.kind, "path");
  assert.equal(token("text\n(@src/a.ts, more", 15)?.query, "src/a.ts");
  assert.equal(token(".\\src\\file.ts")?.query, "src/file.ts");
  assert.equal(token("./README")?.kind, "path");
  assert.equal(token("@")?.query, "");
  assert.equal(token("Use @src/日本.ts")?.query, "src/日本.ts");
});

test("literal at signs, email, shell, slash commands, IME, absolute paths and traversal do not complete", () => {
  for (const text of [
    "mail@example.com",
    "@@literal",
    "\\@literal",
    "literal",
    "/compact",
    "/skill:x @file",
    "!cat ./file",
    "!!cat @file",
    "@../file",
    "@/etc/passwd",
    "@C:\\file",
    "@a\0b",
    "@" + "x".repeat(257),
  ])
    assert.equal(token(text), undefined, text);
  assert.equal(token("@file", 5, 5, true), undefined);
  assert.equal(token("@file", -1), undefined);
  assert.equal(token("@file", 100), undefined);
});

test("completion protocol rejects forged ranges, IDs, revisions and malformed payloads", () => {
  const query = { type: "fileCompletionQuery", id: 1, revision: 2, text: "@file", token: token("@file") };
  assert.equal(isFileCompletionMessage(query), true);
  for (const change of [
    { id: NaN },
    { revision: -1 },
    { token: { ...query.token, start: 1 } },
    { text: "x".repeat(100_001) },
    { token: null },
  ])
    assert.equal(isFileCompletionMessage({ ...query, ...change }), false);
  assert.equal(
    isFileCompletionMessage({ type: "fileCompletionSelect", id: 1, revision: 0, candidateId: "../../secret" }),
    false,
  );
});

async function fixture(alias = false) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-completion-"));
  const root = path.join(directory, "root");
  await mkdir(root);
  const opened = alias ? path.join(directory, "alias") : root;
  if (alias) await symlink(root, opened, "junction");
  const vscode = installVscodeMock();
  vscode.CancellationTokenSource = class {
    token = { isCancellationRequested: false };
    cancel() {
      this.token.isCancellationRequested = true;
    }
    dispose() {}
  };
  vscode.RelativePattern = class {
    constructor(
      public base: unknown,
      public pattern: string,
    ) {}
  };
  const folder = { uri: MockUri.file(opened), name: "fixture", index: 0 };
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.getWorkspaceFolder = () => folder;
  const found: MockUri[] = [];
  const searches: any[] = [];
  vscode.workspace.findFiles = async (...args: any[]) => {
    searches.push(args);
    return found;
  };
  vscode.workspace.openTextDocument = async (uri: MockUri) => ({
    uri,
    version: 1,
    isDirty: false,
    eol: 1,
    getText: () => "source\n",
  });
  for (const module of [
    "../sidebarFileCompletion",
    "../sidebarAttachments",
    "../sidebarHelpers",
    "../workflowUi",
    "../configuration",
  ])
    delete require.cache[require.resolve(module)];
  const { SidebarAttachmentManager } = require("../sidebarAttachments") as typeof import("../sidebarAttachments");
  const { SidebarFileCompletion, fileCompletionLimits } =
    require("../sidebarFileCompletion") as typeof import("../sidebarFileCompletion");
  const notices: string[] = [];
  const attachments = new SidebarAttachmentManager({
    maxAttachments: 8,
    maxImageAttachments: 5,
    maxImageBytes: 1024,
    maxAttachedCharacters: 200_000,
    maxTotalContextCharacters: 400_000,
    imageAssets: new ImageAssetCache({ maxImageBytes: 1024, maxTotalBytes: 1024, maxAssets: 1 }),
    onChange: () => {},
    onNotice: (message) => notices.push(message),
  });
  let session = "session-1";
  const posted: any[] = [];
  const manager = new SidebarFileCompletion({
    cwd: () => opened,
    session: () => session,
    attachments,
    post: (message) => posted.push(message),
  });
  const add = async (relative: string, content: string | Buffer = "source\n") => {
    await mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await writeFile(path.join(root, relative), content);
    const uri = MockUri.file(path.join(opened, relative));
    found.push(uri);
    return uri;
  };
  const query = async (text = "@", id = 1) => {
    const parsed = token(text);
    assert.ok(parsed);
    await manager.handle({ type: "fileCompletionQuery", id, revision: id, text, token: parsed });
    return [...posted].reverse().find((item) => item.type === "fileCompletionResults" && item.id === id);
  };
  const select = async (result: any, candidateId = result.candidates[0]?.id) =>
    manager.handle({ type: "fileCompletionSelect", id: result.id, revision: result.revision, candidateId });
  const cleanup = async () => {
    manager.dispose();
    attachments.dispose();
    vscode.restore();
    await rm(directory, { recursive: true, force: true });
  };
  return {
    root,
    opened,
    directory,
    vscode,
    found,
    searches,
    notices,
    attachments,
    manager,
    posted,
    add,
    query,
    select,
    cleanup,
    limits: fileCompletionLimits,
    switchSession: () => {
      session = "session-2";
    },
  };
}

test("discovery has fixed bounds, configured exclusions, deterministic ordering and host-owned IDs", async () => {
  const f = await fixture();
  try {
    for (let index = 34; index >= 0; index--) await f.add(`src/file-${String(index).padStart(2, "0")}.ts`);
    f.found.push(MockUri.from({ scheme: "vscode-remote", path: path.join(f.root, "remote.ts") }));
    const result = await f.query();
    assert.equal(result.candidates.length, 30);
    assert.deepEqual(
      result.candidates.map((item: any) => item.path),
      [...result.candidates.map((item: any) => item.path)].sort(),
    );
    assert.equal(new Set(result.candidates.map((item: any) => item.id)).size, 30);
    assert.equal(f.searches[0][2], 2_000);
    assert.match(f.searches[0][1], /node_modules.*coverage/);
    assert.equal(f.attachments.values.length, 0);
    await f.select(result, "00000000-0000-4000-8000-000000000000");
    assert.equal(f.attachments.values.length, 0);
    assert.ok(f.posted.some((item) => item.type === "fileCompletionFailed"));
  } finally {
    await f.cleanup();
  }
});

test("workspace alias capture uses dirty editor snapshot, warns for sensitive names, and sends it only once", async () => {
  const f = await fixture(true);
  try {
    const uri = await f.add(".env");
    const doc = { uri, version: 7, isDirty: true, getText: () => "SECRET=edited locally" };
    f.vscode.workspace.textDocuments = [doc];
    f.vscode.workspace.openTextDocument = async () => {
      throw new Error("Dirty document must not reopen");
    };
    const result = await f.query("@.env");
    await f.select(result);
    assert.equal(f.attachments.values[0]?.content, "SECRET=edited locally");
    assert.equal(f.attachments.values[0]?.metadata?.sourceVersion, 7);
    assert.match(f.notices.join("\n"), /sensitive|secret/i);
    await f.select(result);
    assert.equal(f.attachments.values.length, 1);
    const snapshot = f.attachments.captureSubmission();
    assert.equal(snapshot.textContexts[0]?.content, "SECRET=edited locally");
    snapshot.consumeAccepted();
    assert.equal(f.attachments.values.length, 0);
    assert.equal(snapshot.textContexts.length, 1);
  } finally {
    await f.cleanup();
  }
});

test("Tab path selection inserts spaces safely and never opens or attaches content", async () => {
  const f = await fixture();
  try {
    await f.add("src/some path.ts");
    f.vscode.workspace.openTextDocument = async () => {
      throw new Error("Path-only insertion must not open files");
    };
    const result = await f.query("./src/");
    await f.select(result);
    assert.equal(f.attachments.values.length, 0);
    assert.equal(f.posted.find((item) => item.type === "fileCompletionApplied")?.replacement, '"src/some path.ts"');
  } finally {
    await f.cleanup();
  }
});

test("normal capture opens current editor text and rejects binary, oversized and mismatched disk content atomically", async () => {
  const f = await fixture();
  try {
    await f.add("good.ts");
    await f.select(await f.query("@good"));
    assert.equal(f.attachments.values.length, 1);
    for (const [name, content] of [
      ["binary", Buffer.from([0, 1, 2])],
      ["oversized", "x".repeat(800_004)],
      ["mismatch", "not source"],
    ] as const) {
      await f.add(name, content);
      await f.select(await f.query(`@${name}`));
      assert.equal(f.attachments.values.length, 1, name);
    }
  } finally {
    await f.cleanup();
  }
});

test("cancellation, newer queries, root changes, nested symlinks and session switches reject stale candidates", async () => {
  const f = await fixture();
  try {
    await f.add("file.ts");
    await writeFile(path.join(f.directory, "outside.ts"), "source\n");
    await symlink(path.join(f.directory, "outside.ts"), path.join(f.root, "linked.ts"));
    f.found.push(MockUri.file(path.join(f.root, "linked.ts")), MockUri.file(path.join(f.directory, "outside.ts")));
    const result = await f.query();
    assert.equal(result.candidates.length, 1);
    await f.manager.handle({ type: "fileCompletionCancel" });
    await f.select(result);
    assert.equal(f.attachments.values.length, 0);
    const second = await f.query("@file", 2);
    f.switchSession();
    await f.select(second);
    assert.equal(f.attachments.values.length, 0);
    const third = await f.query("@file", 3);
    await rm(path.join(f.root, "file.ts"));
    await symlink(path.join(f.directory, "outside.ts"), path.join(f.root, "file.ts"));
    await f.select(third);
    assert.equal(f.attachments.values.length, 0);
  } finally {
    await f.cleanup();
  }
});

test("draft edits during asynchronous opening leave attachment state unchanged", async () => {
  const f = await fixture();
  try {
    await f.add("file.ts");
    let resume: (() => void) | undefined;
    let opened: (() => void) | undefined;
    const opening = new Promise<void>((resolve) => {
      opened = resolve;
    });
    f.vscode.workspace.openTextDocument = async (uri: MockUri) => {
      opened?.();
      await new Promise<void>((resolve) => {
        resume = resolve;
      });
      return { uri, version: 1, getText: () => "source\n" };
    };
    const result = await f.query("@file");
    const selecting = f.select(result);
    await opening;
    await f.manager.handle({ type: "fileCompletionCancel" });
    resume?.();
    await selecting;
    assert.equal(f.attachments.values.length, 0);
    assert.equal(f.posted.filter((item) => item.type === "fileCompletionApplied").length, 0);
  } finally {
    await f.cleanup();
  }
});

test("late discovery is cancelled and cannot replace the newest results", async () => {
  const f = await fixture();
  try {
    await f.add("file.ts");
    let resume: ((uris: MockUri[]) => void) | undefined;
    let searched: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      searched = resolve;
    });
    f.vscode.workspace.findFiles = async () => {
      searched?.();
      return new Promise((resolve) => {
        resume = resolve;
      });
    };
    const pending = f.query("@", 1);
    await started;
    f.vscode.workspace.findFiles = async () => f.found;
    const current = await f.query("@file", 2);
    assert.equal(current.candidates.length, 1);
    resume?.(f.found);
    await pending;
    assert.equal(f.posted.filter((item) => item.type === "fileCompletionResults").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("query deadline cancels search and late API replies cannot post results", async () => {
  const f = await fixture();
  try {
    let searchToken: { isCancellationRequested: boolean } | undefined;
    let finish: ((uris: MockUri[]) => void) | undefined;
    f.vscode.workspace.findFiles = async (
      _include: unknown,
      _exclude: unknown,
      _max: number,
      cancellation: typeof searchToken,
    ) => {
      searchToken = cancellation;
      return new Promise((resolve) => {
        finish = resolve;
      });
    };
    const result = await f.query();
    assert.deepEqual(result.candidates, []);
    assert.equal(searchToken?.isCancellationRequested, true);
    finish?.([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.posted.filter((item) => item.type === "fileCompletionResults").length, 1);
    assert.equal(f.limits.deadlineMs, 2_000);
  } finally {
    await f.cleanup();
  }
});

test("dirty versions, retargeted root aliases and nested parent swaps fail before attachment mutation", async () => {
  const f = await fixture(true);
  try {
    const uri = await f.add("dir/file.ts");
    const candidate = {
      id: "candidate",
      path: "dir/file.ts",
      uri,
      root: f.root,
      folder: f.vscode.workspace.workspaceFolders[0],
    };
    const dirty = { uri, version: 1, isDirty: true, getText: () => "dirty text" };
    f.vscode.workspace.textDocuments = [dirty];
    let checks = 0;
    await assert.rejects(
      f.attachments.attachCompletion(candidate as any, async () => {
        if (++checks === 2) dirty.version++;
      }),
      /changed/,
    );
    assert.equal(f.attachments.values.length, 0);
    f.vscode.workspace.textDocuments = [];
    f.vscode.workspace.openTextDocument = async () => {
      await rm(path.join(f.root, "dir"), { recursive: true });
      await mkdir(path.join(f.directory, "outside"));
      await writeFile(path.join(f.directory, "outside", "file.ts"), "source\n");
      await symlink(path.join(f.directory, "outside"), path.join(f.root, "dir"), "junction");
      return { uri, version: 1, getText: () => "source\n" };
    };
    const result = await f.query("@dir");
    await f.select(result);
    assert.equal(f.attachments.values.length, 0);
    await rm(f.opened);
    await symlink(path.join(f.directory, "outside"), f.opened, "junction");
    await assert.rejects(
      f.attachments.attachCompletion(candidate as any, async () => {
        const { validateCompletionCandidate } =
          require("../sidebarFileCompletion") as typeof import("../sidebarFileCompletion");
        await validateCompletionCandidate(candidate as any);
      }),
      /changed/,
    );
  } finally {
    await f.cleanup();
  }
});

test("selection is single-use, attachment bounds are atomic, and search configuration is explicit", async () => {
  const f = await fixture();
  try {
    const { isWebviewMessage } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    assert.equal(
      isWebviewMessage({ type: "fileCompletionQuery", id: 1, revision: 0, text: "@", token: token("@") }, 100),
      true,
    );
    assert.equal(
      isWebviewMessage(
        { type: "fileCompletionQuery", id: 1, revision: 0, text: "@", token: { ...token("@"), cursor: 2 } },
        100,
      ),
      false,
    );
    f.vscode.workspace.getConfiguration = (section: string) => ({
      get: (_key: string, fallback: unknown) =>
        section === "search" ? { "**/ignored/**": true, "**/keep/**": false } : fallback,
    });
    await f.add("file.ts");
    const result = await f.query("@file");
    assert.match(f.searches[0][1], /ignored/);
    assert.doesNotMatch(f.searches[0][1], /keep/);
    await Promise.all([f.select(result), f.select(result)]);
    assert.equal(f.attachments.values.length, 1);
    assert.equal(f.posted.filter((item) => item.type === "fileCompletionApplied").length, 1);
    for (let index = 0; index < 7; index++) {
      f.vscode.window.activeTextEditor = {
        document: { uri: MockUri.file(path.join(f.root, `extra-${index}`)), version: 1, getText: () => "text" },
      };
      await f.attachments.attachCurrentFile();
    }
    await f.add("ninth.ts");
    await f.select(await f.query("@ninth", 2));
    assert.equal(f.attachments.values.length, 8);
    assert.equal(f.posted.filter((item) => item.type === "fileCompletionApplied").length, 1);
  } finally {
    await f.cleanup();
  }
});

test("untrusted and virtual workspaces cannot discover or open completion files", async () => {
  const f = await fixture();
  try {
    await f.add("file.ts");
    f.vscode.workspace.isTrusted = false;
    assert.deepEqual((await f.query()).candidates, []);
    f.vscode.workspace.isTrusted = true;
    f.vscode.workspace.workspaceFolders[0].uri = MockUri.from({ scheme: "vscode-remote", path: f.root });
    assert.deepEqual((await f.query("@", 2)).candidates, []);
    assert.equal(f.searches.length, 0);
    assert.equal(await readFile(path.join(f.root, "file.ts"), "utf8"), "source\n");
  } finally {
    await f.cleanup();
  }
});
