import assert from "node:assert/strict";
import { isSessionDraftMessage, SessionDraftController } from "../sessionDraftController";
import { SessionDraftStore, sessionDraftOwner } from "../sessionDraftStore";

function fixture(consent: () => Promise<boolean> = async () => true) {
  const posts: Record<string, unknown>[] = [];
  const writes: unknown[] = [];
  let file = "/sessions/a.jsonl";
  const store = new SessionDraftStore(
    {
      get: <T>() => undefined as T | undefined,
      update: async (_key, value) => {
        writes.push(value);
      },
    },
    () => assert.fail("write failure"),
  );
  const controller = new SessionDraftController(
    store,
    () => file,
    (message) => posts.push(message),
    consent,
  );
  controller.beginView();
  const binding = () => posts.filter((item) => item.type === "draftState").at(-1)?.binding as string;
  const change = (revision: number, text: string, id = binding()) =>
    controller.handle({ type: "draftChanged", binding: id, revision, text });
  return {
    controller,
    store,
    posts,
    writes,
    binding,
    change,
    setFile: (value: string) => {
      file = value;
      controller.refresh();
    },
  };
}

test("draft protocol rejects payloads other than bounded text, revisions and owned actions", () => {
  const binding = "11111111-1111-4111-8111-111111111111";
  const valid = { type: "draftChanged", binding, revision: 0, text: "ordinary" };
  assert.equal(isSessionDraftMessage(valid), true);
  for (const value of [
    { ...valid, images: [] },
    { ...valid, dialog: "secret" },
    { ...valid, queue: [] },
    { ...valid, text: "x".repeat(50_001) },
    { ...valid, revision: -1 },
    { ...valid, revision: 1.5 },
    { ...valid, binding: "session-a" },
    { type: "draftSelect", scope: "other" },
    null,
  ]) {
    assert.equal(isSessionDraftMessage(value), false);
  }
});

test("draft consent is explicit, cancelled/stale consent never permits persistence", async () => {
  let finish!: (value: boolean) => void;
  const f = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  await f.change(0, "before consent");
  await f.store.flush();
  assert.deepEqual(f.writes, []);
  const enabling = f.controller.handle({ type: "draftEnable", binding: f.binding() });
  f.controller.endView();
  finish(true);
  await enabling;
  assert.equal(f.store.enabled, false);
  await f.store.flush();
  assert.deepEqual(f.writes, []);
  const declined = fixture(async () => false);
  await declined.controller.handle({ type: "draftEnable", binding: declined.binding() });
  assert.equal(declined.store.enabled, false);
});

test("draft session ownership isolates Sessions, switch/import/fork/clone and unsaved path identities", async () => {
  const f = fixture();
  await f.controller.handle({ type: "draftEnable", binding: f.binding() });
  await f.change(0, "Sessions draft");
  const sessionsBinding = f.binding();
  await f.controller.handle({ type: "draftSelect", scope: "session" });
  await f.change(1, "session A");
  const old = f.binding();
  f.setFile("/sessions/b.jsonl");
  await f.change(2, "session B");
  await f.change(9, "stale old session", old);
  await f.change(10, "stale Sessions", sessionsBinding);
  assert.equal(f.store.get("sessions")?.text, "Sessions draft");
  assert.equal(f.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner"))?.text, "session A");
  assert.equal(f.store.get(sessionDraftOwner("/sessions/b.jsonl") ?? assert.fail("missing owner"))?.text, "session B");
  const id = f.binding();
  f.controller.refresh();
  assert.equal(f.binding(), id, "same assigned file keeps identity when header/temporary ID changes");
  f.controller.deleteSession("/sessions/a.jsonl");
  f.setFile("/sessions/a.jsonl");
  await f.change(100, "deleted session must not resurrect");
  assert.equal(f.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner")), undefined);
});

test("retained drafts require explicit Restore; new/empty startup updates never overwrite them", async () => {
  const f = fixture();
  f.store.enable();
  f.store.put("sessions", "!never automatically run\n日本語");
  f.controller.endView();
  f.controller.beginView();
  await f.change(0, "");
  await f.change(1, "new text");
  assert.equal(f.store.get("sessions")?.text, "!never automatically run\n日本語");
  assert.equal(
    f.posts.some((item) => item.type === "draftRestored"),
    false,
  );
  await f.controller.handle({ type: "draftRestore", binding: f.binding(), revision: 1 });
  const restored = f.posts.at(-1) ?? assert.fail("missing restoration");
  assert.deepEqual(restored, {
    type: "draftRestored",
    binding: f.binding(),
    expectedRevision: 1,
    text: "!never automatically run\n日本語",
  });
  await f.change(2, String(restored.text));
  await f.change(3, "edited restored text");
  assert.equal(f.store.get("sessions")?.text, "edited restored text");
  assert.equal(
    f.posts.some((item) => ["send", "sendNewSession", "queueInstruction"].includes(String(item.type))),
    false,
  );
});

test("accepted sends clear only captured revisions and late updates cannot revive accepted text", async () => {
  const f = fixture();
  f.store.enable();
  await f.change(1, "accepted");
  await f.controller.runMessage({ type: "send", revision: 1, text: "accepted" }, async () => {
    assert.equal(f.controller.accepted(1, "accepted"), f.binding());
  });
  await f.change(1, "accepted");
  assert.equal(f.store.get("sessions"), undefined);
  await f.change(2, "newer");
  await f.controller.runMessage({ type: "send", revision: 2, text: "newer" }, async () => {
    await f.change(3, "newest");
    f.controller.accepted(2, "newer");
  });
  assert.equal(f.store.get("sessions")?.text, "newest");
  await f.change(3, "duplicate revision conflict");
  assert.equal(f.store.get("sessions")?.text, "newest");
  await f.controller.runMessage({ type: "send", revision: 3, text: "newest" }, async () => {});
  assert.equal(f.store.get("sessions")?.text, "newest", "rejected/unacknowledged request retains text");
});

test("late acknowledgements keep a replacement view's newer draft even when revision and text repeat", async () => {
  const f = fixture();
  f.store.enable();
  await f.change(1, "same");
  const oldBinding = f.binding();
  await f.controller.runMessage({ type: "send", revision: 1, text: "same" }, async () => {
    f.controller.endView();
    f.controller.beginView();
    await f.controller.handle({ type: "draftDiscard", binding: f.binding(), revision: 0 });
    await f.change(1, "same");
    assert.equal(f.controller.accepted(1, "same"), oldBinding);
  });
  assert.equal(f.store.get("sessions")?.text, "same");
});

test("accepted new-session handoff retains its origin binding after session creation changes scope", async () => {
  const f = fixture();
  f.store.enable();
  await f.change(1, "create a session");
  const origin = f.binding();
  await f.controller.runMessage({ type: "sendNewSession", revision: 1, text: "create a session" }, async () => {
    f.setFile("/sessions/created.jsonl");
    await f.controller.handle({ type: "draftSelect", scope: "session" });
    assert.notEqual(f.binding(), origin);
    await f.change(2, "new session draft");
    assert.equal(f.controller.accepted(1, "create a session"), origin);
  });
  assert.equal(f.store.get("sessions"), undefined);
  assert.equal(
    f.store.get(sessionDraftOwner("/sessions/created.jsonl") ?? assert.fail("missing owner"))?.text,
    "new session draft",
  );
});

for (const route of ["background", "worktree"]) {
  test(`More ${route} acceptance keeps the captured view binding through asynchronous confirmation`, async () => {
    const f = fixture();
    f.store.enable();
    await f.change(1, "same");
    const origin = f.binding();
    let accept!: () => void;
    const confirmation = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const starting = f.controller.runMessage({ type: "showMoreActions", revision: 1, text: "same" }, async () => {
      await confirmation;
      assert.equal(f.controller.accepted(1, "different"), undefined);
      assert.equal(f.controller.accepted(2, "same"), undefined);
      assert.equal(f.controller.accepted(1, "same"), origin);
    });
    f.controller.endView();
    f.controller.beginView();
    assert.notEqual(f.binding(), origin);
    await f.controller.handle({ type: "draftDiscard", binding: f.binding(), revision: 0 });
    await f.change(1, "same");
    accept();
    await starting;
    assert.equal(f.store.get("sessions")?.text, "same", "old accepted start cannot remove the replacement writer");
  });
}

test("More acceptance clears its own captured draft, but not an edited draft", async () => {
  const f = fixture();
  f.store.enable();
  await f.change(1, "background prompt");
  await f.controller.runMessage({ type: "showMoreActions", revision: 1, text: "background prompt" }, async () => {
    await Promise.resolve();
    assert.equal(f.controller.accepted(1, "background prompt"), f.binding());
  });
  assert.equal(f.store.get("sessions"), undefined);
  await f.change(2, "worktree prompt");
  await f.controller.runMessage({ type: "showMoreActions", revision: 2, text: "worktree prompt" }, async () => {
    await f.change(3, "newer draft");
    assert.equal(f.controller.accepted(2, "worktree prompt"), f.binding());
  });
  assert.equal(f.store.get("sessions")?.text, "newer draft");
});

test("disable invalidates queued updates/consent and oversize updates keep the last saved text", async () => {
  const f = fixture();
  f.store.enable();
  await f.change(1, "last saved");
  await f.controller.handle({ type: "draftOversized", binding: f.binding(), revision: 2 });
  assert.equal(f.store.get("sessions")?.text, "last saved");
  const old = f.binding();
  await f.controller.handle({ type: "draftDisable", binding: old });
  await f.change(3, "late update", old);
  await f.store.flush();
  assert.equal(f.store.enabled, false);
  assert.equal(f.writes.at(-1), undefined);
  await f.controller.handle({ type: "draftEnable", binding: f.binding() });
  await f.change(3, "new consent");
  assert.equal(f.store.get("sessions")?.text, "new consent");
});
