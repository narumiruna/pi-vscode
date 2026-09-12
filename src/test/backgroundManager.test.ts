import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { gitEnvironment, gitIdentity, gitRevision } from "../gitSnapshots";
import { installVscodeMock, MockUri } from "./vscodeMock";

test("background manager restores legacy/interrupted tasks safely, previews cancelled results, recovers imports and guards cleanup", async () => {
  const vscode = installVscodeMock();
  vscode.ProgressLocation = { Notification: 1 };
  vscode.window.withProgress = async (_options: unknown, run: any) => run({}, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) });
  const { BackgroundAgentManager } = require("../backgroundAgents") as typeof import("../backgroundAgents");
  const root = await mkdtemp(path.join(tmpdir(), "pi-background-manager-"));
  const repository = path.join(root, "repo"), storage = path.join(root, "storage"), worktree = path.join(storage, "worktrees", "cancelled");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repository, env: gitEnvironment() });
  const managers: InstanceType<typeof BackgroundAgentManager>[] = [];
  let persisted: any[] = [];
  const create = (records: unknown[]) => {
    const manager = new BackgroundAgentManager({ workspaceState: { get: () => records, update: async (_key: string, value: any[]) => { persisted = value; } }, globalStorageUri: MockUri.file(storage) } as any);
    managers.push(manager); return manager;
  };
  try {
    await mkdir(repository); await mkdir(path.dirname(worktree), { recursive: true });
    git("init", "-q"); await writeFile(path.join(repository, "a.txt"), "base\n"); git("add", "a.txt");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "commit", "-qm", "base");
    const origin = { repository: await gitIdentity(repository), baseCommit: (await gitRevision(repository)).head! };
    git("-c", "core.hooksPath=/dev/null", "worktree", "add", "--detach", worktree, origin.baseCommit);
    await writeFile(path.join(worktree, "a.txt"), "result\n");
    const base = { title: "fixture", output: "Model says tests passed", status: "completed" };
    const manager = create([
      { ...base, id: "legacy", worktreePath: path.join(root, "missing") },
      { ...base, id: "interrupted", status: "running", worktreePath: worktree, origin },
      { ...base, id: "live-pid", status: "failed", worktreePath: worktree, origin, processId: process.pid },
      { ...base, id: "missing", worktreePath: path.join(root, "missing"), origin },
      { ...base, id: "cancelled", status: "cancelled", worktreePath: worktree, origin },
      { ...base, id: "invalid", worktreePath: "relative/path" },
    ]);
    assert.equal(manager.states.length, 5);
    assert.equal(manager.states.find(task => task.id === "legacy")?.origin, undefined);
    assert.equal(manager.states.find(task => task.id === "interrupted")?.status, "failed");
    await assert.rejects(manager.reviewResults("legacy"), /Legacy/);
    await assert.rejects(manager.reviewResults("interrupted"), /inactivity/);
    await assert.rejects(manager.reviewResults("live-pid"), /still running/);
    await assert.rejects(manager.reviewResults("missing"));
    await assert.rejects(manager.cleanupWorktree("legacy"));
    await assert.rejects(manager.openSession("legacy"), /Open Worktree/);
    await assert.rejects(manager.openSession("cancelled"), /Open Worktree/);
    const resumable = create([{ ...base, id: "local", sessionFile: path.join(root, "local.jsonl") }]);
    assert.equal(await resumable.openSession("local"), path.join(root, "local.jsonl"));
    const inspected: string[] = [];
    // Capture the already-created manager's provider directly for local-only inspection evidence.
    vscode.workspace.openTextDocument = async (uri: any) => ({ uri });
    vscode.window.showTextDocument = async (document: any) => { inspected.push((manager as any).documents.provideTextDocumentContent(document.uri)); };
    vscode.window.showQuickPick = async (items: any[]) => items;
    await manager.reviewResults("cancelled");
    assert.equal(manager.states.find(task => task.id === "cancelled")?.resultPreviewReady, true);
    assert.match(inspected[0]!, /Tests: not verified/);
    const reloaded = create(persisted);
    assert.equal(reloaded.states.find(task => task.id === "cancelled")?.resultPreviewReady, false);
    await assert.rejects(reloaded.applySelected("cancelled", repository), /preview selected/);
    (manager as any).resultOperations.add("cancelled");
    await assert.rejects(manager.cleanupWorktree("cancelled"), /review\/import/);
    (manager as any).resultOperations.delete("cancelled");
    vscode.window.showWarningMessage = async () => "Import Selected";
    await manager.applySelected("cancelled", repository);
    assert.equal(await readFile(path.join(repository, "a.txt"), "utf8"), "result\n");
    assert.deepEqual(manager.states.find(task => task.id === "cancelled")?.importReport?.applied, ["a.txt"]);
    assert.equal(await readFile(path.join(worktree, "a.txt"), "utf8"), "result\n", "import retains recovery source");
    const recovered = create(persisted);
    assert.deepEqual(recovered.states.find(task => task.id === "cancelled")?.importReport?.applied, ["a.txt"]);
    await manager.cleanupWorktree("cancelled");
    assert.equal(manager.states.find(task => task.id === "cancelled")?.worktreePath, undefined);
    await assert.rejects(manager.openSession("cancelled"), /Isolated sessions/);
    await assert.rejects(readFile(path.join(worktree, "a.txt")), { code: "ENOENT" });
    const created = await (manager as any).createWorktree(repository, "created");
    assert.equal(created.origin.baseCommit, origin.baseCommit);
    assert.equal(await readFile(path.join(created.worktreePath, "a.txt"), "utf8"), "base\n");
    (manager as any).setTask({ ...base, id: "created", worktreePath: created.worktreePath, origin: created.origin });
    await manager.cleanupWorktree("created");
    const bounded = create(Array.from({ length: 25 }, (_, index) => ({ ...base, id: String(index) })));
    assert.equal(bounded.states.length, 20);
    (bounded as any).resultOperations.add("5");
    (bounded as any).setTask({ ...base, id: "new" });
    assert.equal(bounded.states.length, 20);
    assert.ok(bounded.states.some(task => task.id === "5"), "an in-progress review cannot be evicted");
    assert.equal(bounded.states.some(task => task.id === "6"), false);
  } finally { managers.forEach(manager => manager.dispose()); vscode.restore(); await rm(root, { recursive: true, force: true }); }
});
