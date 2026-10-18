import assert from "node:assert/strict";
import { draftLimits, SessionDraftStore, sessionDraftOwner, sessionDraftStorageKey } from "../sessionDraftStore";

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
