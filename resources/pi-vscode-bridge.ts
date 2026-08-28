import net from "node:net";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

const responseLimitBytes = 1024 * 1024;
const requestTimeoutMilliseconds = 10_000;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "vscode_context",
    label: "VS Code Context",
    description: "Get bounded context from the connected VS Code window: workspace folders, active editor, selection, visible editors, and active-file diagnostics.",
    promptSnippet: "Read the connected VS Code editor, selection, and diagnostics",
    promptGuidelines: [
      "Use vscode_context when a request depends on the user's current VS Code editor, selection, or diagnostics and that context was not included in the prompt.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, signal) {
      const result = await bridgeRequest("context", {}, signal);
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "vscode_open_file",
    label: "Open in VS Code",
    description: "Open a local file in the connected VS Code window and optionally reveal a 1-based line and column. This changes editor UI only, not file contents.",
    promptSnippet: "Open a file or source location in the connected VS Code window",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path or path relative to Pi's working directory" }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to reveal" })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column to reveal" })),
      preserveFocus: Type.Optional(Type.Boolean({ description: "Open without focusing the editor" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const result = await bridgeRequest("open", {
        path: path.resolve(ctx.cwd, target),
        line: params.line,
        column: params.column,
        preserveFocus: params.preserveFocus,
      }, signal);
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "vscode_notify",
    label: "VS Code Notification",
    description: "Show a bounded native notification in the connected VS Code window. Use only when the user explicitly asks for a notification.",
    parameters: Type.Object({
      message: Type.String({ minLength: 1, maxLength: 4_000 }),
      level: Type.Optional(StringEnum(["info", "warning", "error"] as const)),
    }),
    async execute(_toolCallId, params, signal) {
      const result = await bridgeRequest("notify", params, signal);
      return textResult(result);
    },
  });
}

async function bridgeRequest(
  method: string,
  params: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  const port = Number.parseInt(process.env.PI_VSCODE_BRIDGE_PORT ?? "", 10);
  const token = process.env.PI_VSCODE_BRIDGE_TOKEN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535 || !token) {
    throw new Error("VS Code bridge is unavailable. Start this Pi session from the Pi VS Code extension.");
  }
  if (signal?.aborted) {
    throw new Error("VS Code bridge request was cancelled.");
  }

  const id = randomUUID();
  const request = `${JSON.stringify({ id, token, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const decoder = new StringDecoder("utf8");
    let buffer = "";
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const onAbort = () => finish(new Error("VS Code bridge request was cancelled."));
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
      }
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
    };
    function finish(error?: Error, value?: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    }
    const processLine = (line: string) => {
      let response: unknown;
      try {
        response = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
      } catch {
        finish(new Error("VS Code bridge returned invalid JSON."));
        return;
      }
      if (!isRecord(response) || response.id !== id || typeof response.ok !== "boolean") {
        finish(new Error("VS Code bridge returned an invalid response."));
      } else if (!response.ok) {
        finish(new Error(typeof response.error === "string" ? response.error : "VS Code bridge request failed."));
      } else {
        finish(undefined, response.result);
      }
    };

    timer = setTimeout(() => finish(new Error("Timed out waiting for VS Code bridge.")), requestTimeoutMilliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
    socket.once("connect", () => socket.write(request));
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer, "utf8") > responseLimitBytes) {
        finish(new Error("VS Code bridge response exceeded 1 MiB."));
        return;
      }
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        processLine(buffer.slice(0, newline));
      }
    });
    socket.once("end", () => {
      buffer += decoder.end();
      if (!settled && buffer.length > 0) {
        processLine(buffer);
      } else if (!settled) {
        finish(new Error("VS Code bridge closed without a response."));
      }
    });
    socket.once("error", error => finish(new Error(`VS Code bridge connection failed: ${error.message}`)));
  });
}

function textResult(value: unknown): { content: Array<{ type: "text"; text: string }>; details: { truncated: boolean } } {
  const text = JSON.stringify(value, undefined, 2) ?? String(value);
  const truncation = truncateHead(text, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  const suffix = truncation.truncated
    ? `\n\n[VS Code bridge output truncated to ${truncation.outputLines} lines and ${formatSize(truncation.outputBytes)}; the full response was not retained.]`
    : "";
  return {
    content: [{ type: "text", text: truncation.content + suffix }],
    details: { truncated: truncation.truncated },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
