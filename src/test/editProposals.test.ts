import assert from "node:assert/strict";
import { EditProposalStore } from "../editProposals";

test("edit proposals retain content until terminal state and reject concurrent actions", async () => {
  let finishApply: (() => void) | undefined;
  let disposed = 0;
  const changes: string[][] = [];
  const store = new EditProposalStore(
    () => changes.push(store.states.map((proposal) => proposal.status)),
    () => {},
  );
  const id = store.add({
    label: "src/app.ts:1-2",
    onPreview: async () => {},
    onApply: () =>
      new Promise<void>((resolve) => {
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
  assert.equal(
    changes.some((statuses) => statuses.includes("applying")),
    true,
  );
});

test("applies are serialized across separate live proposals", async () => {
  let finishFirstApply: (() => void) | undefined;
  const store = new EditProposalStore(
    () => {},
    () => {},
  );
  const first = store.add({
    label: "src/app.ts:1",
    onPreview: async () => {},
    onApply: () =>
      new Promise<void>((resolve) => {
        finishFirstApply = resolve;
      }),
  });
  const second = store.add({
    label: "src/app.ts:2",
    onPreview: async () => {},
    onApply: async () => {},
  });
  await store.handleAction(first, "preview");
  await store.handleAction(second, "preview");

  const applying = store.handleAction(first, "apply");
  await assert.rejects(store.handleAction(second, "apply"), /current edit Apply operation/);
  assert.equal(store.states.find((proposal) => proposal.id === second)?.status, "previewed");

  finishFirstApply?.();
  await applying;
  await store.handleAction(second, "apply");
  assert.equal(store.states.find((proposal) => proposal.id === second)?.status, "applied");
});

test("failed Apply releases serialization so another previewed proposal can Apply", async () => {
  let failFirstApply!: (error: Error) => void;
  let finishSecondApply!: () => void;
  let disposed = 0;
  const notices: { message: string; level: string }[] = [];
  const store = new EditProposalStore(
    () => {},
    (message, level) => notices.push({ message, level }),
  );
  const first = store.add({
    label: "src/app.ts:1",
    onPreview: async () => {},
    onApply: () =>
      new Promise<void>((_resolve, reject) => {
        failFirstApply = reject;
      }),
    onDispose: () => {
      disposed += 1;
    },
  });
  const second = store.add({
    label: "src/app.ts:2",
    onPreview: async () => {},
    onApply: () =>
      new Promise<void>((resolve) => {
        finishSecondApply = resolve;
      }),
  });
  await store.handleAction(first, "preview");
  await store.handleAction(second, "preview");

  const firstApply = store.handleAction(first, "apply");
  await assert.rejects(store.handleAction(second, "apply"), /current edit Apply operation/);
  failFirstApply(new Error("I/O failure"));
  await firstApply;

  assert.equal(store.states.find((proposal) => proposal.id === first)?.status, "failed");
  assert.equal(store.states.find((proposal) => proposal.id === first)?.error, "I/O failure");
  assert.equal(disposed, 0);
  assert.deepEqual(notices, [{ message: "I/O failure", level: "error" }]);
  await assert.rejects(store.handleAction(first, "apply"), /Preview the edit/);

  const secondApply = store.handleAction(second, "apply");
  assert.equal(store.states.find((proposal) => proposal.id === second)?.status, "applying");
  finishSecondApply();
  await secondApply;
  assert.equal(store.states.find((proposal) => proposal.id === second)?.status, "applied");
  store.clear();
  assert.equal(disposed, 1);
});

test("ordinary Preview failure retains callbacks for a fresh Preview and Apply", async () => {
  let previews = 0;
  let applies = 0;
  let disposed = 0;
  const notices: { message: string; level: string }[] = [];
  const store = new EditProposalStore(
    () => {},
    (message, level) => notices.push({ message, level }),
  );
  const id = store.add({
    label: "src/app.ts:1",
    onPreview: async () => {
      previews += 1;
      if (previews === 1) throw new Error("Preview unavailable.");
    },
    onApply: async () => {
      applies += 1;
    },
    onDispose: () => {
      disposed += 1;
    },
  });

  await store.handleAction(id, "preview");

  assert.equal(store.states[0]?.status, "failed");
  assert.equal(store.states[0]?.error, "Preview unavailable.");
  assert.equal(disposed, 0);
  assert.deepEqual(notices, [{ message: "Preview unavailable.", level: "error" }]);
  await assert.rejects(store.handleAction(id, "apply"), /Preview the edit/);
  assert.equal(applies, 0);

  await store.handleAction(id, "preview");
  assert.equal(previews, 2);
  assert.equal(store.states[0]?.status, "previewed");
  assert.equal(store.states[0]?.error, undefined);
  assert.equal(disposed, 0);
  await store.handleAction(id, "apply");
  assert.equal(applies, 1);
  assert.equal(store.states[0]?.status, "applied");
  assert.equal(disposed, 1);
  store.clear();
  assert.equal(disposed, 1);
});

test("stale Apply fails once and releases retained callbacks once without awaiting disposal", async () => {
  let applies = 0;
  let disposed = 0;
  let finishDisposal!: () => void;
  const notices: { message: string; level: string }[] = [];
  const message = "The document changed; regenerate the edit.";
  const store = new EditProposalStore(
    () => {},
    (message, level) => notices.push({ message, level }),
  );
  const id = store.add({
    label: "src/app.ts:1",
    onPreview: async () => {},
    onApply: async () => {
      applies += 1;
      throw new Error(message);
    },
    onDispose: () => {
      disposed += 1;
      return new Promise<void>((resolve) => {
        finishDisposal = resolve;
      });
    },
  });
  await store.handleAction(id, "preview");
  await store.handleAction(id, "apply");

  assert.equal(store.states[0]?.status, "stale");
  assert.equal(store.states[0]?.error, message);
  assert.equal(applies, 1);
  assert.equal(disposed, 1);
  assert.deepEqual(notices, [{ message, level: "error" }]);
  for (const action of ["preview", "apply", "reject"] as const) {
    await assert.rejects(store.handleAction(id, action), /already stale/);
  }
  store.clear();
  finishDisposal();
  assert.equal(applies, 1);
  assert.equal(disposed, 1);
  assert.deepEqual(notices, [{ message, level: "error" }]);
});

test("terminal proposals release callbacks and retain only bounded lightweight states", async () => {
  let disposed = 0;
  const store = new EditProposalStore(
    () => {},
    () => {},
  );

  for (let index = 0; index < 25; index += 1) {
    const id = store.add({
      label: `src/app.ts:${index + 1}`,
      onPreview: async () => {},
      onApply: async () => {},
      onDispose: () => {
        disposed += 1;
      },
    });
    await store.handleAction(id, "reject");
  }

  assert.equal(disposed, 25);
  assert.equal(store.states.length, 20);
  assert.equal(
    store.states.every((proposal) => proposal.status === "rejected"),
    true,
  );
});

test("stale preview failures release retained content and become terminal", async () => {
  let disposed = 0;
  const notices: string[] = [];
  const store = new EditProposalStore(
    () => {},
    (message) => notices.push(message),
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
