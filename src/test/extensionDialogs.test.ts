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
  readonly listeners = new Set<(event: PiRpcEvent) => void>();
  private readonly origins = new WeakMap<PiRpcEvent, ReturnType<ExtensionDialogRequests["accept"]>>();
  onEvent = (listener: (event: PiRpcEvent) => void) => {
    this.listeners.add(listener);
    return {
      dispose: () => {
        this.listeners.delete(listener);
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
    for (const listener of this.listeners) listener(value);
  }
}

function setup(registerCommands = false) {
  const { ExtensionUiDialogs, registerExtensionUiDialogs } =
    require("../extensionUiDialogs") as typeof import("../extensionUiDialogs");
  mock.workspace.isTrusted = true;
  mock.window.activeTextEditor = undefined;
  mock.window.tabGroups.all = [{ tabs: [] }];
  const documents: any[] = [];
  const closes: any[] = [];
  const providers = new Map<string, any>();
  mock.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    assert.equal(providers.has(scheme), false, "Each content provider scheme must be registered once");
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
  const subscriptions: vscode.Disposable[] = [];
  const dialogs = registerCommands
    ? registerExtensionUiDialogs({ subscriptions } as vscode.ExtensionContext, runtime as unknown as PiRuntimeManager)
    : new ExtensionUiDialogs(runtime as unknown as PiRuntimeManager);
  return { runtime, dialogs, documents, closes, providers, subscriptions };
}

test("one registered controller shares commands, provider and status items across runtimes", async () => {
  const commands = vi.spyOn(mock.commands, "registerCommand");
  const statusItems = vi.spyOn(mock.window, "createStatusBarItem");
  const { runtime, dialogs, documents, providers, subscriptions } = setup(true);
  const providerRegistration = vi.spyOn(mock.workspace, "registerTextDocumentContentProvider");
  const second = new FixtureRuntime();
  const registration = dialogs.addRuntime(second as unknown as PiRuntimeManager);
  try {
    assert.equal(subscriptions[0], dialogs);
    assert.equal(subscriptions.length, 5);
    assert.equal(runtime.listeners.size, 1);
    assert.equal(second.listeners.size, 1);
    runtime.emit(event("shared-id", "editor", { prefill: "first runtime" }));
    await tick();
    mock.registrations.get("pi.extensionEditor.submit")();
    second.emit(event("shared-id", "editor", { prefill: "second runtime" }));
    await tick();
    mock.registrations.get("pi.extensionEditor.submit")();
    assert.equal(documents.length, 2);
    assert.deepEqual(runtime.writes, [{ id: "shared-id", response: { value: "first runtime" } }]);
    assert.deepEqual(second.writes, [{ id: "shared-id", response: { value: "second runtime" } }]);
    assert.equal(commands.mock.calls.length, 4);
    assert.equal(statusItems.mock.calls.length, 4);
    assert.equal(providers.size, 1);
    assert.equal(providerRegistration.mock.calls.length, 0);
  } finally {
    for (const subscription of subscriptions) subscription.dispose();
    registration.dispose();
    providerRegistration.mockRestore();
    statusItems.mockRestore();
    commands.mockRestore();
  }
});

test("overlapping input and select requests with equal IDs reply only to their originating runtime", async () => {
  const { runtime, dialogs } = setup();
  const second = new FixtureRuntime();
  dialogs.addRuntime(second as unknown as PiRuntimeManager);
  const firstClaim = vi.spyOn(runtime, "claimExtensionUiRequest");
  const secondClaim = vi.spyOn(second, "claimExtensionUiRequest");
  const replies = new Map<string, (value: string) => void>();
  mock.window.showInputBox = (options: { title: string }) =>
    new Promise<string>((resolve) => replies.set(options.title, resolve));
  try {
    const firstEvent = event("same-input", "input", { title: "first" });
    const secondEvent = event("same-input", "input", { title: "second" });
    runtime.emit(firstEvent);
    second.emit(secondEvent);
    assert.equal(firstClaim.mock.calls[0]?.[0], firstEvent);
    assert.equal(secondClaim.mock.calls[0]?.[0], secondEvent);
    const firstReply = replies.get("first");
    const secondReply = replies.get("second");
    assert.ok(firstReply && secondReply);
    secondReply("second input");
    firstReply("first input");
    runtime.emit(event("same-select", "select", { options: ["first option"] }));
    second.emit(event("same-select", "select", { options: ["second option"] }));
    await tick();
    assert.deepEqual(runtime.writes, [
      { id: "same-input", response: { value: "first input" } },
      { id: "same-select", response: { value: "first option" } },
    ]);
    assert.deepEqual(second.writes, [
      { id: "same-input", response: { value: "second input" } },
      { id: "same-select", response: { value: "second option" } },
    ]);
  } finally {
    dialogs.dispose();
    firstClaim.mockRestore();
    secondClaim.mockRestore();
  }
});

test("unregister cancels only that runtime's requests and ignores late replies after re-registration", async () => {
  const { runtime, dialogs } = setup();
  const second = new FixtureRuntime();
  const registration = dialogs.addRuntime(second as unknown as PiRuntimeManager);
  const inputs = new Map<string, { reply: (value: string) => void; token: vscode.CancellationToken }>();
  mock.window.showInputBox = (options: { title: string }, token: vscode.CancellationToken) =>
    new Promise<string>((reply) => inputs.set(options.title, { reply, token }));
  let permission: ((value: string) => void) | undefined;
  mock.window.showWarningMessage = () =>
    new Promise<string>((resolve) => {
      permission = resolve;
    });
  try {
    runtime.emit(event("same", "input", { title: "first" }));
    second.emit(event("same", "input", { title: "second" }));
    second.emit(event("modal", "confirm", { message: "Allow second runtime?" }));
    registration.dispose();
    registration.dispose();
    assert.equal(second.listeners.size, 0);
    assert.equal(runtime.listeners.size, 1);
    const firstInput = inputs.get("first");
    const secondInput = inputs.get("second");
    assert.ok(firstInput && secondInput && permission);
    assert.equal(secondInput.token.isCancellationRequested, true);
    assert.equal(firstInput.token.isCancellationRequested, false);
    assert.equal(second.registry.hasPending, false);
    assert.equal(runtime.registry.hasPending, true);
    assert.deepEqual(second.writes, [
      { id: "same", response: { cancelled: true } },
      { id: "modal", response: { cancelled: true } },
    ]);
    second.emit(event("detached", "input", { title: "not displayed" }));
    assert.equal(inputs.has("not displayed"), false);
    second.registry.invalidate();
    dialogs.addRuntime(second as unknown as PiRuntimeManager);
    mock.window.showInputBox = async () => "new generation";
    second.emit(event("same", "input"));
    await tick();
    secondInput.reply("late second input");
    permission("Allow");
    firstInput.reply("first input");
    await tick();
    assert.deepEqual(runtime.writes, [{ id: "same", response: { value: "first input" } }]);
    assert.deepEqual(second.writes, [
      { id: "same", response: { cancelled: true } },
      { id: "modal", response: { cancelled: true } },
      { id: "same", response: { value: "new generation" } },
    ]);
    runtime.emit(event("still-registered", "input"));
    await tick();
    assert.deepEqual(runtime.writes.at(-1), { id: "still-registered", response: { value: "new generation" } });
  } finally {
    dialogs.dispose();
    second.registry.invalidate();
  }
});

test("unregister expires only its confirmation review and preserves the other runtime's active context", async () => {
  vi.useFakeTimers();
  const { runtime, dialogs, documents, closes, providers } = setup();
  const second = new FixtureRuntime();
  const registration = dialogs.addRuntime(second as unknown as PiRuntimeManager);
  const contexts = new Map<string, unknown>();
  const contextCommands = vi.spyOn(mock.commands, "executeCommand").mockImplementation(async (...args: unknown[]) => {
    if (args[0] === "setContext") contexts.set(String(args[1]), args[2]);
  });
  mock.window.showQuickPick = async (items: unknown[]) => items[1];
  try {
    runtime.emit(event("review", "confirm", { message: "First runtime message", timeout: 1000 }));
    await tick();
    second.emit(event("review", "confirm", { message: "Second runtime message", timeout: 1000 }));
    await tick();
    const provider = providers.get("pi-extension-confirmation");
    const expired: string[] = [];
    provider.onDidChange((uri: vscode.Uri) => expired.push(uri.toString()));
    mock.window.activeTextEditor = { document: documents[0] };
    mock.workspaceEvents.emit("activeEditor");
    registration.dispose();
    assert.deepEqual(second.writes, [{ id: "review", response: { cancelled: true } }]);
    assert.deepEqual(runtime.writes, []);
    assert.equal(contexts.get("pi.extensionConfirmationActive"), true);
    assert.equal(contexts.get("pi.extensionEditorActive"), false);
    assert.deepEqual(expired, [documents[1].uri.toString()]);
    assert.equal(closes.length, 1);
    assert.equal(closes[0].input.uri, documents[1].uri);
    assert.equal(provider.provideTextDocumentContent(documents[1].uri), "This Pi confirmation expired.");
    assert.match(provider.provideTextDocumentContent(documents[0].uri), /First runtime message/);
    mock.window.activeTextEditor = { document: documents[1] };
    dialogs.confirm(true);
    assert.equal(second.writes.length, 1);
    mock.window.activeTextEditor = { document: documents[0] };
    dialogs.confirm(true);
    assert.deepEqual(runtime.writes, [{ id: "review", response: { confirmed: true } }]);
    assert.equal(contexts.get("pi.extensionConfirmationActive"), false);
  } finally {
    dialogs.dispose();
    contextCommands.mockRestore();
    vi.useRealTimers();
  }
});

test("unregister closes its editor and releases the shared editor slot without sending late text", async () => {
  const { runtime, dialogs, documents, closes } = setup();
  const second = new FixtureRuntime();
  const registration = dialogs.addRuntime(second as unknown as PiRuntimeManager);
  try {
    second.emit(event("edit", "editor", { prefill: "second runtime text" }));
    await tick();
    runtime.emit(event("busy-editor", "editor"));
    assert.deepEqual(runtime.writes, [{ id: "busy-editor", response: { cancelled: true } }]);
    registration.dispose();
    dialogs.submit();
    assert.equal(closes.length, 1);
    assert.equal(closes[0].input.uri, documents[0].uri);
    assert.deepEqual(second.writes, [{ id: "edit", response: { cancelled: true } }]);
    runtime.emit(event("edit", "editor", { prefill: "first runtime text" }));
    await tick();
    dialogs.submit();
    assert.deepEqual(runtime.writes.at(-1), { id: "edit", response: { value: "first runtime text" } });
  } finally {
    dialogs.dispose();
  }
});

test("controller disposal cancels pending dialogs and removes listeners from every runtime", async () => {
  const { runtime, dialogs } = setup();
  const second = new FixtureRuntime();
  const registration = dialogs.addRuntime(second as unknown as PiRuntimeManager);
  const replies: ((value: string) => void)[] = [];
  mock.window.showInputBox = () => new Promise<string>((resolve) => replies.push(resolve));
  try {
    runtime.emit(event("same", "input"));
    second.emit(event("same", "input"));
    dialogs.dispose();
    dialogs.dispose();
    registration.dispose();
    assert.equal(runtime.listeners.size, 0);
    assert.equal(second.listeners.size, 0);
    assert.equal(runtime.registry.hasPending, false);
    assert.equal(second.registry.hasPending, false);
    dialogs.addRuntime(second as unknown as PiRuntimeManager).dispose();
    assert.equal(second.listeners.size, 0);
    for (const reply of replies) reply("late text");
    await tick();
    assert.deepEqual(runtime.writes, [{ id: "same", response: { cancelled: true } }]);
    assert.deepEqual(second.writes, [{ id: "same", response: { cancelled: true } }]);
  } finally {
    dialogs.dispose();
  }
});

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

test("editor runtime dialogs use a host-owned label without changing the full permission message", async () => {
  const { dialogs } = setup();
  const editor = new FixtureRuntime();
  dialogs.addRuntime(editor as unknown as PiRuntimeManager, "Pi Session 2");
  mock.window.showInputBox = async (options: any) => {
    assert.equal(options.title, "Pi Session 2: Input");
    return "editor value";
  };
  mock.window.showWarningMessage = async (message: string, options: any) => {
    assert.equal(message, "Full\npermission text");
    assert.equal(options.detail, "Pi Session 2");
    return "Allow";
  };
  try {
    editor.emit(event("label-input", "input", { title: "Input" }));
    editor.emit(event("label-confirm", "confirm", { message: "Full\npermission text" }));
    await tick();
    assert.deepEqual(editor.writes, [
      { id: "label-input", response: { value: "editor value" } },
      { id: "label-confirm", response: { confirmed: true } },
    ]);
  } finally {
    dialogs.dispose();
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
