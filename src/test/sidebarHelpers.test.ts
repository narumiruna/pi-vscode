import assert from "node:assert/strict";
import { ImageAssetCache, imageAssetId } from "../imageAssets";
import { installVscodeMock } from "./vscodeMock";

function gif(width: number, height: number, marker = 0): Buffer {
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[10] = marker;
  return bytes;
}

function imageCache(maxTotalBytes = 1024): ImageAssetCache {
  return new ImageAssetCache({ maxImageBytes: 100, maxTotalBytes, maxAssets: 10 });
}

test("Pi history conversion preserves observed text-plus-image user content and merges local labels by stable asset ID", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache();
    const data = gif(4, 5).toString("base64");
    const first = convertPiMessages([{ role: "user", timestamp: 10, content: [
      { type: "text", text: "<<<PI_VSCODE_CONTEXT_START: src/feature.ts:1-3>>>\ncode\n<<<PI_VSCODE_CONTEXT_END>>>\n<<<PI_VSCODE_REQUEST_START>>>\nWhat changed?\n<<<PI_VSCODE_REQUEST_END>>>" },
      { type: "image", mimeType: "image/gif", data },
    ] }], { imageAssets: cache });
    assert.equal(first[0]?.content, "What changed?");
    assert.deepEqual(first[0]?.attachments?.map(item => item.type), ["context", "image"]);
    const image = first[0]?.attachments?.[1];
    assert.equal(image?.type, "image");
    if (image?.type !== "image") assert.fail("expected image descriptor");
    assert.deepEqual({ label: image.label, width: image.width, height: image.height, availability: image.availability }, { label: "Image 1", width: 4, height: 5, availability: "available" });

    const known = [{ ...first[0]!, attachments: first[0]!.attachments!.map(item => item.type === "image" ? { ...item, label: "diagram.gif", fullLabel: "screenshots/diagram.gif" } : item) }];
    const refreshed = convertPiMessages([{ role: "user", timestamp: 10, content: [{ type: "text", text: "What changed?" }, { type: "image", mimeType: "image/gif", data }] }], { imageAssets: cache, knownMessages: known });
    const refreshedImage = refreshed[0]?.attachments?.[0];
    assert.equal(refreshedImage?.type, "image");
    if (refreshedImage?.type === "image") assert.deepEqual({ label: refreshedImage.label, fullLabel: refreshedImage.fullLabel }, { label: "diagram.gif", fullLabel: "screenshots/diagram.gif" });
  } finally { vscode.restore(); }
});

test("history synchronization preserves labels for each repeated image occurrence", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache();
    const data = gif(6, 7).toString("base64");
    const history = [
      { role: "user", timestamp: 1, content: [{ type: "text", text: "first" }, { type: "image", mimeType: "image/gif", data }] },
      { role: "assistant", timestamp: 2, content: [{ type: "text", text: "reply" }] },
      { role: "user", timestamp: 3, content: [{ type: "text", text: "second" }, { type: "image", mimeType: "image/gif", data }] },
    ];
    const initial = convertPiMessages(history, { imageAssets: cache });
    const known = initial.map((message, messageIndex) => ({
      ...message,
      attachments: message.attachments?.map(attachment => attachment.type === "image"
        ? { ...attachment, label: messageIndex === 0 ? "first.gif" : "second.gif", fullLabel: messageIndex === 0 ? "one/first.gif" : "two/second.gif" }
        : attachment),
    }));
    const refreshed = convertPiMessages(history, { imageAssets: cache, knownMessages: known });
    const labels = refreshed.flatMap(message => message.attachments ?? []).filter(attachment => attachment.type === "image").map(attachment => attachment.fullLabel);
    assert.deepEqual(labels, ["one/first.gif", "two/second.gif"]);
  } finally { vscode.restore(); }
});

test("history synchronization aligns retained labels with the newest surviving image occurrences", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache();
    const data = gif(8, 9).toString("base64");
    const history = ["oldest", "middle", "newest"].map((text, timestamp) => ({
      role: "user",
      timestamp,
      content: [{ type: "text", text }, { type: "image", mimeType: "image/gif", data }],
    }));
    const converted = convertPiMessages(history, { imageAssets: cache });
    const knownSuffix = converted.slice(-2).map((message, index) => ({
      ...message,
      attachments: message.attachments?.map(attachment => attachment.type === "image"
        ? { ...attachment, label: index ? "newest.gif" : "middle.gif", fullLabel: index ? "kept/newest.gif" : "kept/middle.gif" }
        : attachment),
    }));
    const refreshed = convertPiMessages(history, { imageAssets: cache, knownMessages: knownSuffix });
    const labels = refreshed.flatMap(message => message.attachments ?? []).filter(attachment => attachment.type === "image").map(attachment => attachment.fullLabel);
    assert.deepEqual(labels, ["Image 1", "kept/middle.gif", "kept/newest.gif"]);
  } finally { vscode.restore(); }
});

test("history conversion bounds the retained suffix before decoding image payloads", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache();
    const images = [1, 2, 3, 4].map(marker => gif(marker, marker, marker));
    const history = images.flatMap((bytes, index) => [
      {
        role: "user",
        timestamp: index,
        content: [{ type: "text", text: `message ${index}` }, { type: "image", mimeType: "image/gif", data: bytes.toString("base64") }],
      },
      { role: "toolResult", content: [{ type: "text", text: `tool ${index}` }] },
    ]);
    const converted = convertPiMessages(history, { imageAssets: cache, maxMessages: 2 });

    assert.deepEqual(converted.map(message => message.content), ["message 2", "message 3"]);
    assert.deepEqual(converted.map(message => message.id), ["pi-user-2-4", "pi-user-3-6"], "non-transcript entries do not reduce the retained count or change original indices");
    assert.equal(cache.size, 2);
    assert.equal(cache.has(imageAssetId(images[0]!)), false, "discarded history is never decoded or cached");
    assert.equal(cache.has(imageAssetId(images[1]!)), false, "only the retained suffix reaches image extraction");
    assert.equal(cache.has(imageAssetId(images[2]!)), true);
    assert.equal(cache.has(imageAssetId(images[3]!)), true);
  } finally { vscode.restore(); }
});

test("Pi history conversion deduplicates image payloads and preserves bounded unavailable placeholders", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache();
    const data = gif(1, 1).toString("base64");
    const converted = convertPiMessages([
      { role: "user", content: [{ type: "image", mimeType: "image/gif", data }, { type: "image", mimeType: "image/gif", data }] },
      { role: "user", content: [{ type: "image", mimeType: "image/svg+xml", data: "PHN2Zz4=" }, { type: "image", mimeType: "image/png", data: "not-base64" }] },
    ], { imageAssets: cache });
    const duplicate = converted[0]?.attachments ?? [];
    assert.equal(duplicate.length, 2);
    assert.equal(duplicate[0]?.type === "image" && duplicate[0].assetId, duplicate[1]?.type === "image" && duplicate[1].assetId);
    assert.equal(cache.size, 1);
    const unavailable = converted[1]?.attachments ?? [];
    assert.equal(unavailable.length, 2);
    assert.ok(unavailable.every(item => item.type === "image" && item.availability === "unavailable" && item.assetId.startsWith("unavailable-")));
  } finally { vscode.restore(); }
});

test("history conversion marks payloads evicted by the bounded cache unavailable", () => {
  const vscode = installVscodeMock();
  try {
    const { convertPiMessages } = require("../sidebarHelpers") as typeof import("../sidebarHelpers");
    const cache = imageCache(11);
    const converted = convertPiMessages([
      { role: "user", content: [{ type: "image", mimeType: "image/gif", data: gif(1, 1, 1).toString("base64") }] },
      { role: "user", content: [{ type: "image", mimeType: "image/gif", data: gif(2, 2, 2).toString("base64") }] },
    ], { imageAssets: cache });
    assert.equal(converted[0]?.attachments?.[0]?.type === "image" && converted[0].attachments[0].availability, "unavailable");
    assert.equal(converted[1]?.attachments?.[0]?.type === "image" && converted[1].attachments[0].availability, "available");
  } finally { vscode.restore(); }
});
