import assert from "node:assert/strict";
import test from "node:test";
import { EditProposalStore } from "../editProposals";

test("edit proposals retain content until terminal state and reject concurrent actions", async () => {
  let finishApply: (() => void) | undefined;
  let disposed = 0;
  const changes: string[][] = [];
  const store = new EditProposalStore(
    () => changes.push(store.states.map(proposal => proposal.status)),
    () => {},
  );
  const id = store.add({
    label: "src/app.ts:1-2",
    onPreview: async () => {},
    onApply: () => new Promise<void>(resolve => {
      finishApply = resolve;
    }),
    onDispose: () => {
      disposed += 1;
    },
  });

  await assert.rejects(store.handleAction(id, "apply"), /Preview the edit/);
  await store.handleAction(id, "preview");
  assert.equal(store.states[0]?.status, "previewed");
  assert.equal(disposed, 0);

  const applying = store.handleAction(id, "apply");
  assert.equal(store.states[0]?.status, "applying");
  await assert.rejects(store.handleAction(id, "reject"), /Wait for the current applying/);
  finishApply?.();
  await applying;

  assert.equal(store.states[0]?.status, "applied");
  assert.equal(disposed, 1);
  store.clear();
  assert.equal(disposed, 1);
  assert.equal(store.states.length, 0);
  assert.equal(changes.some(statuses => statuses.includes("applying")), true);
});

test("stale preview failures release retained content and become terminal", async () => {
  let disposed = 0;
  const notices: string[] = [];
  const store = new EditProposalStore(
    () => {},
    message => notices.push(message),
  );
  const id = store.add({
    label: "src/app.ts:1",
    onPreview: async () => {
      throw new Error("The document changed; regenerate the edit.");
    },
    onApply: async () => {},
    onDispose: () => {
      disposed += 1;
    },
  });

  await store.handleAction(id, "preview");

  assert.equal(store.states[0]?.status, "stale");
  assert.equal(disposed, 1);
  assert.match(notices[0] ?? "", /document changed/);
  await assert.rejects(store.handleAction(id, "preview"), /already stale/);
});
