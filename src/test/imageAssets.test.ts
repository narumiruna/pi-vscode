import assert from "node:assert/strict";
import { ImageAssetCache, ImageAssetDeliveryTracker, imageAssetId } from "../imageAssets";

function gif(width: number, height: number, marker = 0): Buffer {
  const bytes = Buffer.alloc(11);
  bytes.write("GIF89a", 0, "ascii");
  bytes.writeUInt16LE(width, 6);
  bytes.writeUInt16LE(height, 8);
  bytes[10] = marker;
  return bytes;
}

function cache(maxTotalBytes = 1024, maxAssets = 10): ImageAssetCache {
  return new ImageAssetCache({ maxImageBytes: 100, maxTotalBytes, maxAssets });
}

test("image assets validate MIME, canonical Base64, decoded size, format, and dimensions", () => {
  const assets = cache();
  const bytes = gif(2, 3);
  const stored = assets.store("IMAGE/GIF", bytes.toString("base64"));
  assert.equal(stored?.id, imageAssetId(bytes));
  assert.deepEqual({ mimeType: stored?.mimeType, width: stored?.width, height: stored?.height }, { mimeType: "image/gif", width: 2, height: 3 });
  assert.equal(assets.store("image/svg+xml", bytes.toString("base64")), undefined);
  assert.equal(assets.store("image/gif", "not base64"), undefined);
  assert.equal(assets.store("image/gif", Buffer.alloc(101).toString("base64")), undefined);
  assert.equal(assets.store("image/png", bytes.toString("base64")), undefined, "declared MIME must match a supported image header");
  const maximumDimensions = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(maximumDimensions);
  maximumDimensions.write("IHDR", 12);
  maximumDimensions.writeUInt32BE(4_096, 16);
  maximumDimensions.writeUInt32BE(4_096, 20);
  assert.ok(assets.store("image/png", maximumDimensions.toString("base64")), "the documented 4096-square boundary remains available");
  const oversizedDimensions = Buffer.from(maximumDimensions);
  oversizedDimensions.writeUInt32BE(4_097, 16);
  oversizedDimensions.writeUInt32BE(4_097, 20);
  assert.equal(assets.store("image/png", oversizedDimensions.toString("base64")), undefined, "images above the decoded-pixel budget are rejected");
});

test("PNG, JPEG, GIF, and WebP dimensions are parsed from bounded headers", () => {
  const png = Buffer.alloc(24); Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png); png.write("IHDR", 12); png.writeUInt32BE(7, 16); png.writeUInt32BE(8, 20);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x07, 0x08, 0x00, 0x09, 0x00, 0x0a]);
  const webp = Buffer.alloc(30); webp.write("RIFF", 0); webp.write("WEBP", 8); webp.write("VP8X", 12); webp[24] = 10; webp[27] = 11;
  const assets = cache();
  assert.deepEqual(pickDimensions(assets.store("image/png", png.toString("base64"))), { width: 7, height: 8 });
  assert.deepEqual(pickDimensions(assets.store("image/jpeg", jpeg.toString("base64"))), { width: 10, height: 9 });
  assert.deepEqual(pickDimensions(assets.store("image/gif", gif(5, 6).toString("base64"))), { width: 5, height: 6 });
  assert.deepEqual(pickDimensions(assets.store("image/webp", webp.toString("base64"))), { width: 11, height: 12 });
});

function pickDimensions(asset: { readonly width: number; readonly height: number } | undefined): { width: number; height: number } | undefined {
  return asset && { width: asset.width, height: asset.height };
}

test("image cache deduplicates stable content and evicts oldest payloads within byte and count bounds", () => {
  const assets = cache(22, 2);
  const first = assets.store("image/gif", gif(1, 1, 1).toString("base64"))!;
  assert.equal(assets.store("image/gif", gif(1, 1, 1).toString("base64")), first);
  const second = assets.store("image/gif", gif(2, 2, 2).toString("base64"))!;
  assert.equal(assets.size, 2);
  const third = assets.store("image/gif", gif(3, 3, 3).toString("base64"))!;
  assert.equal(assets.has(first.id), false);
  assert.equal(assets.has(second.id), true);
  assert.equal(assets.has(third.id), true);
  assert.equal(assets.totalBytes, 22);
  assert.equal(assets.discard(second.id), true);
  assert.equal(assets.discard(second.id), false);
  assert.equal(assets.size, 1);
  assert.equal(assets.totalBytes, 11);
});

test("one-shot delivery deduplicates state updates, skips evicted payloads, retries failed posts, and resets for a recreated webview", () => {
  const assets = cache(11, 1);
  const first = assets.store("image/gif", gif(1, 1, 1).toString("base64"))!;
  const delivery = new ImageAssetDeliveryTracker();
  assert.deepEqual(delivery.pending([first.id, first.id], assets).map(asset => asset.id), [first.id]);
  assert.deepEqual(delivery.pending([first.id], assets), []);
  delivery.retry(first.id);
  assert.deepEqual(delivery.pending([first.id], assets).map(asset => asset.id), [first.id]);
  const second = assets.store("image/gif", gif(2, 2, 2).toString("base64"))!;
  assert.deepEqual(delivery.pending([first.id, second.id], assets).map(asset => asset.id), [second.id]);
  delivery.reset();
  assert.deepEqual(delivery.pending([second.id], assets).map(asset => asset.id), [second.id]);
});
