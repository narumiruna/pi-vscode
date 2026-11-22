import assert from "node:assert/strict";
import path from "node:path";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const { registerWorktreeCommand } = require("../worktreeController") as typeof import("../worktreeController");
vscode.restore();

const command = "pi.newWorktreeInNewWindow";
const hash = "b".repeat(40);
const target = path.resolve("fixture.worktrees", "path chosen by Git");
type Options = { branch: string; commitish: string; noTrack: boolean };

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function fixture() {
  const calls: string[] = [];
  const errors: string[] = [];
  const createOptions: Options[] = [];
  const windows: { id: string; uri: MockUri; options: unknown }[] = [];
  const folder = { uri: MockUri.file(path.resolve("fixture")) };
  const otherFolder = { uri: MockUri.file(path.resolve("other")) };
  const folders = [folder, otherFolder];
  const primary = {
    rootUri: folder.uri,
    isUsingVirtualFileSystem: false,
    async getCommit(ref: string) {
      calls.push(`getCommit ${ref}`);
      return { hash };
    },
    async createWorktree(options: Options) {
      calls.push("createWorktree");
      createOptions.push(options);
      return target;
    },
  };
  const other = { ...primary, rootUri: otherFolder.uri };
  const scan = [primary];
  const api = {
    state: "initialized",
    get repositories() {
      // The real VS Code API returns new wrappers for each read.
      return scan.map((repository) => ({ ...repository }));
    },
  };
  const git = {
    enabled: true,
    getAPI(version: number) {
      calls.push(`getAPI ${version}`);
      return api;
    },
  };
  const extension = {
    async activate() {
      calls.push("activate Git");
      return git;
    },
  };
  vscode.env.uiKind = vscode.UIKind.Desktop;
  vscode.env.remoteName = undefined;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = folders;
  vscode.workspace.getWorkspaceFolder = (uri: MockUri) =>
    folders.find(({ uri: candidate }) => candidate.toString() === uri.toString());
  vscode.extensions.getExtension = (id: string) => {
    calls.push(`getExtension ${id}`);
    return extension;
  };
  vscode.window.showQuickPick = async () => assert.fail("Unexpected repository picker");
  vscode.window.showInputBox = async () => assert.fail("Unexpected name prompt");
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
  };
  vscode.commands.executeCommand = async (id: string, uri: MockUri, options: unknown) => {
    calls.push("open window");
    windows.push({ id, uri, options });
  };
  const context = { subscriptions: [] } as unknown as Parameters<typeof registerWorktreeCommand>[0];
  registerWorktreeCommand(context);
  assert.equal(calls.length, 0, "registration does not load Git");
  const run = () => vscode.registrations.get(command)();
  return { calls, errors, createOptions, windows, folder, folders, primary, other, scan, api, git, run };
}

test("creates a named worktree at the resolved HEAD and opens the exact returned path in a new window", async () => {
  const { calls, createOptions, windows, scan, run, other, errors } = fixture();
  scan.push({ ...other, rootUri: MockUri.file("outside") }, { ...other, isUsingVirtualFileSystem: true });
  await run();
  assert.deepEqual(calls, [
    "getExtension vscode.git",
    "activate Git",
    "getAPI 1",
    "getCommit HEAD",
    "createWorktree",
    "open window",
  ]);
  const branch = createOptions[0]?.branch;
  assert.match(branch ?? "", /^pi\/worktree-[a-f0-9-]{36}$/);
  assert.deepEqual(createOptions, [{ branch, commitish: hash, noTrack: true }]);
  assert.deepEqual(windows, [
    { id: "vscode.openFolder", uri: MockUri.file(target), options: { forceNewWindow: true } },
  ]);
  assert.deepEqual(errors, []);
  await run();
  assert.notEqual(createOptions[1]?.branch, branch);
});

test("selects the requested Git source, or leaves the workspace untouched on cancel", async () => {
  const { calls, createOptions, windows, scan, other, run } = fixture();
  const otherHash = "c".repeat(40);
  scan.push({ ...other, getCommit: async () => ({ hash: otherHash }) });
  vscode.window.showQuickPick = async (sources: { description: string }[]) => {
    assert.deepEqual(
      sources.map(({ description }) => description),
      [path.resolve("fixture"), path.resolve("other")],
    );
    return undefined;
  };
  await run();
  assert.deepEqual(calls, ["getExtension vscode.git", "activate Git", "getAPI 1"]);
  assert.equal(createOptions.length, 0);
  assert.equal(windows.length, 0);
  vscode.window.showQuickPick = async (sources: unknown[]) => sources[1];
  await run();
  assert.equal(createOptions[0]?.commitish, otherHash);
  assert.equal(windows.length, 1);
});

test("revalidates source and workspace after the Quick Pick and after resolving HEAD", async () => {
  const first = fixture();
  first.scan.push(first.other);
  vscode.window.showQuickPick = async (sources: unknown[]) => {
    first.scan.pop();
    return sources[1];
  };
  await first.run();
  assert.match(first.errors[0] ?? "", /repository is no longer available/);
  assert.ok(!first.calls.includes("getCommit HEAD"));

  const second = fixture();
  second.primary.getCommit = async () => {
    second.folders.shift();
    return { hash };
  };
  await second.run();
  assert.match(second.errors[0] ?? "", /repository is no longer available/);
  assert.deepEqual(second.createOptions, []);
  assert.deepEqual(second.windows, []);
});

test("requires trusted local desktop and a file workspace before activating Git", async () => {
  for (const [configure, message] of [
    [() => (vscode.workspace.isTrusted = false), /trusted workspace/],
    [() => (vscode.env.remoteName = "ssh-remote"), /local, file-backed/],
    [() => (vscode.env.uiKind = vscode.UIKind.Web), /local, file-backed/],
    [() => (vscode.workspace.workspaceFolders = [{ uri: new MockUri("virtual", "/fixture") }]), /local, file-backed/],
    [() => (vscode.workspace.workspaceFolders = []), /local, file-backed/],
  ] as const) {
    const { run, errors, calls } = fixture();
    configure();
    await run();
    assert.match(errors[0] ?? "", message);
    assert.deepEqual(calls, []);
  }
});

test("reports disabled Git, pending discovery, no repository, or unreadable HEAD without opening a window", async () => {
  const { run, git, api, scan, primary, errors, createOptions, windows } = fixture();
  git.enabled = false;
  await run();
  git.enabled = true;
  scan.pop();
  api.state = "uninitialized";
  await run();
  api.state = "initialized";
  await run();
  scan.push(primary);
  primary.getCommit = async () => {
    throw new Error("invalid HEAD");
  };
  await run();
  assert.match(errors[0] ?? "", /Enable the built-in VS Code Git extension/);
  assert.match(errors[1] ?? "", /still looking for repositories/);
  assert.match(errors[2] ?? "", /No Git repository/);
  assert.match(errors[3] ?? "", /initial commit/);
  assert.deepEqual(createOptions, []);
  assert.deepEqual(windows, []);
});

test("a failed Git creation does not open a folder or retry", async () => {
  const { run, primary, windows, calls, errors } = fixture();
  primary.createWorktree = async () => {
    calls.push("createWorktree");
    throw new Error("Git: target already exists");
  };
  await run();
  assert.equal(calls.filter((call) => call === "createWorktree").length, 1);
  assert.deepEqual(windows, []);
  assert.deepEqual(errors, ["Could not create the worktree. See the Git output for details."]);
});

test("blocks a duplicate invocation and reports the actual path if opening fails", async () => {
  const { run, createOptions, errors } = fixture();
  const opening = deferred<MockUri>();
  const finish = deferred<void>();
  const openCommands: string[] = [];
  vscode.commands.executeCommand = async (id: string, uri: MockUri) => {
    openCommands.push(id);
    opening.resolve(uri);
    await finish.promise;
    throw new Error("Window rejected");
  };
  const pending = run();
  const uri = await Promise.race([opening.promise, pending.then(() => assert.fail("Expected a new-window request"))]);
  assert.deepEqual(uri, MockUri.file(target));
  await run();
  assert.match(errors[0] ?? "", /current worktree operation/);
  finish.resolve();
  await pending;
  assert.ok(errors[1]?.includes(target));
  assert.equal(createOptions.length, 1);
  assert.deepEqual(openCommands, ["vscode.openFolder"]);
});
