import assert from "node:assert/strict";
import path from "node:path";
import type { CancellationToken, Position, Range, TextDocument } from "vscode";
import { boundCompletionContext, buildCompletionPrompt } from "../completion";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const invocation = require("../vscodePi") as typeof import("../vscodePi");
const { PiInlineCompletionProvider } = require("../inlineCompletion") as typeof import("../inlineCompletion");
const originalInvocation = invocation.invokePiWithCancellation;
const response = "<<<PI_VSCODE_COMPLETION_START>>>\ninsert\n<<<PI_VSCODE_COMPLETION_END>>>";
const settings = new Map<string, unknown>();
const file = "sample.ts";
const uri = MockUri.file(path.join("workspace", "src", file));
let invoke: ReturnType<typeof vi.fn<typeof invocation.invokePiWithCancellation>>;

beforeEach(() => {
  vi.useFakeTimers({ now: 0 });
  settings.clear();
  vscode.workspace.getConfiguration = (section: string, resource: MockUri) => {
    assert.equal(resource, uri);
    return { get: (key: string, fallback: unknown) => settings.get(`${section}.${key}`) ?? fallback };
  };
  invoke = vi.fn<typeof invocation.invokePiWithCancellation>(async () => response);
  invocation.invokePiWithCancellation = invoke;
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

afterAll(() => {
  invocation.invokePiWithCancellation = originalInvocation;
  vscode.restore();
});

function fixture(text: string, eol = "\n") {
  const lines = text.split(eol);
  let start = 0;
  const starts = lines.map((line) => {
    const lineStart = start;
    start += line.length + eol.length;
    return lineStart;
  });
  const offsetAt = ({ line, character }: Position) =>
    line >= lines.length ? text.length : starts[line] + Math.min(character, lines[line].length);
  const positionAt = (offset: number): Position => {
    let line = starts.length - 1;
    while (starts[line] > offset) line--;
    // VS Code clamps offsets between CR and LF to the end of the preceding line.
    return new vscode.Position(line, Math.min(offset - starts[line], lines[line].length));
  };
  const lineReads: number[] = [];
  const ranges: { start: number; end: number }[] = [];
  const document = {
    uri,
    version: 1,
    isClosed: false,
    languageId: "typescript",
    lineCount: lines.length,
    lineAt: (line: number) => {
      lineReads.push(line);
      return { text: lines[line] };
    },
    offsetAt,
    positionAt,
    getText: (range?: Range) => {
      assert.ok(range, "the provider must not read the whole document");
      const start = offsetAt(range.start);
      const end = offsetAt(range.end);
      ranges.push({ start, end });
      return text.slice(start, end);
    },
  };
  return { document, positionAt, lineReads, ranges };
}

function run(
  provider: InstanceType<typeof PiInlineCompletionProvider>,
  source: ReturnType<typeof fixture>,
  offset: number,
  triggerKind = vscode.InlineCompletionTriggerKind.Invoke,
  token: CancellationToken = new vscode.CancellationTokenSource().token,
) {
  return provider.provideInlineCompletionItems(
    source.document as unknown as TextDocument,
    source.positionAt(offset),
    { triggerKind, selectedCompletionInfo: undefined },
    token,
  );
}

const automatic = vscode.InlineCompletionTriggerKind.Automatic;
const largePrefix = `${"a".repeat(599_999)}\r\n${"p".repeat(11_999)}`;
const largeSuffix = `${"s".repeat(5_999)}\r\n${"z".repeat(600_000)}`;

test("an unchanged automatic hit schedules no timer, reads no document text, and makes no Pi call", async () => {
  settings.set("pi.inlineCompletions.enabled", true);
  const provider = new PiInlineCompletionProvider();
  const source = fixture(largePrefix + largeSuffix, "\r\n");
  const timer = vi.spyOn(globalThis, "setTimeout");

  const cold = run(provider, source, largePrefix.length, automatic);
  assert.deepEqual(
    timer.mock.calls.map(([, delay]) => delay),
    [650],
  );
  await vi.advanceTimersByTimeAsync(649);
  assert.equal(invoke.mock.calls.length, 0);
  assert.deepEqual(source.ranges, []);
  await vi.advanceTimersByTimeAsync(1);
  const coldItem = (await cold)?.[0];
  assert.equal(coldItem?.insertText, "insert");
  assert.deepEqual(source.lineReads, [1]);
  assert.deepEqual(
    source.ranges.map(({ start, end }) => end - start),
    [11_999, 5_999],
  );
  assert.equal(invoke.mock.calls.length, 1);

  const warm = run(provider, source, largePrefix.length, automatic);
  assert.equal(vi.getTimerCount(), 0);
  assert.equal(timer.mock.calls.length, 1);
  assert.deepEqual((await warm)?.[0], coldItem);
  assert.equal(source.lineReads.length, 1);
  assert.equal(source.ranges.length, 2);
  assert.equal(invoke.mock.calls.length, 1);

  const cancellation = new vscode.CancellationTokenSource();
  cancellation.cancel();
  assert.equal(await run(provider, source, largePrefix.length, automatic, cancellation.token), undefined);
  assert.equal(timer.mock.calls.length, 1);
  assert.equal(source.lineReads.length, 1);
  assert.equal(source.ranges.length, 2);
  assert.equal(invoke.mock.calls.length, 1);
});

test.each([
  { name: "start of LF document", prefix: "", suffix: "🌱\nlet n = 1;", eol: "\n" },
  { name: "middle of CRLF document", prefix: "// 😀\r\nlet ", suffix: "n = 1;\r\n", eol: "\r\n" },
  { name: "end of LF document", prefix: "let n = 1;\n// 🌱", suffix: "", eol: "\n" },
  { name: "CRLF at both bounds", prefix: largePrefix, suffix: largeSuffix, eol: "\r\n" },
  {
    name: "surrogate pairs at both bounds",
    prefix: `${"a".repeat(600_000)}😀${"b".repeat(11_999)}`,
    suffix: `${"c".repeat(5_999)}🦊${"d".repeat(600_000)}`,
    eol: "\n",
  },
])("the miss prompt matches the old UTF-16 slices: $name", async ({ prefix, suffix, eol }) => {
  const source = fixture(prefix + suffix, eol);
  const pending = run(new PiInlineCompletionProvider(), source, prefix.length);
  assert.deepEqual(source.ranges, []);
  await vi.advanceTimersByTimeAsync(650);
  const result = await pending;
  assert.equal(result?.[0].insertText, "insert");
  assert.deepEqual(result?.[0]?.range?.start, source.positionAt(prefix.length));
  assert.deepEqual(result?.[0]?.range?.end, source.positionAt(prefix.length));
  assert.equal(source.ranges.length, 2);
  const [prefixUnits, suffixUnits] = source.ranges.map(({ start, end }) => end - start);
  assert.ok(prefixUnits <= 12_000);
  assert.ok(suffixUnits <= 6_000);
  assert.equal(invoke.mock.calls.length, 1);
  assert.equal(invoke.mock.calls[0][2], uri);
  assert.equal(
    invoke.mock.calls[0][0],
    buildCompletionPrompt({ file, languageId: "typescript", ...boundCompletionContext(prefix, suffix, 12_000, 6_000) }),
  );
});

test("cache identity follows the document instance, version, offset, language, and effective launch settings", async () => {
  const provider = new PiInlineCompletionProvider();
  const source = fixture("let n = 1;");
  const miss = async (doc: typeof source, offset: number) => {
    const start = invoke.mock.calls.length;
    const pending = run(provider, doc, offset);
    assert.equal(vi.getTimerCount(), 1);
    await vi.advanceTimersByTimeAsync(650);
    assert.equal((await pending)?.[0]?.insertText, "insert");
    assert.equal(invoke.mock.calls.length, start + 1);
  };

  await miss(source, 5);
  await miss(source, 6);
  source.document.version++;
  await miss(source, 6);
  source.document.languageId = "javascript";
  await miss(source, 6);
  settings.set("pi.model", "another-model");
  await miss(source, 6);
  source.document.isClosed = true;
  assert.equal(await run(provider, source, 6), undefined);
  settings.delete("pi.model");
  // Same URI, content, version, offset, and settings as the first request, but a new document instance.
  await miss(fixture("let n = 1;"), 5);
});

test("a miss reuses an answer that another request has cached during its debounce", async () => {
  const provider = new PiInlineCompletionProvider();
  const source = fixture("let n = 1;");
  const first = run(provider, source, 5);
  await vi.advanceTimersByTimeAsync(1);
  const overlapping = run(provider, source, 5);
  await vi.advanceTimersByTimeAsync(649);
  assert.ok(await first);
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(1);
  assert.deepEqual(await overlapping, await first);
  assert.equal(source.ranges.length, 2);
  assert.equal(source.lineReads.length, 1);
  assert.equal(invoke.mock.calls.length, 1);
});

test("a cached answer expires after 30 seconds", async () => {
  const provider = new PiInlineCompletionProvider();
  const source = fixture("let n = 1;");
  const cold = run(provider, source, 5);
  await vi.advanceTimersByTimeAsync(650);
  assert.ok(await cold);
  vi.setSystemTime(Date.now() + 30_000);
  const hit = run(provider, source, 5);
  assert.equal(vi.getTimerCount(), 0);
  assert.ok(await hit);
  vi.setSystemTime(Date.now() + 1);
  const expired = run(provider, source, 5);
  assert.equal(vi.getTimerCount(), 1);
  await vi.advanceTimersByTimeAsync(650);
  assert.ok(await expired);
  assert.equal(invoke.mock.calls.length, 2);
});

test("manual invoke bypasses automatic enablement and minimum length but not excluded languages", async () => {
  const provider = new PiInlineCompletionProvider();
  const source = fixture("  a  ");
  const cursor = 5;
  const expectNoTimer = async (pending: ReturnType<typeof run>, hasResult: boolean) => {
    assert.equal(vi.getTimerCount(), 0);
    assert.equal(Boolean(await pending), hasResult);
  };

  await expectNoTimer(run(provider, source, cursor, automatic), false);
  assert.equal(source.lineReads.length, 0);
  const manual = run(provider, source, cursor);
  await vi.advanceTimersByTimeAsync(650);
  assert.ok(await manual);
  await expectNoTimer(run(provider, source, cursor), true);
  await expectNoTimer(run(provider, source, cursor, automatic), false);
  settings.set("pi.inlineCompletions.enabled", true);
  await expectNoTimer(run(provider, source, cursor, automatic), false);
  settings.set("pi.inlineCompletions.minimumPrefixLength", 1);
  await expectNoTimer(run(provider, source, cursor, automatic), true);
  settings.set("pi.inlineCompletions.excludedLanguages", ["typescript"]);
  await expectNoTimer(run(provider, source, cursor), false);
  assert.equal(source.lineReads.length, 1);
  assert.equal(source.ranges.length, 2);
  assert.equal(invoke.mock.calls.length, 1);
});

test.each(["cancelled", "changed", "closed"])(
  "%s during debounce prevents range reads and Pi dispatch",
  async (mode) => {
    const provider = new PiInlineCompletionProvider();
    const source = fixture("let n = 1;");
    const cancellation = new vscode.CancellationTokenSource();
    const pending = run(provider, source, 5, undefined, cancellation.token);
    assert.equal(vi.getTimerCount(), 1);
    if (mode === "cancelled") {
      cancellation.cancel();
      assert.equal(vi.getTimerCount(), 0);
    } else if (mode === "changed") {
      source.document.version++;
    } else {
      source.document.isClosed = true;
    }
    await vi.advanceTimersByTimeAsync(650);
    assert.equal(await pending, undefined);
    assert.deepEqual(source.lineReads, []);
    assert.deepEqual(source.ranges, []);
    assert.equal(invoke.mock.calls.length, 0);
  },
);

test.each(["cancelled", "changed", "closed", "settings changed"])(
  "%s during Pi invocation prevents insertion and caching",
  async (mode) => {
    const provider = new PiInlineCompletionProvider();
    const source = fixture("let n = 1;");
    const cancellation = new vscode.CancellationTokenSource();
    let finish!: (value: string) => void;
    invoke.mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)));
    const pending = run(provider, source, 5, undefined, cancellation.token);
    await vi.advanceTimersByTimeAsync(650);
    assert.equal(invoke.mock.calls.length, 1);
    if (mode === "cancelled") cancellation.cancel();
    else if (mode === "changed") source.document.version++;
    else if (mode === "closed") source.document.isClosed = true;
    else settings.set("pi.provider", "another-provider");
    finish(response);
    assert.equal(await pending, undefined);

    // Restore the captured inputs to see if the rejected result was cached.
    source.document.isClosed = false;
    source.document.version = 1;
    settings.delete("pi.provider");
    const fresh = run(provider, source, 5);
    assert.equal(vi.getTimerCount(), 1);
    await vi.advanceTimersByTimeAsync(650);
    assert.ok(await fresh);
    assert.equal(invoke.mock.calls.length, 2);
  },
);
