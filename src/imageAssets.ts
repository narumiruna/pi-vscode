import { createHash } from "node:crypto";
import { decodeBoundedBase64Image, isSupportedImageMimeType } from "./attachmentUtils";

export const transcriptImageAssetIdPattern = /^sha256-[a-f0-9]{64}$/;
const maxImagePixels = 4_096 * 4_096;

export interface ImageAssetDimensions {
  readonly width: number;
  readonly height: number;
}

export interface CachedImageAsset extends ImageAssetDimensions {
  readonly id: string;
  readonly mimeType: string;
  readonly data: string;
  readonly byteLength: number;
}

export interface ImageAssetCacheOptions {
  readonly maxImageBytes: number;
  readonly maxTotalBytes: number;
  readonly maxAssets: number;
}

export class ImageAssetDeliveryTracker {
  private readonly delivered = new Set<string>();

  public reset(): void { this.delivered.clear(); }
  public has(id: string): boolean { return this.delivered.has(id); }
  public retry(id: string): void { this.delivered.delete(id); }

  public pending(ids: Iterable<string>, cache: ImageAssetCache): CachedImageAsset[] {
    const assets: CachedImageAsset[] = [];
    for (const id of ids) {
      if (this.delivered.has(id)) continue;
      const asset = cache.get(id);
      if (!asset) continue;
      this.delivered.add(id);
      assets.push(asset);
    }
    return assets;
  }
}

export class ImageAssetCache {
  private readonly assets = new Map<string, CachedImageAsset>();
  private retainedBytes = 0;

  public constructor(private readonly options: ImageAssetCacheOptions) {}

  public get totalBytes(): number { return this.retainedBytes; }
  public get size(): number { return this.assets.size; }

  public store(mimeType: string, data: string): CachedImageAsset | undefined {
    const normalizedMimeType = mimeType.toLowerCase();
    if (!isSupportedImageMimeType(normalizedMimeType)) return undefined;
    const bytes = decodeBoundedBase64Image(data, this.options.maxImageBytes);
    if (!bytes) return undefined;
    const dimensions = imageDimensions(bytes, normalizedMimeType);
    if (!dimensions) return undefined;
    const id = imageAssetId(bytes);
    const existing = this.assets.get(id);
    if (existing) return existing.mimeType === normalizedMimeType ? existing : undefined;
    if (bytes.byteLength > this.options.maxTotalBytes || this.options.maxAssets <= 0) return undefined;

    while (
      this.assets.size > 0 &&
      (this.retainedBytes + bytes.byteLength > this.options.maxTotalBytes || this.assets.size >= this.options.maxAssets)
    ) {
      const oldestId = this.assets.keys().next().value as string | undefined;
      if (!oldestId) break;
      this.discard(oldestId);
    }
    const asset: CachedImageAsset = {
      id,
      mimeType: normalizedMimeType,
      data: bytes.toString("base64"),
      byteLength: bytes.byteLength,
      ...dimensions,
    };
    this.assets.set(id, asset);
    this.retainedBytes += asset.byteLength;
    return asset;
  }

  public get(id: string): CachedImageAsset | undefined { return this.assets.get(id); }
  public has(id: string): boolean { return this.assets.has(id); }

  public discard(id: string): boolean {
    const asset = this.assets.get(id);
    if (!asset) return false;
    this.assets.delete(id);
    this.retainedBytes -= asset.byteLength;
    return true;
  }

  public clear(): void { this.assets.clear(); this.retainedBytes = 0; }
}

export function imageAssetId(bytes: Uint8Array): string {
  return `sha256-${createHash("sha256").update(bytes).digest("hex")}`;
}

export function unavailableImageAssetId(seed: string): string {
  return `unavailable-${createHash("sha256").update(seed.slice(0, 10_000)).digest("hex")}`;
}

export function imageDimensions(bytes: Uint8Array, mimeType: string): ImageAssetDimensions | undefined {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let dimensions: ImageAssetDimensions | undefined;
  if (mimeType === "image/png") dimensions = pngDimensions(buffer);
  else if (mimeType === "image/jpeg") dimensions = jpegDimensions(buffer);
  else if (mimeType === "image/gif") dimensions = gifDimensions(buffer);
  else if (mimeType === "image/webp") dimensions = webpDimensions(buffer);
  return dimensions && validDimensions(dimensions) ? dimensions : undefined;
}

function pngDimensions(bytes: Buffer): ImageAssetDimensions | undefined {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || bytes.toString("ascii", 12, 16) !== "IHDR") return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function gifDimensions(bytes: Buffer): ImageAssetDimensions | undefined {
  const signature = bytes.toString("ascii", 0, 6);
  if (bytes.length < 10 || (signature !== "GIF87a" && signature !== "GIF89a")) return undefined;
  return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
}

function jpegDimensions(bytes: Buffer): ImageAssetDimensions | undefined {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return undefined;
  const startOfFrame = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return undefined;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    if (startOfFrame.has(marker)) {
      if (length < 7) return undefined;
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Buffer): ImageAssetDimensions | undefined {
  if (bytes.length < 30 || bytes.toString("ascii", 0, 4) !== "RIFF" || bytes.toString("ascii", 8, 12) !== "WEBP") return undefined;
  const kind = bytes.toString("ascii", 12, 16);
  if (kind === "VP8X") {
    return { width: 1 + readUInt24LE(bytes, 24), height: 1 + readUInt24LE(bytes, 27) };
  }
  if (kind === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + (bytes[21] | ((bytes[22] & 0x3f) << 8)),
      height: 1 + ((bytes[22] >> 6) | (bytes[23] << 2) | ((bytes[24] & 0x0f) << 10)),
    };
  }
  if (kind === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: bytes.readUInt16LE(26) & 0x3fff, height: bytes.readUInt16LE(28) & 0x3fff };
  }
  return undefined;
}

function readUInt24LE(bytes: Buffer, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function validDimensions(value: ImageAssetDimensions): boolean {
  return Number.isInteger(value.width) && Number.isInteger(value.height) && value.width > 0 && value.height > 0 && value.width <= 100_000 && value.height <= 100_000 && value.width * value.height <= maxImagePixels;
}
