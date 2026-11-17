import assert from "node:assert/strict";
import { isSessionDraftMessage, SessionDraftController } from "../sessionDraftController";
import { SessionDraftStore, sessionDraftOwner } from "../sessionDraftStore";

function fixture(consent: () => Promise<boolean> = async () => true, sharedStore?: SessionDraftStore) {
  const posts: Record<string, unknown>[] = [];
  const writes: unknown[] = [];
  let file = "/sessions/a.jsonl";
  const store =
    sharedStore ??
    new SessionDraftStore(
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
  const state = () => posts.filter((item) => item.type === "draftState").at(-1) ?? assert.fail("missing state");
  const binding = () => state().binding as string;
  const change = (revision: number, text: string, id = binding()) =>
    controller.handle({ type: "draftChanged", binding: id, revision, text });
  return {
    controller,
    store,
    posts,
    writes,
    state,
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

test("shared controllers keep interleaved per-session writes, bindings and revisions", async () => {
  const a = fixture();
  const b = fixture(undefined, a.store);
  b.setFile("/sessions/b.jsonl");
  await a.controller.handle({ type: "draftSelect", scope: "session" });
  await b.controller.handle({ type: "draftSelect", scope: "session" });
  const aBinding = a.binding();
  const bBinding = b.binding();
  await a.change(0, "before consent A");
  await b.change(6, "before consent B");
  await a.controller.handle({ type: "draftEnable", binding: aBinding });
  assert.equal(a.state().enabled, true);
  assert.equal(b.state().enabled, true, "consent updates the sibling without another consent prompt");
  assert.equal(a.binding(), aBinding);
  assert.equal(b.binding(), bBinding);
  await a.change(0, "duplicate pre-consent A");
  await b.change(6, "duplicate pre-consent B");
  assert.equal(a.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner")), undefined);
  assert.equal(a.store.get(sessionDraftOwner("/sessions/b.jsonl") ?? assert.fail("missing owner")), undefined);
  await a.change(1, "A first");
  await b.change(7, "B first");
  await a.change(2, "A second");
  await a.controller.handle({ type: "draftDiscard", binding: aBinding, revision: 2 });
  await b.change(6, "B stale");
  await b.change(7, "B duplicate");
  await a.change(2, "A duplicate");
  await a.change(3, "A final");
  await a.store.flush();
  const records = (a.writes.at(-1) as { records: { owner: string; text: string }[] }).records;
  assert.deepEqual(
    records.map(({ owner, text }) => [owner, text]).sort(),
    [
      [sessionDraftOwner("/sessions/a.jsonl"), "A final"],
      [sessionDraftOwner("/sessions/b.jsonl"), "B first"],
    ].sort(),
  );
  assert.equal(a.binding(), aBinding);
  assert.equal(b.binding(), bBinding);
  assert.equal(a.state().available, false, "own writes are not recovery offers");
  assert.equal(b.state().available, false);
  assert.equal(
    [...a.posts, ...b.posts].some((message) => "text" in message),
    false,
  );
});

for (const siblingText of ["newer sibling draft", "submitted"]) {
  test(`accepted sends keep a sibling's saved draft with ${siblingText === "submitted" ? "equal" : "different"} text`, async () => {
    const a = fixture();
    const b = fixture(undefined, a.store);
    for (const f of [a, b]) await f.controller.handle({ type: "draftSelect", scope: "session" });
    a.store.enable();
    await a.change(1, "submitted");
    let accept!: () => void;
    const pending = new Promise<void>((resolve) => {
      accept = resolve;
    });
    const sending = a.controller.runMessage({ type: "send", revision: 1, text: "submitted" }, async () => {
      await pending;
      assert.equal(a.controller.accepted(1, "submitted"), a.binding());
    });
    await b.change(1, siblingText);
    accept();
    await sending;
    const owner = sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner");
    assert.equal(a.store.get(owner)?.text, siblingText);
    await a.store.flush();
    const records = (a.writes.at(-1) as { records: Record<string, unknown>[] }).records;
    assert.equal(records.length, 1);
    assert.equal(records[0]?.text, siblingText);
    assert.deepEqual(Object.keys(records[0] ?? {}).sort(), ["owner", "text", "updated"]);
    assert.equal(
      [...a.posts, ...b.posts].some((message) => "text" in message),
      false,
    );
    await b.controller.runMessage({ type: "send", revision: 1, text: siblingText }, async () => {
      assert.equal(b.controller.accepted(1, siblingText), b.binding());
    });
    assert.equal(a.store.get(owner), undefined, "the current writer can still clear its accepted draft");
  });
}

test("late acceptance cannot clear a replacement view's recovery offer after a sibling write", async () => {
  const a = fixture();
  const b = fixture(undefined, a.store);
  for (const f of [a, b]) await f.controller.handle({ type: "draftSelect", scope: "session" });
  a.store.enable();
  await a.change(1, "submitted");
  const origin = a.binding();
  await a.controller.runMessage({ type: "send", revision: 1, text: "submitted" }, async () => {
    a.controller.beginView();
    await a.controller.handle({ type: "draftSelect", scope: "session" });
    assert.equal(a.state().available, true);
    await b.change(1, "new recovery text");
    assert.equal(a.controller.accepted(1, "submitted"), origin);
  });
  assert.equal(a.state().available, true);
  await a.controller.handle({ type: "draftRestore", binding: a.binding(), revision: 0 });
  assert.equal(a.posts.at(-1)?.type, "draftRestored");
  assert.equal(a.posts.at(-1)?.text, "new recovery text");
});

test("shared discard clears recovery without resetting bindings or echoing retained text", async () => {
  const a = fixture();
  await a.controller.handle({ type: "draftSelect", scope: "session" });
  await a.controller.handle({ type: "draftEnable", binding: a.binding() });
  await a.change(1, "retained A");
  const b = fixture(undefined, a.store);
  await b.controller.handle({ type: "draftSelect", scope: "session" });
  const binding = b.binding();
  assert.equal(b.state().available, true);
  await b.change(4, "");
  await a.change(2, "updated A");
  assert.equal(b.binding(), binding);
  assert.equal(b.state().available, true);
  assert.equal(
    b.posts.some((message) => "text" in message),
    false,
  );
  await a.controller.handle({ type: "draftDiscard", binding: a.binding(), revision: 2 });
  assert.equal(b.state().available, false);
  assert.equal(b.state().enabled, true);
  assert.equal(b.state().reset, false);
  assert.equal(b.binding(), binding);
  await b.controller.handle({ type: "draftRestore", binding, revision: 3 });
  await b.controller.handle({ type: "draftRestore", binding, revision: 4 });
  assert.equal(
    b.posts.some((message) => message.type === "draftRestored"),
    false,
  );
  await b.change(4, "duplicate startup update");
  assert.equal(a.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner")), undefined);
  await b.change(5, "new local text");
  assert.equal(
    a.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner"))?.text,
    "new local text",
  );
  assert.equal(b.state().available, false);
});

test("shared recovery remains offered until explicit restoration is confirmed", async () => {
  const a = fixture();
  await a.controller.handle({ type: "draftSelect", scope: "session" });
  await a.controller.handle({ type: "draftEnable", binding: a.binding() });
  await a.change(1, "retained text");
  const b = fixture(undefined, a.store);
  await b.controller.handle({ type: "draftSelect", scope: "session" });
  await b.change(0, "new unconfirmed text");
  assert.equal(b.state().available, true);
  await b.controller.handle({ type: "draftRestore", binding: b.binding(), revision: 0 });
  assert.equal(b.posts.at(-1)?.type, "draftRestored");
  assert.equal(b.posts.at(-1)?.text, "retained text");
  assert.equal(b.state().available, true, "requesting insertion does not confirm restoration");
  await b.change(1, "retained text");
  assert.equal(b.state().available, false);
  await b.change(2, "edited restored text");
  assert.equal(a.state().available, false, "a sibling's save does not turn a live writer into recovery");
  assert.equal(
    a.posts.some((message) => "text" in message),
    false,
  );
  assert.equal(
    a.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner"))?.text,
    "edited restored text",
  );
});

test("shared disable rotates every active binding and rejects stale updates and restoration", async () => {
  const a = fixture();
  await a.controller.handle({ type: "draftSelect", scope: "session" });
  await a.controller.handle({ type: "draftEnable", binding: a.binding() });
  await a.change(1, "retained text");
  const b = fixture(undefined, a.store);
  await b.controller.handle({ type: "draftSelect", scope: "session" });
  assert.equal(b.state().available, true);
  const aBinding = a.binding();
  const bBinding = b.binding();
  await b.controller.handle({ type: "draftDisable", binding: bBinding });
  assert.notEqual(a.binding(), aBinding);
  assert.notEqual(b.binding(), bBinding);
  for (const f of [a, b]) {
    assert.equal(f.state().enabled, false);
    assert.equal(f.state().available, false);
    assert.equal(f.state().reset, false);
  }
  await a.change(9, "stale A", aBinding);
  await b.controller.handle({ type: "draftRestore", binding: bBinding, revision: 9 });
  await a.store.flush();
  assert.equal(a.writes.at(-1), undefined);
  assert.equal(
    b.posts.some((message) => message.type === "draftRestored"),
    false,
  );
  await a.controller.handle({ type: "draftEnable", binding: a.binding() });
  await b.change(10, "still stale B", bBinding);
  await a.change(0, "fresh A");
  assert.equal(a.store.get(sessionDraftOwner("/sessions/a.jsonl") ?? assert.fail("missing owner"))?.text, "fresh A");
});

test("sibling discard-all invalidates in-flight consent even while retention is disabled", async () => {
  let finish!: (approved: boolean) => void;
  let prompts = 0;
  const a = fixture(() => {
    prompts += 1;
    return prompts === 1
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : Promise.resolve(true);
  });
  const b = fixture(undefined, a.store);
  const oldBinding = a.binding();
  const enabling = a.controller.handle({ type: "draftEnable", binding: oldBinding });
  await b.controller.handle({ type: "draftDisable", binding: b.binding() });
  assert.notEqual(a.binding(), oldBinding);
  finish(true);
  await enabling;
  assert.equal(a.store.enabled, false);
  assert.equal(a.state().enabled, false);
  assert.equal(b.state().enabled, false);
  await a.store.flush();
  assert.deepEqual(a.writes, [undefined]);
  await a.controller.handle({ type: "draftEnable", binding: oldBinding });
  assert.equal(prompts, 1, "the old binding cannot request consent again");
  await a.controller.handle({ type: "draftEnable", binding: a.binding() });
  assert.equal(prompts, 2);
  assert.equal(a.state().enabled, true);
  assert.equal(b.state().enabled, true);
});

test("sibling enable then disable cannot revive an earlier consent request", async () => {
  let finish!: (approved: boolean) => void;
  const a = fixture(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const b = fixture(undefined, a.store);
  const enabling = a.controller.handle({ type: "draftEnable", binding: a.binding() });
  await b.controller.handle({ type: "draftEnable", binding: b.binding() });
  assert.equal(a.state().enabled, true);
  assert.equal(b.state().enabled, true);
  await b.controller.handle({ type: "draftDisable", binding: b.binding() });
  finish(true);
  await enabling;
  assert.equal(a.store.enabled, false);
  assert.equal(a.state().enabled, false);
  assert.equal(b.state().enabled, false);
  await a.store.flush();
  assert.equal(a.writes.at(-1), undefined);
});

test("view subscriptions end on disposal and repeated beginView does not duplicate them", async () => {
  const a = fixture();
  const b = fixture(undefined, a.store);
  a.controller.endView();
  const stopped = a.posts.length;
  await b.controller.handle({ type: "draftEnable", binding: b.binding() });
  await b.controller.handle({ type: "draftDisable", binding: b.binding() });
  assert.equal(a.posts.length, stopped);
  a.controller.beginView();
  a.controller.beginView();
  const active = a.posts.length;
  await b.controller.handle({ type: "draftEnable", binding: b.binding() });
  assert.equal(a.posts.length, active + 1);
  assert.equal(a.state().enabled, true);
  await b.controller.handle({ type: "draftDisable", binding: b.binding() });
  assert.equal(a.posts.length, active + 2);
  a.controller.endView();
  a.controller.endView();
  await b.controller.handle({ type: "draftEnable", binding: b.binding() });
  assert.equal(a.posts.length, active + 2);
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
