import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const responseLimitBytes = 1024 * 1024;
const requestTimeoutMilliseconds = 10_000;

export default function (pi: ExtensionAPI) {
  let subscription: net.Socket | undefined;

  pi.events.on("vscode:request", (value: unknown) => {
    if (!isRecord(value) || typeof value.method !== "string") {
      return;
    }
    const id = typeof value.id === "string" ? value.id : randomUUID();
    const params = isRecord(value.params) ? value.params : {};
    void bridgeRequest(value.method, params).then(
      (result) => pi.events.emit("vscode:response", { id, ok: true, result }),
      (error) => pi.events.emit("vscode:response", { id, ok: false, error: formatError(error) }),
    );
  });

  pi.on("session_start", (_event, ctx) => {
    subscription?.destroy();
    subscription = subscribeToBridgeEvents(pi, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });

  pi.on("session_shutdown", () => {
    subscription?.destroy();
    subscription = undefined;
  });

  pi.registerTool({
    name: "vscode_context",
    label: "VS Code Context",
    description:
      "Get bounded context from the connected VS Code window: workspace folders, active editor, selection, visible editors, and active-file diagnostics.",
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
    name: "vscode_code_context",
    label: "VS Code Code Context",
    description:
      "Get bounded language-provider metadata for a definition, references, callers, callees, or document symbols at a workspace source location. Returns locations and symbol metadata only, not source text.",
    promptSnippet: "Query VS Code language providers for code-navigation metadata",
    promptGuidelines: [
      "Use vscode_code_context when definitions, references, callers, callees, or document symbols from the connected editor's language providers would clarify a code question.",
      "vscode_code_context returns at most 50 locations, with zero-based result ranges and a five-second provider deadline. It contains metadata only; use read when source text is needed.",
    ],
    parameters: Type.Object({
      operation: StringEnum(["definition", "references", "callers", "callees", "documentSymbols"] as const),
      path: Type.String({ description: "Absolute path or path relative to Pi's working directory" }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based source line" })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based source column" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const result = await bridgeRequest(
        "codeContext",
        {
          operation: params.operation,
          path: path.resolve(ctx.cwd, target),
          line: params.line,
          column: params.column,
        },
        signal,
      );
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "vscode_open_file",
    label: "Open in VS Code",
    description:
      "Open a local file in the connected VS Code window and optionally reveal a 1-based line and column. This changes editor UI only, not file contents.",
    promptSnippet: "Open a file or source location in the connected VS Code window",
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path or path relative to Pi's working directory" }),
      line: Type.Optional(Type.Integer({ minimum: 1, description: "1-based line to reveal" })),
      column: Type.Optional(Type.Integer({ minimum: 1, description: "1-based column to reveal" })),
      preserveFocus: Type.Optional(Type.Boolean({ description: "Open without focusing the editor" })),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      const target = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const result = await bridgeRequest(
        "open",
        {
          path: path.resolve(ctx.cwd, target),
          line: params.line,
          column: params.column,
          preserveFocus: params.preserveFocus,
        },
        signal,
      );
      return textResult(result);
    },
  });

  pi.registerTool({
    name: "vscode_notify",
    label: "VS Code Notification",
    description:
      "Show a bounded native notification in the connected VS Code window. Use only when the user explicitly asks for a notification.",
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

async function bridgeRequest(method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const connection = bridgeConnection();
  if (!connection) {
    throw new Error("VS Code bridge is unavailable. Start Pi from a VS Code integrated terminal.");
  }
  if (signal?.aborted) {
    throw new Error("VS Code bridge request was cancelled.");
  }

  const id = randomUUID();
  const request = `${JSON.stringify({ id, token: connection.token, method, params })}\n`;
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: connection.port });
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
    socket.once("error", (error) => finish(new Error(`VS Code bridge connection failed: ${error.message}`)));
  });
}

function subscribeToBridgeEvents(
  pi: ExtensionAPI,
  metadata: { cwd: string; sessionId: string },
): net.Socket | undefined {
  const connection = bridgeConnection();
  if (!connection) {
    return undefined;
  }

  const id = randomUUID();
  const socket = net.createConnection({ host: "127.0.0.1", port: connection.port });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let authenticated = false;
  let disconnectEmitted = false;

  const processLine = (line: string) => {
    let message: unknown;
    try {
      message = JSON.parse(line.endsWith("\r") ? line.slice(0, -1) : line);
    } catch {
      socket.destroy(new Error("VS Code bridge event stream returned invalid JSON."));
      return;
    }
    if (!isRecord(message)) {
      socket.destroy(new Error("VS Code bridge event stream returned an invalid message."));
      return;
    }
    if (!authenticated) {
      if (message.id !== id || message.ok !== true) {
        socket.destroy(new Error("VS Code bridge event subscription was rejected."));
        return;
      }
      authenticated = true;
      pi.events.emit("vscode:connected", metadata);
      return;
    }
    if (message.type === "event" && typeof message.event === "string") {
      pi.events.emit("vscode:event", { event: message.event, data: message.data });
    }
  };

  socket.once("connect", () => {
    socket.write(
      `${JSON.stringify({
        id,
        token: connection.token,
        method: "subscribe",
        params: metadata,
      })}\n`,
    );
  });
  socket.on("data", (chunk: Buffer) => {
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, "utf8") > responseLimitBytes) {
      socket.destroy(new Error("VS Code bridge event stream exceeded 1 MiB."));
      return;
    }
    while (true) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  });
  socket.once("error", (error) => {
    disconnectEmitted = true;
    pi.events.emit("vscode:disconnected", { error: error.message });
  });
  socket.once("close", () => {
    if (authenticated && !disconnectEmitted) {
      pi.events.emit("vscode:disconnected", {});
    }
  });
  return socket;
}

function bridgeConnection(): { port: number; token: string } | undefined {
  const port = Number.parseInt(process.env.PICODE_BRIDGE_PORT ?? "", 10);
  const token = process.env.PICODE_BRIDGE_TOKEN;
  return Number.isInteger(port) && port >= 1 && port <= 65_535 && token ? { port, token } : undefined;
}

function textResult(value: unknown): {
  content: Array<{ type: "text"; text: string }>;
  details: { truncated: boolean };
} {
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

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
