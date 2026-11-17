import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionInUseError, SessionWriters } from "../sessionWriters";

async function fixture(action: (writers: SessionWriters, root: string) => Promise<void>): Promise<void> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-session-writers-")));
  try {
    await action(new SessionWriters(), root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("concurrent reservations admit only one writer, including before the session is saved", async () => {
  await fixture(async (writers, root) => {
    const session = path.join(root, "assigned.jsonl");
    const first = {};
    const second = {};
    const results = await Promise.allSettled([writers.reserve(first, session), writers.reserve(second, session)]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result) => result.status === "rejected");
    assert.ok(rejected?.status === "rejected");
    assert.ok(rejected.reason instanceof SessionInUseError);
    const owner = results[0]?.status === "fulfilled" ? first : second;
    assert.equal(await writers.reserve(owner, session), session, "The same owner can reserve its file again");
    await writeFile(session, "saved session\n");
    await assert.rejects(writers.reserve({}, session), SessionInUseError);
    writers.release(owner);
    assert.equal(await writers.reserve({}, session), session);
  });
});

test("saved-session symlink aliases cannot acquire a second writer", async () => {
  if (process.platform === "win32") return;
  await fixture(async (writers, root) => {
    const session = path.join(root, "saved.jsonl");
    const alias = path.join(root, "alias.jsonl");
    await writeFile(session, "saved session\n");
    await symlink(session, alias);
    const owner = {};
    assert.equal(await writers.reserve(owner, alias), session);
    await assert.rejects(writers.reserve({}, session), SessionInUseError);
    await assert.rejects(writers.reserve({}, alias), SessionInUseError);
    assert.equal(await writers.reserve(owner, session), session);
  });
});

for (const saved of [false, true]) {
  test(`canonical parent aliases share a reservation (${saved ? "saved" : "assigned"})`, async () => {
    if (process.platform === "win32") return;
    await fixture(async (writers, root) => {
      const directory = path.join(root, "sessions");
      const alias = path.join(root, "session-alias");
      await mkdir(directory);
      await symlink(directory, alias, "dir");
      const session = path.join(directory, "session.jsonl");
      if (saved) await writeFile(session, "saved session\n");
      const owner = {};
      assert.equal(await writers.reserve(owner, path.join(alias, "session.jsonl")), session);
      await assert.rejects(writers.reserve({}, session), SessionInUseError);
      writers.release(owner);
      assert.equal(await writers.reserve({}, session), session);
    });
  });
}

test("hardlinks are rejected at both names instead of permitting two canonical-path writers", async () => {
  await fixture(async (writers, root) => {
    const session = path.join(root, "session.jsonl");
    const alias = path.join(root, "hardlink.jsonl");
    await writeFile(session, "saved session\n");
    await link(session, alias);
    const owner = {};
    await assert.rejects(writers.reserve(owner, session), /single-link/);
    await assert.rejects(writers.reserve({}, alias), /single-link/);
    await rm(alias);
    assert.equal(await writers.reserve({}, session), session, "Rejected files must not create reservations");
  });
});

test("reserve holds source and destination until commit verifies the destination", async () => {
  await fixture(async (writers, root) => {
    const owner = {};
    const contender = {};
    const source = path.join(root, "source.jsonl");
    const destination = path.join(root, "destination.jsonl");
    await writers.reserve(owner, source);
    await writers.reserve(owner, destination);
    await assert.rejects(writers.reserve(contender, source), SessionInUseError);
    await assert.rejects(writers.reserve(contender, destination), SessionInUseError);
    await writers.commit(owner, undefined);
    await assert.rejects(writers.reserve(contender, source), SessionInUseError);
    await assert.rejects(writers.reserve(contender, destination), SessionInUseError);
    await writers.commit(owner, destination);
    assert.equal(await writers.reserve(contender, source), source);
    await assert.rejects(writers.reserve(contender, destination), SessionInUseError);
    writers.release(owner);
    assert.equal(await writers.reserve(contender, destination), destination);
  });
});

test("a conflicting commit preserves both owners' existing reservations", async () => {
  await fixture(async (writers, root) => {
    const first = {};
    const second = {};
    const source = path.join(root, "source.jsonl");
    const pending = path.join(root, "pending.jsonl");
    const destination = path.join(root, "destination.jsonl");
    await writers.reserve(first, source);
    await writers.reserve(first, pending);
    await writers.reserve(second, destination);
    await assert.rejects(writers.commit(first, destination), SessionInUseError);
    for (const file of [source, pending, destination])
      await assert.rejects(writers.reserve({}, file), SessionInUseError);
    writers.release(first);
    assert.equal(await writers.reserve({}, source), source);
    assert.equal(await writers.reserve({}, pending), pending);
    await assert.rejects(writers.reserve({}, destination), SessionInUseError);
  });
});

test("source refresh preserves a pending destination until verified commit or explicit cancellation", async () => {
  await fixture(async (writers, root) => {
    const owner = {};
    const source = path.join(root, "source.jsonl");
    const destination = path.join(root, "destination.jsonl");
    await writers.commit(owner, source);
    await writers.reserve(owner, destination);
    await writers.commit(owner, source);
    await assert.rejects(writers.reserve({}, destination), SessionInUseError);
    await writers.cancelReservation(owner, destination);
    assert.equal(await writers.reserve({}, destination), destination);
    await assert.rejects(writers.reserve({}, source), SessionInUseError);
  });
});

for (const action of ["retire", "release"] as const) {
  test(`${action} rejects a reservation already waiting for filesystem validation`, async () => {
    await fixture(async (writers, root) => {
      const owner = {};
      const file = path.join(root, "late.jsonl");
      const pending = writers.reserve(owner, file);
      writers[action](owner);
      await assert.rejects(pending, SessionInUseError);
      await assert.rejects(writers.reserve(owner, file), SessionInUseError);
      assert.equal(await writers.reserve({}, file), file);
    });
  });
}

test("a superseded refresh cannot claim or prune reservations after filesystem validation", async () => {
  await fixture(async (writers, root) => {
    const owner = {};
    const source = path.join(root, "source.jsonl");
    const destination = path.join(root, "destination.jsonl");
    await writers.commit(owner, source);
    let current = true;
    const pending = writers.commit(owner, destination, () => current);
    current = false;
    await assert.rejects(pending, SessionInUseError);
    await assert.rejects(writers.reserve({}, source), SessionInUseError);
    assert.equal(await writers.reserve({}, destination), destination);
  });
});

test("release removes only its owner's reservations and is safe to repeat", async () => {
  await fixture(async (writers, root) => {
    const first = {};
    const second = {};
    const firstFile = path.join(root, "first.jsonl");
    const pendingFile = path.join(root, "pending.jsonl");
    const secondFile = path.join(root, "second.jsonl");
    await writers.reserve(first, firstFile);
    await writers.reserve(first, pendingFile);
    await writers.reserve(second, secondFile);
    writers.release(first);
    writers.release(first);
    writers.release({});
    for (const file of [firstFile, pendingFile]) assert.equal(await writers.reserve({}, file), file);
    await assert.rejects(writers.reserve({}, secondFile), SessionInUseError);
    writers.release(second);
    assert.equal(await writers.reserve({}, secondFile), secondFile);
  });
});
