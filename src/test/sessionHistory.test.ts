import assert from "node:assert/strict";
import { mkdtemp, mkdir, readdir, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { listRecentPiSessions, piSessionKey } from "../sessionHistory";

function session(entries: readonly Record<string, unknown>[]): string {
  return entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
}

test("recent Pi sessions are workspace-scoped, newest-first, and use names before prompts", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "picode-session-history-"));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(sessions)]);
  try {
    const older = path.join(sessions, "older.jsonl");
    const newer = path.join(sessions, "newer.jsonl");
    const foreign = path.join(sessions, "foreign.jsonl");
    await writeFile(older, session([
      { type: "session", version: 3, id: "older-id", cwd: workspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: [{ type: "text", text: "<<<PICODE_CONTEXT_START: src/sidebar.ts>>>\nconst context = true;\n<<<PICODE_CONTEXT_END>>>\n<<<PICODE_REQUEST_START>>>\nFix the sidebar\n<<<PICODE_REQUEST_END>>>" }] } },
    ]));
    await writeFile(newer, session([
      { type: "session", version: 3, id: "newer-id", cwd: workspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "Initial prompt" } },
      { type: "session_info", id: "2", parentId: "1", name: "Named conversation" },
    ]));
    await writeFile(foreign, session([
      { type: "session", version: 3, id: "foreign-id", cwd: otherWorkspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "Do not show" } },
    ]));
    const now = new Date();
    await utimes(older, new Date(now.getTime() - 2_000), new Date(now.getTime() - 2_000));
    await utimes(newer, new Date(now.getTime() - 1_000), new Date(now.getTime() - 1_000));
    await utimes(foreign, now, now);

    const result = await listRecentPiSessions(newer, workspace);
    assert.ok(result);
    assert.deepEqual(result.map(item => ({ id: item.sessionId, title: item.title })), [
      { id: "newer-id", title: "Named conversation" },
      { id: "older-id", title: "Fix the sidebar" },
    ]);
    assert.equal(result[0]?.key, piSessionKey(newer));
    assert.match(result[0]?.key ?? "", /^[a-f0-9]{24}$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent Pi sessions rank every directory entry before capping metadata reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "picode-session-order-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessions)]);
  try {
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
      path.join(sessions, `${String(index).padStart(3, "0")}.jsonl`),
      session([
        { type: "session", version: 3, id: `session-${index}`, cwd: workspace },
        { type: "message", id: "1", parentId: null, message: { role: "user", content: `Prompt ${index}` } },
      ]),
    )));
    const directoryOrder = await readdir(sessions);
    const newest = path.join(sessions, directoryOrder.at(-1)!);
    const future = new Date(Date.now() + 60_000);
    await utimes(newest, future, future);

    const result = await listRecentPiSessions(newest, workspace, 1);
    assert.ok(result);
    assert.equal(result[0]?.path, newest);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent Pi sessions validate workspace headers before limiting candidates", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "picode-session-workspace-cap-"));
  const workspace = path.join(root, "workspace");
  const otherWorkspace = path.join(root, "other");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace), mkdir(sessions)]);
  try {
    const matching = path.join(sessions, "matching.jsonl");
    await writeFile(matching, session([
      { type: "session", version: 3, id: "matching", cwd: workspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "Matching prompt" } },
    ]));
    await Promise.all(Array.from({ length: 501 }, (_, index) => writeFile(
      path.join(sessions, `foreign-${String(index).padStart(3, "0")}.jsonl`),
      session([
        { type: "session", version: 3, id: `foreign-${index}`, cwd: otherWorkspace },
        { type: "message", id: "1", parentId: null, message: { role: "user", content: `Foreign ${index}` } },
      ]),
    )));
    const old = new Date(Date.now() - 60_000);
    await utimes(matching, old, old);

    const result = await listRecentPiSessions(matching, workspace, 1);
    assert.ok(result);
    assert.equal(result[0]?.path, matching);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent Pi sessions recover a bounded prompt before a large image and skip invalid files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "picode-session-bounds-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessions)]);
  try {
    const large = path.join(sessions, "large.jsonl");
    const invalid = path.join(sessions, "invalid.jsonl");
    const header = JSON.stringify({ type: "session", version: 3, id: "large-id", cwd: workspace });
    const largeMessage = JSON.stringify({
      type: "message",
      id: "1",
      parentId: null,
      message: { role: "user", content: [{ type: "text", text: "Describe this image" }, { type: "image", data: "a".repeat(300_000), mimeType: "image/png" }] },
    });
    await writeFile(large, `${header}\n${largeMessage}\n`);
    await writeFile(invalid, "not-json\n");

    const result = await listRecentPiSessions(large, workspace, 1);
    assert.ok(result);
    assert.equal(result.length, 1);
    assert.equal(result[0]?.title, "Describe this image");
    assert.equal(await listRecentPiSessions(large, path.join(root, "missing")), undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent Pi sessions find the latest name between oversized records", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "picode-session-name-"));
  const workspace = path.join(root, "workspace");
  const sessions = path.join(root, "sessions");
  await Promise.all([mkdir(workspace), mkdir(sessions)]);
  try {
    const named = path.join(sessions, "named.jsonl");
    const image = (marker: string) => ({ type: "image", data: marker.repeat(300_000), mimeType: "image/png" });
    await writeFile(named, session([
      { type: "session", version: 3, id: "named-id", cwd: workspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: [{ type: "text", text: "Initial prompt" }, image("a")] } },
      { type: "session_info", id: "2", parentId: "1", name: "Middle name" },
      { type: "message", id: "3", parentId: "2", message: { role: "user", content: [{ type: "text", text: "Later prompt" }, image("b")] } },
    ]));

    let result = await listRecentPiSessions(named, workspace, 1);
    assert.ok(result);
    assert.equal(result[0]?.title, "Middle name");

    const bounded = path.join(sessions, "bounded.jsonl");
    await writeFile(bounded, session([
      { type: "session", version: 3, id: "bounded-id", cwd: workspace },
      { type: "message", id: "1", parentId: null, message: { role: "user", content: "Bounded prompt" } },
      { type: "session_info", id: "2", parentId: "1", name: "Out of budget" },
      { type: "message", id: "3", parentId: "2", message: { role: "user", content: [{ type: "text", text: "Later prompt" }, image("c"), image("d")] } },
    ]));
    result = await listRecentPiSessions(bounded, workspace, 1);
    assert.ok(result);
    assert.equal(result[0]?.title, "Bounded prompt");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
