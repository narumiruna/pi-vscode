import path from "node:path";

const supportedImageMimeTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

export function imageMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    default:
      return undefined;
  }
}

export function isSupportedImageMimeType(value: string): boolean {
  return supportedImageMimeTypes.has(value.toLowerCase());
}

export function decodeBoundedBase64Image(data: string, maxBytes: number): Buffer | undefined {
  const maxCharacters = Math.ceil(maxBytes / 3) * 4 + 4;
  if (
    data.length === 0 ||
    data.length > maxCharacters ||
    data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(data)
  ) {
    return undefined;
  }
  const bytes = Buffer.from(data, "base64");
  return bytes.byteLength <= maxBytes && bytes.toString("base64") === data ? bytes : undefined;
}

export function isImageSizeAllowed(byteLength: number, maxBytes: number): boolean {
  return byteLength >= 0 && byteLength <= maxBytes;
}

export function withoutAttachmentIds<T extends { readonly id: string }>(
  attachments: readonly T[],
  removedIds: readonly string[],
): T[] {
  const removed = new Set(removedIds);
  return attachments.filter((attachment) => !removed.has(attachment.id));
}
