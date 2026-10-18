import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
afterAll(() => mock.restore());

test("verified import history is applied while only the runtime operation owner is busy", async () => {
  mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
  const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
  const subscription = () => ({ dispose() {} });
  const runtime: any = {
    currentState: { connected: true, busy: true, sessionId: "imported" },
    currentCwd: process.cwd(),
    onEvent: subscription,
    onDidChangeState: subscription,
    getMessages: async () => [{ role: "assistant", content: [{ type: "text", text: "Imported history" }] }],
  };
  const context: any = {
    workspaceState: { get: () => undefined, update: async () => {} },
    extensionUri: MockUri.file("/extension"),
    subscriptions: [],
  };
  const provider = registerPiSidebar(context, runtime) as any;
  try {
    await provider.syncMessagesFromPi(true);
    assert.equal(provider.messages[0].content, "Imported history");
    const release = provider.requestGate.acquire();
    try {
      await assert.rejects(provider.syncMessagesFromPi(true), /Wait for Pi/);
    } finally {
      release();
    }
    let finish!: (messages: unknown[]) => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    runtime.getMessages = () =>
      new Promise<unknown[]>((resolve) => {
        finish = resolve;
        started();
      });
    const history = provider.syncMessagesFromPi(true);
    await ready;
    provider.handleRuntimeEvent({ type: "agent_start" });
    provider.messages = [{ id: "newer", role: "user", content: "Newer live request" }];
    finish([{ role: "assistant", content: [{ type: "text", text: "Old import response" }] }]);
    await history;
    assert.equal(provider.messages[0].content, "Newer live request");
  } finally {
    for (const disposable of context.subscriptions) disposable.dispose();
  }
});
