import path from "node:path";

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

export function isImageSizeAllowed(byteLength: number, maxBytes: number): boolean {
  return byteLength >= 0 && byteLength <= maxBytes;
}
