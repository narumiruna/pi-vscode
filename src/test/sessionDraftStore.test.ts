import assert from "node:assert/strict";
import {
  draftLimits,
  type SessionDraftChange,
  SessionDraftStore,
  sessionDraftOwner,
  sessionDraftStorageKey,
} from "../sessionDraftStore";

function fixture(initial?: unknown) {
  const writes: unknown[] = [];
  let now = 100_000_000;
  let failures = 0;
  const store = new SessionDraftStore(
    {
      get: <T>() => initial as T,
      update: async (key, value) => {
        assert.equal(key, sessionDraftStorageKey);
        writes.push(value);
      },
    },
    () => {
      failures += 1;
    },
    () => now,
  );
  return {
    store,
    writes,
    failures: () => failures,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

test("draft store persists nothing before consent and writes only versioned allowlisted text", async () => {
  const { store, writes } = fixture();
  store.put("sessions", "private");
  await store.flush();
  assert.deepEqual(writes, []);
  store.enable();
  store.put("sessions", "\n日本語 👩🏽‍💻\n");
  await store.flush();
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0], {
    version: 1,
    consent: true,
    records: [{ owner: "sessions", text: "\n日本語 👩🏽‍💻\n", updated: 100_000_000 }],
  });
  store.put("sessions", "");
  await store.flush();
  assert.equal(store.get("sessions"), undefined);
  store.disable();
  await store.flush();
  assert.equal(writes.at(-1), undefined);
});

test("draft store rejects malformed/private payloads, oversized records, future and expired timestamps", async () => {
  const valid = { owner: "sessions", text: "valid", updated: 100_000_000 };
  for (const candidate of [
    { ...valid, attachments: [{ data: "secret image" }] },
    { ...valid, dialog: "secret" },
    { ...valid, queue: [] },
    { ...valid, text: "x".repeat(50_001) },
    { ...valid, updated: 100_000_001 },
    { ...valid, updated: 100_000_000 - draftLimits.age },
    { ...valid, owner: "unverified" },
    { ...valid, text: "" },
    null,
  ]) {
    const { store, writes } = fixture({ version: 1, consent: true, records: [candidate] });
    assert.equal(store.get("sessions"), undefined);
    await store.flush();
    assert.deepEqual(writes, [{ version: 1, consent: true, records: [] }]);
  }
  for (const initial of [
    { version: 2, consent: true, records: [valid] },
    { version: 1, records: [valid] },
    { version: 1, consent: true, records: [valid], secret: "no" },
  ]) {
    const { store, writes } = fixture(initial);
    assert.equal(store.enabled, false);
    await store.flush();
    assert.deepEqual(writes, []);
  }
});

test("draft limits evict deterministically and expire on next access", async () => {
  const { store, advance, writes } = fixture();
  store.enable();
  for (let i = 0; i < 25; i += 1) {
    advance(1);
    store.put(sessionDraftOwner(`/s/${i}`) ?? assert.fail("missing owner"), "x");
  }
  await store.flush();
  assert.equal((writes.at(-1) as { records: unknown[] }).records.length, 20);
  for (let i = 0; i < 6; i += 1) {
    advance(1);
    store.put(sessionDraftOwner(`/large/${i}`) ?? assert.fail("missing owner"), "x".repeat(50_000));
  }
  await store.flush();
  const records = (writes.at(-1) as { records: { text: string }[] }).records;
  assert.equal(records.length, 5);
  assert.equal(
    records.reduce((n, item) => n + item.text.length, 0),
    250_000,
  );
  advance(draftLimits.age);
  assert.equal(store.get(sessionDraftOwner("/large/5") ?? assert.fail("missing owner")), undefined);
  await store.flush();
  assert.deepEqual((writes.at(-1) as { records: unknown[] }).records, []);
});

test("draft writes serialize/coalesce and cannot restore cleared text after an in-flight write", async () => {
  const writes: unknown[] = [];
  const releases: (() => void)[] = [];
  const store = new SessionDraftStore(
    {
      get: <T>() => undefined as T | undefined,
      update: (_key, value) => {
        writes.push(value);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    },
    () => assert.fail("unexpected write failure"),
  );
  store.enable();
  store.put("sessions", "old");
  await Promise.resolve();
  store.put("sessions", "new");
  store.remove("sessions");
  assert.equal(writes.length, 1);
  (releases.shift() ?? assert.fail("missing write"))();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes.length, 2);
  assert.deepEqual((writes[1] as { records: unknown[] }).records, []);
  (releases.shift() ?? assert.fail("missing write"))();
  await store.flush();
  assert.equal(writes.length, 2);
});

test("conditional draft removal checks shared writer identity even when text and timestamps match", async () => {
  const { store, writes } = fixture();
  const a = {};
  const b = {};
  store.enable();
  store.put("sessions", "same", a);
  const first = store.get("sessions");
  store.put("sessions", "same", b);
  assert.deepEqual(store.get("sessions"), first);
  await store.flush();
  const changes: SessionDraftChange[] = [];
  store.subscribe((change) => changes.push(change));
  const saved = writes.length;
  store.remove("sessions", a);
  await store.flush();
  assert.deepEqual(store.get("sessions"), first);
  assert.equal(writes.length, saved, "a rejected clear does not write persistence");
  assert.deepEqual(changes, [], "a rejected clear does not remove sibling recovery offers");
  assert.deepEqual(writes.at(-1), { version: 1, consent: true, records: [first] });
  store.remove("sessions", b);
  assert.equal(store.get("sessions"), undefined);
  store.put("sessions", "explicit unowned write");
  store.remove("sessions", b);
  assert.equal(store.get("sessions")?.text, "explicit unowned write");
  store.remove("sessions");
  assert.equal(store.get("sessions"), undefined, "explicit discard still removes the current record");
  await store.flush();
});

test("draft writer identity cannot survive disable or persistence reload", async () => {
  const { store, writes } = fixture();
  const writer = {};
  store.enable();
  store.put("sessions", "old", writer);
  store.disable();
  store.enable();
  store.put("sessions", "new consent");
  store.remove("sessions", writer);
  assert.equal(store.get("sessions")?.text, "new consent");
  store.put("sessions", "retained", writer);
  await store.flush();
  const reloaded = fixture(writes.at(-1));
  reloaded.store.remove("sessions", writer);
  assert.equal(reloaded.store.get("sessions")?.text, "retained");
  reloaded.store.remove("sessions");
  assert.equal(reloaded.store.get("sessions"), undefined);
  await reloaded.store.flush();
});

test("draft subscriptions are synchronous, text-free, disposable and isolated from listener failures", async () => {
  const { store } = fixture();
  const changes: SessionDraftChange[] = [];
  const sibling: SessionDraftChange[] = [];
  const stopFailed = store.subscribe(() => {
    throw Error("disposed view");
  });
  const stop = store.subscribe((change) => changes.push(change));
  store.subscribe((change) => sibling.push(change));
  assert.deepEqual(changes, [], "subscription does not replay or expose retained records");
  store.enable();
  assert.deepEqual(changes, ["enabled"]);
  store.put("sessions", "private text");
  store.remove("sessions");
  store.disable();
  store.disable();
  assert.deepEqual(changes, ["enabled", "records", "records", "disabled", "disabled"]);
  await store.flush();
  assert.deepEqual(sibling, changes, "a failed subscriber does not block sibling notifications or storage");
  stop();
  stop();
  stopFailed();
  store.enable();
  assert.equal(changes.length, 5);
  assert.equal(sibling.at(-1), "enabled");
  await store.flush();
});

test("draft expiry notifies subscribers on the next access", async () => {
  const { store, advance } = fixture();
  store.enable();
  store.put("sessions", "expired text");
  const changes: SessionDraftChange[] = [];
  store.subscribe((change) => changes.push(change));
  advance(draftLimits.age);
  assert.equal(store.get("sessions"), undefined);
  assert.deepEqual(changes, ["records"]);
  await store.flush();
});

test("interleaved session mutations retain the latest full envelope across in-flight writes", async () => {
  const writes: unknown[] = [];
  const releases: (() => void)[] = [];
  const store = new SessionDraftStore(
    {
      get: <T>() => undefined as T | undefined,
      update: (_key, value) => {
        writes.push(value);
        return new Promise<void>((resolve) => releases.push(resolve));
      },
    },
    () => assert.fail("unexpected write failure"),
  );
  const a = sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner");
  const b = sessionDraftOwner("/sessions/b.jsonl") ?? assert.fail("missing owner");
  const texts = () =>
    (writes.at(-1) as { records: { owner: string; text: string }[] }).records
      .map(({ owner, text }) => [owner, text])
      .sort();
  store.enable();
  store.put(a, "A first");
  await Promise.resolve();
  store.put(b, "B first");
  store.remove(a);
  assert.equal(writes.length, 1);
  (releases.shift() ?? assert.fail("missing write"))();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes.length, 2);
  assert.deepEqual(texts(), [[b, "B first"]]);
  store.put(a, "A final");
  store.put(b, "B final");
  (releases.shift() ?? assert.fail("missing write"))();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(writes.length, 3);
  assert.deepEqual(
    texts(),
    [
      [a, "A final"],
      [b, "B final"],
    ].sort(),
  );
  (releases.shift() ?? assert.fail("missing write"))();
  await store.flush();
  assert.equal(writes.length, 3);
});

test("draft storage failure is reported without automatic retry or resurrection", async () => {
  let failure = true;
  let warnings = 0;
  const writes: unknown[] = [];
  const store = new SessionDraftStore(
    {
      get: <T>() => undefined as T | undefined,
      update: async (_key, value) => {
        writes.push(value);
        if (failure) throw Error("private error not exposed");
      },
    },
    () => {
      warnings += 1;
    },
  );
  store.enable();
  store.put("sessions", "unsaved");
  await store.flush();
  assert.equal(warnings, 1);
  assert.equal(writes.length, 1);
  failure = false;
  store.remove("sessions");
  await store.flush();
  assert.deepEqual((writes.at(-1) as { records: unknown[] }).records, []);
});
