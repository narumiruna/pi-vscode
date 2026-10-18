import { StringDecoder } from "node:string_decoder";

export const maxBridgeLineBytes = 1024 * 1024;
export const vscodeBridgePortEnvironmentKey = "PI_VSCODE_BRIDGE_PORT";
export const vscodeBridgeTokenEnvironmentKey = "PI_VSCODE_BRIDGE_TOKEN";
export const vscodeBridgeExtensionEnvironmentKey = "PI_VSCODE_BRIDGE_EXTENSION";

export interface VscodeBridgeRequest {
  readonly id: string;
  readonly token: string;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

export interface VscodeBridgeEvent {
  readonly type: "event";
  readonly event: string;
  readonly data: unknown;
}

export class VscodeBridgeLineDecoder {
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private bufferedBytes = 0;
  private newlineIndex = -1;
  private failed = false;

  public constructor(private readonly onLine: (line: string) => void) {}

  public push(chunk: Buffer): void {
    this.assertUsable();
    const decoded = this.decoder.write(chunk);
    // Only new text can introduce the first newline in an incomplete frame.
    if (this.newlineIndex < 0) {
      const newline = decoded.indexOf("\n");
      if (newline >= 0) this.newlineIndex = this.buffer.length + newline;
    }
    this.buffer += decoded;
    this.bufferedBytes += Buffer.byteLength(decoded, "utf8");
    this.drain();
    this.assertWithinLimit(this.bufferedBytes);
  }

  public end(): void {
    this.assertUsable();
    this.buffer += this.decoder.end();
    this.bufferedBytes = Buffer.byteLength(this.buffer, "utf8");
    this.assertWithinLimit(this.bufferedBytes);
    if (this.buffer.length > 0) {
      this.onLine(stripCarriageReturn(this.buffer));
      this.buffer = "";
      this.bufferedBytes = 0;
      this.newlineIndex = -1;
    }
  }

  private drain(): void {
    while (this.newlineIndex >= 0) {
      const line = this.buffer.slice(0, this.newlineIndex);
      const lineBytes = Buffer.byteLength(line, "utf8");
      this.assertWithinLimit(lineBytes);
      this.buffer = this.buffer.slice(this.newlineIndex + 1);
      this.bufferedBytes -= lineBytes + 1;
      this.newlineIndex = this.buffer.indexOf("\n");
      this.onLine(stripCarriageReturn(line));
    }
  }

  private assertUsable(): void {
    if (this.failed) {
      throw new Error("VS Code bridge decoder is no longer usable after a framing error.");
    }
  }

  private assertWithinLimit(bytes: number): void {
    if (bytes <= maxBridgeLineBytes) {
      return;
    }
    this.failed = true;
    this.buffer = "";
    this.bufferedBytes = 0;
    this.newlineIndex = -1;
    throw new Error("VS Code bridge request exceeded 1 MiB.");
  }
}

export function serializeVscodeBridgeEvent(event: string, data: unknown): string {
  if (event.length === 0 || event.length > 100 || !/^[a-zA-Z0-9._:-]+$/.test(event)) {
    throw new Error("VS Code bridge event has an invalid name.");
  }
  let line: string;
  try {
    line = JSON.stringify({ type: "event", event, data } satisfies VscodeBridgeEvent);
  } catch {
    throw new Error("VS Code bridge event data must be JSON-serializable.");
  }
  if (Buffer.byteLength(line, "utf8") > maxBridgeLineBytes) {
    throw new Error("VS Code bridge event exceeded 1 MiB.");
  }
  return `${line}\n`;
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
