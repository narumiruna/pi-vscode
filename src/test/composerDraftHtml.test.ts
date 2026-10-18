import assert from "node:assert/strict";
import { createContext, Script } from "node:vm";
import { composerDraftHtml } from "../composerDraftHtml";

function fixture(enabled = false) {
  const context = createContext({});
  const run = (source: string) => new Script(source).runInContext(context);
  run(`
    let composerDraft, composerRevision = 1;
    const input = { value: '/reload', addEventListener() {} };
    const element = () => ({ append() {}, setAttribute() {}, addEventListener() {} });
    const document = { createElement: element, addEventListener() {} };
    const window = { addEventListener() {} };
    const $ = element;
    const posted = [], timers = new Map();
    let timerSequence = 0;
    const vscode = { postMessage(message) { posted.push(message); } };
    const setTimeout = (callback) => { const id = ++timerSequence; timers.set(id, callback); return id; };
    const clearTimeout = (id) => timers.delete(id);
    const tick = () => { const callbacks = [...timers.values()]; timers.clear(); for (const callback of callbacks) callback(); };
    const submissionPending = false, recoveredDraftPending = false, fileCompletion = undefined;
    const showNotice = () => {};
    const updateSendState = () => composerDraft.changed();
    ${composerDraftHtml()}
  `);
  const receive = (message: Record<string, unknown>) => run(`composerDraft.receive(${JSON.stringify(message)})`);
  const state = (binding: string) =>
    receive({ type: "draftState", binding, enabled, available: false, writable: true, reset: true });
  state("origin");
  return {
    run,
    receive,
    state,
    blocked: () => run("composerDraft.blocked()"),
    matches: (binding = "origin", revision = 1, text = "/reload") =>
      run(`composerDraft.matches(${JSON.stringify(binding)}, ${revision}, ${JSON.stringify(text)})`),
  };
}

for (const enabled of [false, true]) {
  test(`exact same-binding send acceptance releases the handoff with recovery ${enabled}`, () => {
    const f = fixture(enabled);
    f.run("composerDraft.sendHandoff()");
    assert.equal(f.blocked(), true);
    // Acceptance is for the captured revision, not necessarily the current input.
    f.run("input.value = 'newer text'; composerRevision += 1; composerDraft.changed()");
    assert.equal(f.matches(), true);
    assert.equal(f.blocked(), false);
    assert.equal(f.run("input.value"), "newer text");
    assert.equal(f.run("composerRevision"), 2);
  });
}

for (const result of ["accepted", "rejected"]) {
  test(`${result} same-binding handoff restarts retention after a blocked debounce`, () => {
    const f = fixture(true);
    f.run(
      "composerDraft.sendHandoff(); input.value = 'kept newer draft'; composerRevision += 1; composerDraft.changed(); tick()",
    );
    assert.equal(f.run("posted.some(message => message.text === 'kept newer draft')"), false);
    if (result === "accepted") f.matches();
    else f.receive({ type: "sendRejected" });
    f.run("composerDraft.changed(); tick()");
    assert.equal(f.blocked(), false);
    assert.equal(
      f.run(
        "posted.some(message => message.type === 'draftChanged' && message.text === 'kept newer draft' && message.revision === 2)",
      ),
      true,
    );
  });
}

test("mismatched acceptance cannot release or consume the pending send handoff", () => {
  const f = fixture();
  f.run("composerDraft.sendHandoff()");
  for (const [binding, revision, text] of [
    ["other", 1, "/reload"],
    ["origin", 2, "/reload"],
    ["origin", 1, "/compact"],
  ] as const) {
    f.matches(binding, revision, text);
    assert.equal(f.blocked(), true);
  }
  assert.equal(f.matches(), true);
  assert.equal(f.blocked(), false);
});

test("same-binding clears without an exact pending send cannot release navigation handoffs", () => {
  const f = fixture();
  f.run("composerDraft.handoff()");
  f.matches();
  assert.equal(f.blocked(), true);
});

test("old send acceptance cannot release a replacement binding's ownership block", () => {
  const f = fixture();
  f.run("composerDraft.sendHandoff(); composerDraft.select('session')");
  f.state("destination");
  assert.equal(f.matches(), true, "the existing new-session origin exception still matches");
  assert.equal(f.blocked(), true, "kept text still needs its current-revision clear");
});

test("later scope and binding transitions invalidate the pending origin exception", () => {
  const f = fixture();
  f.run("composerDraft.sendHandoff(); composerDraft.select('session')");
  f.state("destination");
  f.run("composerDraft.select('sessions')");
  f.state("replacement");
  assert.equal(f.matches(), false);
  assert.equal(f.blocked(), true);
});
