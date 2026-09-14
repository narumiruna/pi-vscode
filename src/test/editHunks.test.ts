import assert from "node:assert/strict";
import { computeEditHunks, selectedReplacement } from "../editHunks";
import { EditProposalStore } from "../editProposals";

test("deterministic hunks round-trip insertions, deletions, repeats, Unicode and newline styles", () => {
  for (const [before, after] of [["", "new"], ["gone", ""], ["a\na\na\n", "a\nx\na\n"], ["漢字\r\nkeep\r\nold", "新字\r\nkeep\r\nnew\r\n"], ["a\nb\nc", "A\nb\nC"], ["a\n", "a"], ["a", "a\n"]]) {
    const { hunks } = computeEditHunks(before!, after!);
    assert.equal(selectedReplacement(before!, hunks, hunks.map(h => h.id)), after);
    assert.equal(selectedReplacement(before!, hunks, []), before);
  }
  const { hunks } = computeEditHunks("a\nb\nc\n", "A\nb\nC\n");
  assert.equal(hunks.length, 2);
  assert.equal(selectedReplacement("a\nb\nc\n", hunks, [hunks[0]!.id]), "A\nb\nc\n");
  assert.throws(() => selectedReplacement("a", hunks, ["invented"]));
  assert.equal(computeEditHunks("a\nb", "c\nd", 1).fallback, true);
  assert.equal(computeEditHunks("a\nb", "c\nd").hunks.length, 1);
});

test("hunk revisions invalidate Preview; empty and invented selections cannot Apply", async () => {
  const applied: unknown[] = [];
  const store = new EditProposalStore(() => {}, () => {});
  const id = store.add({ label: "file", hunks: [{ id: "h0", label: "first" }, { id: "h1", label: "last" }], onPreview: async () => {}, onApply: async ids => { applied.push(ids); } });
  await store.handleAction(id, "preview");
  store.select(id, ["h1"]);
  assert.equal(store.states[0]?.selectionRevision, 1);
  await assert.rejects(store.handleAction(id, "apply"), /Preview/);
  assert.throws(() => store.select(id, ["unknown"]));
  store.select(id, []); await store.handleAction(id, "preview");
  assert.equal(store.states[0]?.status, "failed");
  store.select(id, ["h0"]);
  await store.handleAction(id, "preview"); await store.handleAction(id, "apply");
  assert.deepEqual(applied, [["h0"]]);
  assert.match(store.states[0]?.summary ?? "", /1\/2/);
});

test("failed Apply requires a fresh Preview and disposed in-flight previews cannot reactivate", async () => {
  const store = new EditProposalStore(() => {}, () => {});
  const id = store.add({ label: "file", onPreview: async () => {}, onApply: async () => { throw new Error("I/O failure"); } });
  await store.handleAction(id, "preview"); await store.handleAction(id, "apply");
  assert.equal(store.states[0]?.status, "failed");
  await assert.rejects(store.handleAction(id, "apply"), /Preview/);
  let finish!: () => void;
  const pending = store.add({ label: "pending", onPreview: () => new Promise<void>(resolve => { finish = resolve; }), onApply: async () => {} });
  const preview = store.handleAction(pending, "preview");
  store.clear(); finish(); await preview;
  assert.equal(store.states.length, 0);
});
