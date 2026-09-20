import assert from "node:assert/strict";
import { consumedUnpinnedIds, contextMetadata, contextWarnings, inspectContext } from "../contextInspector";
import { ImageAssetCache } from "../imageAssets";
import { installVscodeMock, MockUri } from "./vscodeMock";

function freshSidebarAttachments(): typeof import("../sidebarAttachments") {
  for (const modulePath of ["../sidebarAttachments", "../sidebarHelpers", "../workflowUi"])
    delete require.cache[require.resolve(modulePath)];
  return require("../sidebarAttachments") as typeof import("../sidebarAttachments");
}

test("context estimates disclose multilingual bytes, image unknowns, malformed metadata and truncation", () => {
  const content = "漢字🙂";
  const item = {
    id: "snapshot",
    label: ".env",
    uri: MockUri.file("/tmp/.env"),
    content,
    metadata: contextMetadata(content, 100, 2, {
      sourceVersion: 7,
      range: { startLine: 0, startCharacter: 2, endLine: 1, endCharacter: 0 },
    }),
  };
  const result = inspectContext([
    item,
    { id: "image", label: "image", image: { data: Buffer.alloc(1024).toString("base64"), mimeType: "image/png" } },
  ]);
  assert.equal(result.characters, content.length);
  assert.equal(result.bytes, Buffer.byteLength(content) + 1024);
  assert.equal(result.imageUsage, "unknown");
  assert.match(result.text, /not Pi history/);
  assert.match(result.text, /excluded characters/);
  assert.match(result.text, /Source: file:.*\.env/);
  assert.match(result.text, /version 7; range 1:3–2:1/);
  assert.match(inspectContext([{ ...item, metadata: { ...item.metadata, capturedAt: NaN } }]).text, /capture unknown/);
  assert.equal(contextMetadata("abc", -1, NaN).originalLength, 3);
  assert.equal(contextWarnings("config", "api_key=supersecretvalue").length, 1);
  assert.deepEqual(
    consumedUnpinnedIds(
      [
        { ...item, metadata: { ...item.metadata, pinned: true } },
        { id: "newer", label: "new" },
      ],
      ["snapshot", "old"],
    ),
    [],
  );
});

test("submission snapshots bind descriptors to accepted items while rejection, cancellation, retry, and startup races preserve the right draft", async () => {
  const vscode = installVscodeMock();
  const { resolveSidebarQueueSubmission, resolveSidebarSubmissionText, SidebarAttachmentManager } =
    freshSidebarAttachments();
  assert.equal(resolveSidebarSubmissionText("Explain this", { textContexts: [], images: [] }), "Explain this");
  assert.equal(
    resolveSidebarSubmissionText("  ", { textContexts: [], images: [{} as any] }),
    "Please analyze the attached image.",
  );
  assert.equal(
    resolveSidebarSubmissionText("", { textContexts: [{} as any], images: [{}, {}] as any }),
    "Please analyze the attached images and context.",
  );
  assert.equal(resolveSidebarSubmissionText("", { textContexts: [], images: [] }), "");
  const queued = resolveSidebarQueueSubmission("", {
    textContexts: [{ label: "file.ts", content: "const value = 1;" }],
    images: [{} as any],
  });
  assert.equal(queued?.text, "Please analyze the attached images and context.");
  assert.match(
    queued?.message ?? "",
    /PICODE_CONTEXT_START: file\.ts[\s\S]*const value = 1;[\s\S]*PICODE_REQUEST_START[\s\S]*Please analyze the attached images and context/,
  );
  assert.throws(
    () => resolveSidebarQueueSubmission("/skill:test", { textContexts: [], images: [] }),
    /Slash commands cannot be queued/,
  );
  class CountingImageAssetCache extends ImageAssetCache {
    public storeCalls = 0;
    public override store(mimeType: string, data: string) {
      this.storeCalls += 1;
      return super.store(mimeType, data);
    }
  }
  const imageAssets = new CountingImageAssetCache({
    maxImageBytes: 5 * 1024 * 1024,
    maxTotalBytes: 25 * 1024 * 1024,
    maxAssets: 100,
  });
  const manager = new SidebarAttachmentManager({
    maxAttachments: 8,
    maxImageAttachments: 5,
    maxImageBytes: 5 * 1024 * 1024,
    maxAttachedCharacters: 100,
    maxTotalContextCharacters: 200,
    imageAssets,
    onChange: () => {},
    onNotice: () => {},
  });
  try {
    vscode.window.activeTextEditor = {
      document: { uri: MockUri.file("/tmp/first.ts"), version: 1, getText: () => "first" },
    };
    await manager.attachCurrentFile();
    const rejected = manager.captureSubmission();
    assert.equal(rejected.transcriptAttachments[0]?.type, "context");
    assert.equal(manager.values.length, 1, "rejected or cancelled submissions do not consume the captured draft");

    vscode.window.activeTextEditor = {
      document: { uri: MockUri.file("/tmp/second.ts"), version: 1, getText: () => "second" },
    };
    await manager.attachCurrentFile();
    const image = Buffer.alloc(11);
    image.write("GIF89a", 0, "ascii");
    image.writeUInt16LE(2, 6);
    image.writeUInt16LE(3, 8);
    manager.attachPastedImage({
      type: "pasteImage",
      data: image.toString("base64"),
      mimeType: "image/gif",
      fileName: "startup.gif",
    });
    rejected.consumeAccepted();
    assert.deepEqual(
      manager.values.map((item) => item.label),
      ["second.ts", "Pasted image: startup.gif"],
      "acceptance consumes only IDs captured before startup",
    );
    rejected.restoreConsumed();
    assert.deepEqual(
      manager.values.map((item) => item.label),
      ["second.ts", "Pasted image: startup.gif", "first.ts"],
      "recovery restores only the consumed snapshot and preserves newer attachments",
    );
    rejected.consumeAccepted();
    assert.equal(
      rejected.transcriptAttachments[0]?.fullLabel,
      "first.ts",
      "the accepted turn and retry retain their original descriptor snapshot",
    );

    const storesAfterAttach = imageAssets.storeCalls;
    const cancelled = manager.captureSubmission();
    assert.equal(manager.values.length, 2);
    assert.equal(cancelled.textContexts[0]?.content, "second");
    assert.equal(cancelled.recoveryBytes, Buffer.byteLength("second") + image.byteLength);
    assert.deepEqual(
      cancelled.transcriptAttachments.map((item) => item.type),
      ["context", "image"],
    );
    const composerImage = manager.summaries.find((item) => item.image);
    assert.equal(composerImage?.label, "startup.gif");
    assert.match(composerImage?.assetId ?? "", /^sha256-/);
    assert.equal(composerImage?.availability, "available");
    assert.equal(imageAssets.storeCalls, storesAfterAttach, "cached images are not decoded again for descriptors");
    assert.doesNotMatch(JSON.stringify([cancelled.transcriptAttachments, manager.summaries]), /R0lGOD|"data"/);
    assert.equal(imageAssets.storeCalls, storesAfterAttach);

    imageAssets.discard(composerImage!.assetId!);
    assert.equal(
      manager.summaries.find((item) => item.image)?.availability,
      "available",
      "an evicted draft image is recovered from its source data",
    );
    assert.equal(imageAssets.storeCalls, storesAfterAttach + 1);
    void manager.summaries;
    assert.equal(imageAssets.storeCalls, storesAfterAttach + 1, "the recovered image is reused on later reads");

    imageAssets.reject(composerImage!.assetId!);
    assert.equal(manager.summaries.find((item) => item.image)?.availability, "unavailable");
    assert.equal(imageAssets.storeCalls, storesAfterAttach + 1, "a rejected image is not decoded again");
    const rejectedPreview = manager.captureSubmission();
    assert.deepEqual(
      rejectedPreview.transcriptAttachments.map((item) => item.type),
      ["context", "image"],
      "a rejected preview keeps its unavailable transcript descriptor and recovery ownership",
    );
    const rejectedDescriptor = rejectedPreview.transcriptAttachments[1];
    assert.equal(rejectedDescriptor?.type === "image" ? rejectedDescriptor.availability : undefined, "unavailable");
    assert.equal(
      rejectedPreview.images.length,
      1,
      "the validated image payload remains queueable after preview rejection",
    );

    rejectedPreview.consumeAccepted();
    assert.equal(manager.values.length, 0);
    rejectedPreview.restoreConsumed();
    assert.deepEqual(
      manager.values.map((item) => item.label),
      ["second.ts", "Pasted image: startup.gif"],
      "text and rejected-preview image snapshots can be restored after verified queue clearing",
    );
  } finally {
    manager.dispose();
    vscode.restore();
  }
});

test("submission restoration is atomic when newer attachments consume the available budget", async () => {
  const vscode = installVscodeMock();
  const { SidebarAttachmentManager } = freshSidebarAttachments();
  const manager = new SidebarAttachmentManager({
    maxAttachments: 1,
    maxImageAttachments: 1,
    maxImageBytes: 1024,
    maxAttachedCharacters: 20,
    maxTotalContextCharacters: 20,
    imageAssets: new ImageAssetCache({ maxImageBytes: 1024, maxTotalBytes: 2048, maxAssets: 2 }),
    onChange: () => {},
    onNotice: () => {},
  });
  try {
    vscode.window.activeTextEditor = {
      document: { uri: MockUri.file("/tmp/first.ts"), version: 1, getText: () => "first" },
    };
    await manager.attachCurrentFile();
    const submission = manager.captureSubmission();
    submission.consumeAccepted();
    vscode.window.activeTextEditor = {
      document: { uri: MockUri.file("/tmp/second.ts"), version: 1, getText: () => "second" },
    };
    await manager.attachCurrentFile();
    assert.throws(() => submission.restoreConsumed(), /Remove context items/);
    assert.deepEqual(
      manager.values.map((item) => item.label),
      ["second.ts"],
      "failed recovery does not partially replace the current draft",
    );
  } finally {
    manager.dispose();
    vscode.restore();
  }
});

test("attachment snapshots retain pins, survive failed sends, consume only old revisions and send redacted text", async () => {
  const vscode = installVscodeMock();
  const { SidebarAttachmentManager } = freshSidebarAttachments();
  let text = "token=originalsecret";
  vscode.window.activeTextEditor = {
    document: { uri: MockUri.file("/tmp/context.ts"), version: 1, getText: () => text },
  };
  vscode.workspace.openTextDocument = async (input: unknown) => ({ getText: () => "redacted", input });
  vscode.window.showTextDocument = async () => undefined;
  const manager = new SidebarAttachmentManager({
    maxAttachments: 8,
    maxImageAttachments: 5,
    maxImageBytes: 5 * 1024 * 1024,
    maxAttachedCharacters: 20,
    maxTotalContextCharacters: 40,
    imageAssets: new ImageAssetCache({
      maxImageBytes: 5 * 1024 * 1024,
      maxTotalBytes: 25 * 1024 * 1024,
      maxAssets: 100,
    }),
    onChange: () => {},
    onNotice: () => {},
  });
  try {
    await manager.attachCurrentFile();
    const original = manager.values[0]!;
    assert.equal(manager.values.length, 1); // Failed/denied send never calls consume.
    const answers: unknown[] = [{ id: original.id }, "Edit / Redact"];
    vscode.window.showQuickPick = async () => answers.shift();
    vscode.window.showInformationMessage = async () => "Use Edited Snapshot";
    await manager.inspect();
    assert.equal(manager.textContexts[0]?.content, "redacted");
    assert.notEqual(manager.values[0]?.id, original.id);
    manager.consume([original.id]);
    assert.equal(manager.values.length, 1);
    const redacted = manager.values[0]!;
    answers.push({ id: redacted.id }, "Pin");
    await manager.inspect();
    const pinned = manager.values[0]!;
    const pinnedSubmission = manager.captureSubmission();
    assert.equal(
      pinnedSubmission.recoveryBytes,
      Buffer.byteLength("redacted"),
      "pinned snapshots count toward bounded recovery ownership",
    );
    pinnedSubmission.consumeAccepted();
    assert.equal(manager.values.length, 1, "acceptance does not consume a pinned snapshot");
    manager.remove(pinned.id);
    assert.equal(manager.values.length, 0);
    text = "new capture";
    await manager.attachCurrentFile();
    pinnedSubmission.restoreConsumed();
    assert.deepEqual(
      manager.textContexts.map((context) => context.content),
      ["new capture", "redacted"],
      "recovery restores the exact captured pin without replacing newer context",
    );
    assert.equal(manager.values.find((item) => item.id === pinned.id)?.metadata?.pinned, true);
    manager.clear();
    assert.equal(manager.values.length, 0);
  } finally {
    manager.dispose();
    vscode.restore();
  }
});
