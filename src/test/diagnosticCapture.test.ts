import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  aliasedDiagnosticEncodings,
  diagnosticEncodingAgreementFixtures,
  diagnosticEncodingFixtures,
  unsupportedDiagnosticEncodings,
} from "./diagnosticEncodingFixtures";
import { installVscodeMock, MockUri } from "./vscodeMock";

const vscode = installVscodeMock();
const safeText = "safe workspace text\n";
const foreignText = "FOREIGN_SECRET_DO_NOT_SEND\n";

async function fixture(action: (state: Awaited<ReturnType<typeof setup>>) => Promise<void>, alias = false) {
  const state = await setup(alias);
  try {
    await action(state);
  } finally {
    for (const item of state.context.subscriptions) item.dispose();
    await rm(state.directory, { recursive: true, force: true });
  }
}

async function setup(alias: boolean) {
  const directory = await mkdtemp(path.join(tmpdir(), "pi-diagnostic-capture-"));
  const root = path.join(directory, "workspace");
  const parent = path.join(root, "src");
  const outside = path.join(directory, "outside");
  const saved = path.join(directory, "saved");
  const workspacePath = alias ? path.join(directory, "alias") : root;
  await mkdir(parent, { recursive: true });
  await mkdir(path.join(outside, "src"), { recursive: true });
  if (alias) await symlink(root, workspacePath, "junction");
  const file = path.join(parent, "a.ts");
  await writeFile(file, safeText);
  await writeFile(path.join(outside, "a.ts"), foreignText);
  await writeFile(path.join(outside, "src", "a.ts"), foreignText);
  const context: any = { subscriptions: [] };
  const folder = { uri: MockUri.file(workspacePath), name: "Fixture" };
  const document = {
    uri: MockUri.file(path.join(workspacePath, "src", "a.ts")),
    version: 1,
    isClosed: false,
    isDirty: false,
    eol: 1,
    text: safeText,
    getText() {
      return this.text;
    },
  };
  const diagnostic = {
    message: "wrong type",
    severity: 0,
    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
  };
  const errors: string[] = [];
  const sent: string[] = [];
  const inspected: string[] = [];
  const providers = new Map<string, any>();
  const hooks = { beforeOpen: async () => {}, duringStat: async () => {}, beforeConfirm: async () => {} };
  let fileOpens = 0;
  vscode.workspace.isTrusted = true;
  vscode.workspace.workspaceFolders = [folder];
  vscode.workspace.textDocuments = [];
  vscode.workspace.getWorkspaceFolder = () => folder;
  vscode.workspace.getConfiguration = () => ({ get: (_key: string, fallback: unknown) => fallback });
  vscode.workspace.fs = {
    isWritableFileSystem: () => true,
    stat: async () => {
      await hooks.duringStat();
      return { permissions: 0 };
    },
  };
  vscode.workspace.registerTextDocumentContentProvider = (scheme: string, provider: any) => {
    providers.set(scheme, provider);
    return { dispose() {} };
  };
  vscode.workspace.openTextDocument = async (target: any) => {
    if (target.scheme !== "file") {
      inspected.push(providers.get(target.scheme).provideTextDocumentContent(target));
      return { uri: target };
    }
    fileOpens++;
    await hooks.beforeOpen();
    // Real pathname read, not synthesized foreign content. This is the mocked
    // VS Code boundary, deliberately independent of the safe snapshot reader.
    document.text = await readFile(target.fsPath, "utf8");
    vscode.workspace.textDocuments.push(document);
    return document;
  };
  vscode.window.showTextDocument = async () => undefined;
  vscode.window.showQuickPick = async (items: any[]) => items;
  vscode.window.showWarningMessage = async () => {
    await hooks.beforeConfirm();
    return "Send Diagnostic Repair";
  };
  vscode.window.showErrorMessage = async (message: string) => {
    errors.push(message);
  };
  vscode.languages.getDiagnostics = (target?: any) => (target ? [diagnostic] : [[document.uri, [diagnostic]]]);
  const { registerWorkspaceDiagnostics } =
    require("../workspaceDiagnosticsController") as typeof import("../workspaceDiagnosticsController");
  registerWorkspaceDiagnostics(
    context,
    {
      currentCwd: root,
      currentState: { connected: true, sessionId: "s", busy: false },
    } as any,
    {
      sendRequest: async (_request, captured, options) => {
        options?.validate?.();
        sent.push(captured[0]!.content);
        return "";
      },
      addEditProposal: () => "unused",
    },
  );
  return {
    directory,
    root,
    parent,
    outside,
    saved,
    workspacePath,
    file,
    context,
    document,
    errors,
    sent,
    inspected,
    hooks,
    fileOpens: () => fileOpens,
    run: async () => {
      await vscode.registrations.get("picode.fixWorkspaceDiagnostics")!();
    },
  };
}

// Existing dirty buffers are the only disk-mismatch exception. Newly loaded
// buffers must not become exempt just because isDirty changes during the await.
for (const alias of [false, true]) {
  test.each(["leaf", "parent", "restored-parent", "new-dirty"])(
    `diagnostic capture rejects %s substitution during open (alias: ${alias})`,
    async (swap) =>
      fixture(async (state) => {
        const { file, parent, outside, saved, document, hooks } = state;
        hooks.beforeOpen = async () => {
          if (swap === "leaf") {
            await rename(file, saved);
            await symlink(path.join(outside, "a.ts"), file);
          } else {
            await rename(parent, saved);
            await symlink(outside, parent, "junction");
          }
        };
        hooks.duringStat = async () => {
          if (swap === "restored-parent" || swap === "new-dirty") {
            await unlink(parent);
            await rename(saved, parent);
          }
          if (swap === "new-dirty") document.isDirty = true;
        };
        await state.run();
        assert.equal(
          document.text,
          foreignText,
          `The VS Code boundary must follow the substitution: ${state.errors.join("; ")}`,
        );
        assert.deepEqual(state.sent, [], "Never submit foreign bytes, even after confirmation");
        assert.deepEqual(state.inspected, [], "Reject before retaining foreign inspection text");
        assert.equal(state.errors.length, 1);
        assert.match(state.errors[0]!, /changed|match|canonical|Symlink/i);
      }, alias),
  );

  test.each([false, true])(`diagnostic capture preserves stable buffers (dirty: %s, alias: ${alias})`, async (dirty) =>
    fixture(async (state) => {
      state.document.isDirty = dirty;
      if (dirty) {
        state.document.text = "explicit unsaved editor text\n";
        vscode.workspace.textDocuments = [state.document];
      }
      await state.run();
      assert.deepEqual(state.errors, []);
      assert.equal(state.sent.length, 1);
      assert.equal(JSON.parse(state.sent[0]!).files[0].content, dirty ? state.document.text : safeText);
      assert.equal(state.fileOpens(), dirty ? 0 : 1, "Do not reopen a dirty buffer through a mutable pathname");
    }, alias),
  );
}

test.each([
  "dirty-edit",
  "dirty-close",
  "clean-edit",
  "confirm-edit",
  "confirm-close",
  "deleted",
  "oversized",
  "alias-retarget",
])("diagnostic capture rejects %s without submission", async (failure) =>
  fixture(async (state) => {
    if (failure.startsWith("dirty-")) {
      state.document.isDirty = true;
      state.document.text = "unsaved\n";
      vscode.workspace.textDocuments = [state.document];
    }
    const change = () => {
      if (failure.endsWith("close")) state.document.isClosed = true;
      else {
        state.document.version++;
        state.document.text = "changed during await\n";
      }
    };
    if (failure.startsWith("confirm-")) state.hooks.beforeConfirm = async () => change();
    else if (failure.endsWith("edit") || failure.endsWith("close")) state.hooks.duringStat = async () => change();
    else if (failure === "deleted") await unlink(state.file);
    else if (failure === "oversized") await writeFile(state.file, "x".repeat(400_004));
    else
      state.hooks.duringStat = async () => {
        await unlink(state.workspacePath);
        await symlink(state.outside, state.workspacePath, "junction");
      };
    await state.run();
    assert.deepEqual(state.sent, []);
    assert.equal(state.errors.length, 1);
    if (failure === "deleted" || failure === "oversized") assert.equal(state.fileOpens(), 0);
  }, true),
);

// VS Code removes the BOM and normalizes all line endings to TextDocument.eol.
// Its decoded text still has to be derived from the safely captured bytes.
test.each([
  { name: "UTF-8 BOM and mixed CRLF", bytes: Buffer.from("\ufeffa\rb\r\nc\n"), text: "a\r\nb\r\nc\r\n", eol: 2 },
  { name: "UTF-16LE BOM", bytes: Buffer.from("\ufeffa\r\nb\n", "utf16le"), text: "a\nb\n", eol: 1 },
  { name: "UTF-16BE BOM", bytes: Buffer.from("\ufeffa\n", "utf16le").swap16(), text: "a\n", eol: 1 },
  { name: "multibyte character bound", bytes: Buffer.from("界".repeat(100_000)), text: "界".repeat(100_000), eol: 1 },
  { name: "configured windows1252", bytes: Buffer.from([0x80, 0x0a]), text: "€\n", eol: 1, encoding: "windows1252" },
  {
    name: "BOM overrides configured alias",
    bytes: Buffer.from("\ufeff日本\r\n"),
    text: "日本\r\n",
    eol: 2,
    encoding: "shiftjis",
  },
])("diagnostic capture matches $name", async ({ bytes, text, eol, encoding }) =>
  fixture(async (state) => {
    await writeFile(state.file, bytes);
    state.document.eol = eol;
    state.hooks.duringStat = async () => {
      state.document.text = text;
    };
    if (encoding) vscode.workspace.getConfiguration = () => ({ get: () => encoding });
    await state.run();
    assert.deepEqual(state.errors, []);
    assert.equal(state.sent.length, 1);
    assert.equal(JSON.parse(state.sent[0]!).files[0].content, text);
  }),
);

test.each(diagnosticEncodingFixtures)(
  "diagnostic capture verifies VS Code encoding $encoding",
  async ({ encoding, hex, text }) =>
    fixture(async (state) => {
      await writeFile(state.file, Buffer.from(hex, "hex"));
      vscode.workspace.getConfiguration = () => ({ get: () => encoding });
      state.hooks.duringStat = async () => {
        state.document.text = text;
      };
      await state.run();
      assert.deepEqual(state.errors, []);
      assert.equal(state.sent.length, 1);
      assert.equal(JSON.parse(state.sent[0]!).files[0].content, text);
    }),
);

test.each(diagnosticEncodingAgreementFixtures)(
  "diagnostic capture requires codec-table agreement for $encoding",
  async ({ encoding, canonicalEncoding, hex, text }) =>
    fixture(async (state) => {
      const bytes = Buffer.from(hex, "hex");
      const matchesEditor = new TextDecoder(canonicalEncoding, { fatal: true }).decode(bytes) === text;
      await writeFile(state.file, bytes);
      vscode.workspace.getConfiguration = () => ({ get: () => encoding });
      state.hooks.duringStat = async () => {
        state.document.text = text;
      };
      await state.run();
      if (matchesEditor) {
        assert.deepEqual(state.errors, []);
        assert.equal(state.sent.length, 1);
        assert.equal(JSON.parse(state.sent[0]!).files[0].content, text);
      } else {
        assert.deepEqual(state.sent, []);
        assert.deepEqual(state.inspected, []);
        assert.equal(state.errors.length, 1);
        assert.match(state.errors[0]!, /does not match safely captured file/);
      }
    }),
);

test.each(unsupportedDiagnosticEncodings)("diagnostic capture rejects unsupported VS Code codec %s", async (encoding) =>
  fixture(async (state) => {
    vscode.workspace.getConfiguration = () => ({ get: () => encoding });
    await state.run();
    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.inspected, []);
    assert.equal(state.errors.length, 1);
    assert.match(state.errors[0]!, /Cannot verify diagnostic file encoding/);
  }),
);

test.each(aliasedDiagnosticEncodings)("diagnostic capture still rejects mismatched text for %s", async (encoding) =>
  fixture(async (state) => {
    const sample = diagnosticEncodingFixtures.find((sample) => sample.encoding === encoding)!;
    await writeFile(state.file, Buffer.from(sample.hex, "hex"));
    vscode.workspace.getConfiguration = () => ({ get: () => encoding });
    state.hooks.duringStat = async () => {
      state.document.text = foreignText;
    };
    await state.run();
    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.inspected, []);
    assert.equal(state.errors.length, 1);
    assert.match(state.errors[0]!, /does not match safely captured file/);
  }),
);

test.each([
  { encoding: "shiftjis", hex: "82" },
  { encoding: "eucjp", hex: "a4" },
  { encoding: "euckr", hex: "c7" },
  { encoding: "cp950", hex: "a4" },
  { encoding: "big5hkscs", hex: "9d" },
])("diagnostic capture rejects truncated $encoding instead of replacement decoding", async ({ encoding, hex }) =>
  fixture(async (state) => {
    await writeFile(state.file, Buffer.from(hex, "hex"));
    vscode.workspace.getConfiguration = () => ({ get: () => encoding });
    state.hooks.duringStat = async () => {
      state.document.text = "\ufffd";
    };
    await state.run();
    assert.deepEqual(state.sent, []);
    assert.deepEqual(state.inspected, []);
    assert.equal(state.errors.length, 1);
    assert.match(state.errors[0]!, /Cannot verify diagnostic file encoding/);
  }),
);

test.each(["invalid-utf8", "unsupported-encoding", "binary", "character-limit"])(
  "diagnostic capture fails closed for %s",
  async (failure) =>
    fixture(async (state) => {
      if (failure === "invalid-utf8") await writeFile(state.file, Buffer.from([0xff, 0x0a]));
      if (failure === "unsupported-encoding") vscode.workspace.getConfiguration = () => ({ get: () => "unsupported" });
      if (failure === "binary") await writeFile(state.file, "zero\0byte");
      if (failure === "character-limit") await writeFile(state.file, "x".repeat(100_001));
      await state.run();
      assert.deepEqual(state.sent, []);
      assert.deepEqual(state.inspected, []);
      assert.equal(state.errors.length, 1);
    }),
);
