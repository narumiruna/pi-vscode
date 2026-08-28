import { StringDecoder } from "node:string_decoder";

export const maxBridgeLineBytes = 1024 * 1024;

export interface VscodeBridgeRequest {
  readonly id: string;
  readonly token: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export class VscodeBridgeLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private failed = false;

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: Buffer): void {
    this.assertUsable();
    this.buffer += this.decoder.write(chunk);
    this.drain();
    this.assertWithinLimit(this.buffer);
  }

  public end(): void {
    this.assertUsable();
    this.buffer += this.decoder.end();
    this.assertWithinLimit(this.buffer);
    if (this.buffer.length > 0) {
      this.onLine(stripCarriageReturn(this.buffer));
      this.buffer = "";
    }
  }

  private drain(): void {
    while (true) {
      const newlineIndex = this.buffer.indexOf("\n");
      if (newlineIndex < 0) {
        return;
      }
      const line = this.buffer.slice(0, newlineIndex);
      this.assertWithinLimit(line);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      this.onLine(stripCarriageReturn(line));
    }
  }

  private assertUsable(): void {
    if (this.failed) {
      throw new Error("VS Code bridge decoder is no longer usable after a framing error.");
    }
  }

  private assertWithinLimit(value: string): void {
    if (Buffer.byteLength(value, "utf8") <= maxBridgeLineBytes) {
      return;
    }
    this.failed = true;
    this.buffer = "";
    throw new Error("VS Code bridge request exceeded 1 MiB.");
  }
}

export function parseVscodeBridgeRequest(line: string): VscodeBridgeRequest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error("VS Code bridge request was not valid JSON.");
  }
  if (!isRecord(value)) {
    throw new Error("VS Code bridge request must be an object.");
  }
  if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 200) {
    throw new Error("VS Code bridge request has an invalid id.");
  }
  if (typeof value.token !== "string" || value.token.length === 0 || value.token.length > 256) {
    throw new Error("VS Code bridge request has an invalid token.");
  }
  if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 100) {
    throw new Error("VS Code bridge request has an invalid method.");
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new Error("VS Code bridge request params must be an object.");
  }
  return {
    id: value.id,
    token: value.token,
    method: value.method,
    params: value.params ?? {},
  };
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
