import assert from "node:assert/strict";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
mock.window.registerWebviewViewProvider = () => ({ dispose() {} });
const { registerPiSidebar } = require("../sidebar") as typeof import("../sidebar");
const { isWebviewMessage } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
afterAll(() => mock.restore());

function fixture() {
  const context: any = {
    extensionUri: MockUri.file("/fixture"),
    workspaceState: { get: () => undefined, update: async () => {} },
    subscriptions: [],
  };
  const runtime: any = {
    currentCwd: process.cwd(),
    currentState: { connected: false, busy: false },
    onEvent: () => ({ dispose() {} }),
    onDidChangeState: () => ({ dispose() {} }),
  };
  const provider: any = registerPiSidebar(context, runtime);
  provider.postState = () => {};
  const replies: unknown[] = [];
  provider.view = { webview: { postMessage: (message: unknown) => replies.push(message) } };
  let cancellations = 0;
  provider.fileCompletion.cancel = () => {
    cancellations += 1;
  };
  return {
    provider,
    replies,
    cancellations: () => cancellations,
    dispose() {
      for (const disposable of context.subscriptions) disposable.dispose();
    },
  };
}

test("clipboard copy messages require bounded text and a bounded correlation ID", () => {
  for (const text of ["", "source\n\t<literal>日本語", "x".repeat(8_000)]) {
    assert.equal(isWebviewMessage({ type: "copyText", text, requestId: 0 }, 100), true);
  }
  for (const text of [undefined, null, 1, {}, "x".repeat(8_001)]) {
    assert.equal(isWebviewMessage({ type: "copyText", text, requestId: 1 }, 100), false);
  }
  for (const requestId of [undefined, null, -1, 0.5, "1", Number.MAX_SAFE_INTEGER + 1, Infinity]) {
    assert.equal(isWebviewMessage({ type: "copyText", text: "source", requestId }, 100), false);
  }
});

test("host copies literal retained text without a browser clipboard permission or file capture cancellation", async () => {
  const f = fixture();
  const copied: string[] = [];
  mock.env.clipboard = { writeText: async (text: string) => copied.push(text) };
  try {
    const text = "<script>literal</script>\n\t日本語";
    await f.provider.handleMessage({ type: "copyText", requestId: 12, text });
    assert.deepEqual(copied, [text]);
    assert.deepEqual(f.replies, [{ type: "copyTextResult", requestId: 12, ok: true }]);
    assert.equal(f.cancellations(), 0);
    await f.provider.handleMessage({ type: "copyText", requestId: 13, text: "x".repeat(8_001) });
    assert.deepEqual(copied, [text], "invalid requests cannot write the system clipboard");
  } finally {
    f.dispose();
  }
});

test("clipboard failure returns only a correlated failure without raw diagnostics or copied content", async () => {
  const f = fixture();
  mock.env.clipboard = {
    writeText: async () => {
      throw new Error("private clipboard diagnostic");
    },
  };
  try {
    await f.provider.handleMessage({ type: "copyText", requestId: 3, text: "private source" });
    assert.deepEqual(f.replies, [{ type: "copyTextResult", requestId: 3, ok: false }]);
  } finally {
    f.dispose();
  }
});

for (const invalidation of ["replace", "dispose"] as const) {
  test(`clipboard completion does not reach a ${invalidation === "replace" ? "replacement" : "disposed"} view`, async () => {
    const f = fixture();
    let finish = () => {};
    mock.env.clipboard = {
      writeText: () => new Promise<void>((resolve) => (finish = resolve)),
    };
    try {
      const pending = f.provider.handleMessage({ type: "copyText", requestId: 7, text: "source" });
      if (invalidation === "replace") {
        f.provider.view = { webview: { postMessage: (message: unknown) => f.replies.push(message) } };
      } else {
        f.provider.dispose();
      }
      finish();
      await pending;
      assert.deepEqual(f.replies, []);
    } finally {
      f.dispose();
    }
  });
}

test("clipboard requests from absent or disposed views cannot write", async () => {
  const f = fixture();
  let writes = 0;
  mock.env.clipboard = { writeText: async () => writes++ };
  try {
    const view = f.provider.view;
    f.provider.view = undefined;
    await f.provider.handleMessage({ type: "copyText", requestId: 1, text: "source" });
    f.provider.view = view;
    f.provider.dispose();
    await f.provider.handleMessage({ type: "copyText", requestId: 2, text: "source" });
    assert.equal(writes, 0);
  } finally {
    f.dispose();
  }
});
