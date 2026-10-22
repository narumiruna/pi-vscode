import assert from "node:assert/strict";
import type * as vscode from "vscode";
import {
  ExtensionDialogRequests,
  type ExtensionDialogResponse,
  maxDialogTextCharacters,
} from "../extensionDialogRequests";
import type { PiRpcClient, PiRpcEvent } from "../piRpcClient";
import type { PiRuntimeManager } from "../piRuntime";
import { installVscodeMock, MockUri } from "./vscodeMock";

const mock = installVscodeMock();
afterAll(() => mock.restore());
const event = (id: string, method = "editor", fields = {}): PiRpcEvent => ({
  type: "extension_ui_request",
  id,
  method,
  ...fields,
});
const tick = async () => {
  for (let index = 0; index < 8; index++) await Promise.resolve();
};

class FixtureRuntime {
  readonly registry = new ExtensionDialogRequests();
  readonly writes: { id: string; response: ExtensionDialogResponse }[] = [];
  private listener: ((event: PiRpcEvent) => void) | undefined;
  private readonly origins = new WeakMap<PiRpcEvent, ReturnType<ExtensionDialogRequests["accept"]>>();
  onEvent = (listener: (event: PiRpcEvent) => void) => {
    this.listener = listener;
    return {
      dispose: () => {
        this.listener = undefined;
      },
    };
  };
  claimExtensionUiRequest = (value: PiRpcEvent) => {
    const request = this.origins.get(value);
    this.origins.delete(value);
    return request;
  };
  emit(value: PiRpcEvent) {
    this.origins.set(
      value,
      this.registry.accept(value, (response) => this.writes.push({ id: String(value.id), response })),
    );
    this.listener?.(value);
  }
}

function setup() {
  const { ExtensionUiDialogs } = require("../extensionUiDialogs") as typeof import("../extensionUiDialogs");
  mock.workspace.isTrusted = true;
  mock.window.activeTextEditor = undefined;
  mock.window.tabGroups.all = [{ tabs: [] }];
  const documents: any[] = [];
  const closes: any[] = [];
  const providers = new Map<string, any>();
  mock.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return {
      dispose() {
        providers.delete(scheme);
      },
    };
  };
  mock.workspace.openTextDocument = async (options: any) => {
    const document = {
      uri: options instanceof MockUri ? options : new MockUri("untitled", `/Untitled-${documents.length}`),
      text:
        options instanceof MockUri
          ? providers.get(options.scheme).provideTextDocumentContent(options)
          : options.content,
      version: 1,
      isClosed: false,
      getText() {
        return this.text;
      },
    };
    documents.push(document);
    return document;
  };
  mock.window.showTextDocument = async (document: any) => {
    mock.window.tabGroups.all[0].tabs.push({ input: new mock.TabInputText(document.uri) });
    mock.window.activeTextEditor = { document };
    return mock.window.activeTextEditor;
  };
  mock.window.tabGroups.close = async (tabs: any[]) => {
    closes.push(...tabs);
    return true;
  };
  mock.window.showQuickPick = async (options: any[]) => options[0];
  mock.window.showWarningMessage = async () => undefined;
  mock.window.showInputBox = async () => undefined;
  const runtime = new FixtureRuntime();
  const dialogs = new ExtensionUiDialogs(runtime as unknown as PiRuntimeManager);
  return { runtime, dialogs, documents, closes };
}

test("dialog registry rejects duplicate IDs and bounds pending requests", () => {
  const registry = new ExtensionDialogRequests();
  const responses: unknown[] = [];
  const first = registry.accept(event("same"), (value) => responses.push(value))!;
  assert.equal(
    registry.accept(event("same"), () => assert.fail()),
    undefined,
  );
  first.respond({ value: "" });
  first.respond({ cancelled: true });
  assert.equal(
    registry.accept(event("same"), () => assert.fail()),
    undefined,
  );
  assert.deepEqual([...responses], [{ value: "" }]);
  for (let index = 0; index < 16; index++) assert.ok(registry.accept(event(`p${index}`), () => {}));
  assert.equal(
    registry.accept(event("overflow"), (value) => responses.push(value)),
    undefined,
  );
  assert.deepEqual(responses.at(-1), { cancelled: true });
  registry.invalidate();
  assert.equal(registry.hasPending, false);
  assert.ok(registry.accept(event("same"), () => {}));
  registry.invalidate();
  for (let index = 0; index < 4096; index++)
    registry.accept(event(`seen-${index}`), () => {})?.respond({ cancelled: true });
  assert.equal(
    registry.accept(event("id-limit"), () => assert.fail("ID limit must fail closed")),
    undefined,
  );
  registry.invalidate();
});

test("Stop cancels all pending dialogs once even if one response write fails", () => {
  const registry = new ExtensionDialogRequests();
  const writes: unknown[] = [];
  registry.accept(event("failed-cancel"), () => {
    throw new Error("cancel failed");
  });
  const pending = registry.accept(event("cancel"), (response) => writes.push(response))!;
  assert.throws(() => registry.cancelPending(), /cancel failed/);
  pending.respond({ value: "late" });
  assert.deepEqual(writes, [{ cancelled: true }]);
  assert.equal(registry.hasPending, false);
  registry.invalidate();
});

test("untrusted host rejects dialogs and prevents direct editor command calls", async () => {
  const { runtime, dialogs, documents } = setup();
  try {
    mock.workspace.isTrusted = false;
    runtime.emit(event("untrusted"));
    await tick();
    assert.equal(documents.length, 0);
    assert.deepEqual(runtime.writes, [{ id: "untrusted", response: { cancelled: true } }]);
    dialogs.submit();
    dialogs.cancel();
    dialogs.confirm(true);
    assert.equal(runtime.writes.length, 1);
  } finally {
    mock.workspace.isTrusted = true;
    dialogs.dispose();
  }
});

test("timeout, invalidation and failed writes finish once without retry", () => {
  vi.useFakeTimers();
  try {
    const registry = new ExtensionDialogRequests();
    const writes: unknown[] = [];
    const request = registry.accept(event("timeout", "editor", { timeout: 10 }), (value) => writes.push(value))!;
    let ended = 0;
    request.onDidEnd(() => ended++);
    vi.advanceTimersByTime(10);
    request.respond({ value: "too late" });
    assert.equal(ended, 1);
    assert.deepEqual([...writes], []);
    const failed = registry.accept(event("failed"), () => {
      throw new Error("write failed");
    })!;
    assert.throws(() => failed.respond({ value: "never retry" }), /write failed/);
    failed.respond({ cancelled: true });
    assert.equal(registry.hasPending, false);
    for (const timeout of [-1, Infinity, "10", 2_147_483_648]) {
      assert.equal(
        registry.accept(event(String(timeout), "input", { timeout }), (value) => writes.push(value)),
        undefined,
      );
      assert.deepEqual(writes.at(-1), { cancelled: true });
    }
  } finally {
    vi.useRealTimers();
  }
});

for (const text of ["", "  line one\n\tline two\n\n", "  first\r\nsecond\r\n", "\u2028\u2029  "]) {
  test(`native editor submits exact document text once: ${JSON.stringify(text)}`, async () => {
    const { runtime, dialogs, documents, closes } = setup();
    try {
      runtime.emit(event("edit", "editor", { prefill: text }));
      await tick();
      assert.equal(documents[0].text, text);
      dialogs.submit();
      dialogs.submit();
      assert.deepEqual(runtime.writes, [{ id: "edit", response: { value: text } }]);
      assert.equal(closes.length, 1);
    } finally {
      dialogs.dispose();
    }
  });
}

test("commands cannot take another document's contents; edits use full current revision", async () => {
  const { runtime, dialogs, documents } = setup();
  try {
    runtime.emit(event("edit", "editor", { prefill: "before\nafter" }));
    await tick();
    const owned = mock.window.activeTextEditor;
    mock.window.activeTextEditor = { document: { getText: () => "private other text" } };
    dialogs.submit();
    dialogs.cancel();
    assert.deepEqual([...runtime.writes], []);
    mock.window.activeTextEditor = owned;
    documents[0].text = "changed\n  current\n";
    documents[0].version++;
    dialogs.submit();
    assert.deepEqual(runtime.writes[0].response, { value: "changed\n  current\n" });
  } finally {
    dialogs.dispose();
  }
});

for (const action of ["cancel", "close", "replace", "dispose", "oversize"] as const) {
  test(`native editor ${action} never sends partial or late values`, async () => {
    const { runtime, dialogs, documents } = setup();
    try {
      runtime.emit(event("edit", "editor", { prefill: "initial\ntext" }));
      await tick();
      documents[0].text = "partial";
      if (action === "cancel") dialogs.cancel();
      if (action === "close") {
        mock.window.tabGroups.all[0].tabs = [];
        mock.workspaceEvents.emit("tabs");
        mock.workspaceEvents.emit("closeDocument", documents[0]);
      }
      if (action === "replace") runtime.registry.invalidate();
      if (action === "dispose") dialogs.dispose();
      if (action === "oversize") {
        documents[0].text = "x".repeat(maxDialogTextCharacters + 1);
        dialogs.submit();
      }
      dialogs.submit();
      assert.deepEqual(runtime.writes, action === "replace" ? [] : [{ id: "edit", response: { cancelled: true } }]);
    } finally {
      dialogs.dispose();
    }
  });
}

test("privacy confirmation is mandatory per use, rejects concurrent editors, and never opens oversize prefill", async () => {
  const { runtime, dialogs, documents } = setup();
  let accept: ((value: unknown) => void) | undefined;
  mock.window.showQuickPick = (items: any[], options: any, token: any) => {
    assert.match(items[0].detail, /hot-exit backups/);
    assert.match(items[0].detail, /Do not enter credentials/);
    assert.match(items[0].detail, /Save does not submit/);
    assert.ok(token);
    return new Promise((resolve) => {
      accept = resolve;
    });
  };
  try {
    runtime.emit(event("first"));
    runtime.emit(event("second"));
    assert.equal(documents.length, 0);
    assert.deepEqual(runtime.writes, [{ id: "second", response: { cancelled: true } }]);
    accept?.(undefined);
    await tick();
    assert.equal(documents.length, 0);
    assert.deepEqual(runtime.writes.at(-1), { id: "first", response: { cancelled: true } });
    runtime.emit(event("large", "editor", { prefill: "x".repeat(maxDialogTextCharacters + 1) }));
    assert.equal(documents.length, 0);
    assert.deepEqual(runtime.writes.at(-1), { id: "large", response: { cancelled: true } });
  } finally {
    dialogs.dispose();
  }
});

test("timeout during privacy confirmation or asynchronous document opening cannot reactivate editor", async () => {
  vi.useFakeTimers();
  const { runtime, dialogs, documents } = setup();
  try {
    let accept: ((value: unknown) => void) | undefined;
    let token: any;
    mock.window.showQuickPick = (_items: unknown, _options: unknown, value: unknown) => {
      token = value;
      return new Promise((resolve) => {
        accept = resolve;
      });
    };
    runtime.emit(event("privacy", "editor", { timeout: 5 }));
    vi.advanceTimersByTime(5);
    assert.equal(token.isCancellationRequested, true);
    accept?.({ label: "Open Non-Secret Editor" });
    await tick();
    assert.equal(documents.length, 0);
    mock.window.showQuickPick = async (items: any[]) => items[0];
    const open = mock.workspace.openTextDocument;
    let opened: (() => void) | undefined;
    mock.workspace.openTextDocument = async (options: unknown) => {
      const doc = await open(options);
      await new Promise<void>((resolve) => {
        opened = resolve;
      });
      return doc;
    };
    runtime.emit(event("opening", "editor", { timeout: 5 }));
    await tick();
    vi.advanceTimersByTime(5);
    opened?.();
    await tick();
    dialogs.submit();
    assert.deepEqual(runtime.writes, []);
    assert.equal(mock.window.activeTextEditor, undefined);
  } finally {
    dialogs.dispose();
    vi.useRealTimers();
  }
});

test("single-line input and overlapping permission prompts retain fail-closed origin ownership", async () => {
  const { runtime, dialogs } = setup();
  let permission: ((choice: unknown) => void) | undefined;
  mock.window.showWarningMessage = () =>
    new Promise((resolve) => {
      permission = resolve;
    });
  mock.window.showInputBox = async (options: any) => {
    assert.equal(options.value, "single");
    return "  input  ";
  };
  try {
    runtime.emit(event("editor"));
    runtime.emit(event("permission", "confirm", { message: "Allow write?" }));
    runtime.emit(event("input", "input", { prefill: "single" }));
    await tick();
    dialogs.submit();
    runtime.registry.invalidate();
    permission?.("Allow");
    await tick();
    assert.deepEqual(runtime.writes, [
      { id: "input", response: { value: "  input  " } },
      { id: "editor", response: { value: "" } },
    ]);
  } finally {
    dialogs.dispose();
  }
});

test("permission select rejects malformed or oversize lists atomically without opening UI", async () => {
  const { runtime, dialogs } = setup();
  let shown = 0;
  mock.window.showQuickPick = async () => {
    shown++;
    return "Allow";
  };
  try {
    for (const [index, options] of [
      ["Allow", 3, "Block"],
      Array.from({ length: 101 }, () => "Allow"),
      ["Allow", "x".repeat(maxDialogTextCharacters + 1)],
      ["x".repeat(60_000), "y".repeat(60_000)],
      undefined,
    ].entries())
      runtime.emit(event(`select-${index}`, "select", { options }));
    await tick();
    assert.equal(shown, 0);
    assert.equal(runtime.writes.length, 5);
    assert.ok(runtime.writes.every((entry) => "cancelled" in entry.response));
  } finally {
    dialogs.dispose();
  }
});

test("timed confirm uses a cancellable Block-first picker and cannot authorize a late Allow", async () => {
  vi.useFakeTimers();
  const { runtime, dialogs } = setup();
  let allow: ((value: unknown) => void) | undefined;
  let token: any;
  mock.window.showWarningMessage = () => assert.fail("Timed confirm must not open a non-cancellable modal");
  mock.window.showQuickPick = (items: any[], options: any, value: any) => {
    assert.deepEqual(
      items.map((item) => item.label),
      ["Block", "Review Full Message"],
    );
    assert.match(options.placeHolder, /review the full message/);
    token = value;
    return new Promise((resolve) => {
      allow = resolve;
    });
  };
  try {
    runtime.emit(event("confirm-timeout", "confirm", { message: "Full permission command", timeout: 10 }));
    vi.advanceTimersByTime(10);
    assert.equal(token.isCancellationRequested, true);
    allow?.({ label: "Allow" });
    await tick();
    assert.deepEqual(runtime.writes, []);
    assert.equal(runtime.registry.hasPending, false);
  } finally {
    dialogs.dispose();
    vi.useRealTimers();
  }
});

test("timed confirm reviews full Unicode/multiline text in an owned read-only document before Allow", async () => {
  vi.useFakeTimers();
  const { runtime, dialogs, documents, closes } = setup();
  const message = "\u65e5\u672c\u8a9e\n" + "full command ".repeat(1000);
  mock.window.showQuickPick = async (items: any[]) => items[1];
  try {
    runtime.emit(event("review", "confirm", { message, timeout: 100 }));
    await tick();
    assert.equal(documents[0].uri.scheme, "pi-extension-confirmation");
    assert.ok(documents[0].text.includes(message));
    const owned = mock.window.activeTextEditor;
    mock.window.activeTextEditor = { document: { uri: MockUri.file("/other"), getText: () => "other" } };
    dialogs.confirm(true);
    assert.equal(runtime.writes.length, 0);
    mock.window.activeTextEditor = owned;
    vi.advanceTimersByTime(100);
    dialogs.confirm(true);
    assert.deepEqual(runtime.writes, []);
    assert.equal(closes.length, 1);
  } finally {
    dialogs.dispose();
    vi.useRealTimers();
  }
});

test("untimed permission messages remain full modals; timed Allow requires explicit selection", async () => {
  const { runtime, dialogs } = setup();
  const message = "Full\npermission command " + "x".repeat(1000);
  mock.window.showWarningMessage = async (text: string, options: any, action: string) => {
    assert.equal(text, message);
    assert.equal(options.modal, true);
    assert.equal(action, "Allow");
    return "Allow";
  };
  try {
    runtime.emit(event("untimed", "confirm", { message }));
    runtime.emit(event("default-block", "confirm", { message: "Short command", timeout: 100 }));
    await tick();
    mock.window.showQuickPick = async (items: any[]) => items[1];
    runtime.emit(event("explicit-allow", "confirm", { message: "Short command", timeout: 100 }));
    await tick();
    assert.equal(runtime.writes.length, 2);
    dialogs.confirm(true);
    assert.deepEqual(runtime.writes, [
      { id: "untimed", response: { confirmed: true } },
      { id: "default-block", response: { confirmed: false } },
      { id: "explicit-allow", response: { confirmed: true } },
    ]);
  } finally {
    dialogs.dispose();
  }
});

test("deadline guards reject results even before a delayed timer callback runs", () => {
  vi.useFakeTimers();
  try {
    const registry = new ExtensionDialogRequests();
    const handle = registry.accept(event("deadline", "editor", { timeout: 10 }), () => assert.fail("late result"))!;
    vi.setSystemTime(Date.now() + 20);
    handle.respond({ value: "late" });
    assert.equal(handle.isActive, false);
    registry.invalidate();
    assert.equal(
      registry.accept(event("unsupported", "custom"), () => assert.fail()),
      undefined,
    );
  } finally {
    vi.useRealTimers();
  }
});

test("real runtime binds claims to exact originating event and rejects replacement/disconnect/disposal", async () => {
  const { PiRuntimeManager } = require("../piRuntime") as typeof import("../piRuntime");
  const runtime = new PiRuntimeManager({
    extensionUri: MockUri.file(process.cwd()),
    environmentVariableCollection: { clear() {} },
  } as unknown as vscode.ExtensionContext);
  const internal = runtime as unknown as {
    client: PiRpcClient;
    handleEvent(value: PiRpcEvent): void;
    ensureStarted(): Promise<void>;
  };
  internal.ensureStarted = async () => {};
  const writes: unknown[] = [];
  const client = {
    isRunning: true,
    sendExtensionUiResponse: (id: string, value: unknown) => writes.push({ id, value }),
    stop: async () => {},
    onEvent: () => ({ dispose() {} }),
  };
  internal.client = client as unknown as PiRpcClient;
  try {
    const first = event("origin");
    internal.handleEvent(first);
    assert.equal(runtime.claimExtensionUiRequest({ ...first }), undefined);
    const handle = runtime.claimExtensionUiRequest(first)!;
    assert.ok(handle);
    assert.equal(runtime.hasPendingExtensionDialogs, true);
    await assert.rejects(runtime.newSession(), /Finish or cancel the Pi extension dialog first/);
    assert.equal(handle.isActive, true);
    assert.equal(runtime.claimExtensionUiRequest(first), undefined);
    internal.client = { ...client } as unknown as PiRpcClient;
    handle.respond({ value: "stale" });
    assert.deepEqual(writes, []);
    const pending = event("pending");
    internal.handleEvent(pending);
    const next = runtime.claimExtensionUiRequest(pending)!;
    internal.handleEvent({ type: "process_exit" });
    next.respond({ value: "disconnected" });
    assert.deepEqual(writes, []);
    assert.equal(runtime.hasPendingExtensionDialogs, false);
  } finally {
    runtime.dispose();
  }
});
