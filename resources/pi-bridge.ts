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
  const annotationCredential = process.env.PI_VSCODE_ANNOTATION_TOKEN;
  pi.registerCommand("vscode-pi-bridge-ready", {
    handler: async () => {
      throw new Error("This capability marker is discovery-only.");
    },
  });
  let disposeSubscription: (() => void) | undefined;
  let requests = new AbortController();
  const disposeSession = () => {
    // Pi invalidates this API after shutdown. Invalidate callbacks before releasing their sockets.
    requests.abort();
    disposeSubscription?.();
    disposeSubscription = undefined;
  };

  pi.events.on("vscode:request", (value: unknown) => {
    const { signal } = requests;
    if (signal.aborted || !isRecord(value) || typeof value.method !== "string") {
      return;
    }
    const id = typeof value.id === "string" ? value.id : randomUUID();
    const params = isRecord(value.params) ? value.params : {};
    void bridgeRequest(value.method, params, signal).then(
      (result) => {
        if (!signal.aborted) pi.events.emit("vscode:response", { id, ok: true, result });
      },
      (error) => {
        if (!signal.aborted) pi.events.emit("vscode:response", { id, ok: false, error: formatError(error) });
      },
    );
  });

  pi.on("session_start", (_event, ctx) => {
    disposeSession();
    requests = new AbortController();
    disposeSubscription = subscribeToBridgeEvents(pi, {
      cwd: ctx.cwd,
      sessionId: ctx.sessionManager.getSessionId(),
    });
  });

  pi.on("session_shutdown", disposeSession);

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
    name: "vscode_annotate",
    label: "VS Code Annotations",
    description:
      "Replace temporary, memory-only annotations in one already-open workspace document; an empty annotations array clears that file. Keep whole-line highlights and hovers, and add read-only native comments below each range, grouped at its end line. Threads start collapsed by default; pi.annotations.initialState accepts collapsed or expanded (Pi Settings > Editor > Annotation initial state). The setting affects newly created or replaced annotations only, not existing handles or user state on redraw. No global VS Code comments settings are written. The Comments panel also lists explanations. VS Code may auto-open the Comments panel and change editor layout or visible range/scroll during expansion, replacement or removal. Foreground sidebar only: no file writes, document/tab opens, explicit tab/selection/focus/reveal/scroll operations, or settings overrides. Use inclusive one-based whole-line ranges and exact expectedText joined with LF, without an added trailing newline (CRLF is normalized to LF). Each call permits 20 annotations, each at most 200 lines, 10,000 expectedText characters and 1,000 message characters. Returns count and visible metadata only: count is accepted annotations, not thread groups; visible means a visible editor exists, not that a comment widget is visible. Use when passage explanations help the request, not for every inspected file.",
    promptSnippet: "Add temporary passage explanations to an already-open VS Code document without file writes",
    promptGuidelines: [
      "Use vscode_annotate only when highlighting a passage helps the user's request; do not annotate every inspected file. It is foreground-only and requires an already-open workspace document.",
      "Each call replaces that file's annotations; an empty array clears them. expectedText must match the complete current lines exactly; do not trim whitespace. Invalid or stale replacements leave existing annotations unchanged. Retained annotations are limited to 100 across 20 documents.",
      "Native threads use Pi as author and Pi annotation as label; explanations are literal untrusted text, not verified diagnostics. User collapse is preserved on redraw. VS Code comments visibility settings may hide widgets; do not override those settings or infer widget visibility from visible metadata.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Absolute path or path relative to Pi's working directory" }),
      annotations: Type.Array(
        Type.Object({
          startLine: Type.Integer({ minimum: 1, description: "First whole line, 1-based and inclusive" }),
          endLine: Type.Integer({ minimum: 1, description: "Last whole line, inclusive; at most 200 lines per range" }),
          expectedText: Type.String({
            maxLength: 10_000,
            description: "Exact complete lines joined with LF, without an added trailing newline; CRLF is normalized",
          }),
          message: Type.String({ minLength: 1, maxLength: 1_000, description: "Plain-text passage explanation" }),
        }),
        { maxItems: 20, description: "Replacement annotations for this file; an empty array clears the file" },
      ),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      if (!annotationCredential) {
        throw new Error("VS Code annotations require the foreground sidebar session; terminal calls are unavailable.");
      }
      const cwd = ctx.cwd;
      const sessionId = ctx.sessionManager.getSessionId();
      const target = params.path.startsWith("@") ? params.path.slice(1) : params.path;
      const absolutePath = path.resolve(cwd, target);
      if (params.annotations.some((item) => item.endLine < item.startLine || item.endLine - item.startLine + 1 > 200)) {
        throw new Error("VS Code annotations require inclusive ranges of 1 to 200 whole lines.");
      }
      try {
        const scope = await bridgeRequest(
          "annotationOrigin",
          { credential: annotationCredential, sessionId, cwd },
          signal,
        );
        if (!isRecord(scope) || typeof scope.origin !== "string" || !/^[a-f0-9]{64}$/.test(scope.origin)) {
          throw new Error("Invalid annotation scope.");
        }
        const result = await bridgeRequest(
          "annotate",
          { origin: scope.origin, path: absolutePath, annotations: params.annotations },
          signal,
        );
        if (
          !isRecord(result) ||
          !Number.isInteger(result.count) ||
          (result.count as number) < 0 ||
          (result.count as number) > 20 ||
          typeof result.visible !== "boolean"
        ) {
          throw new Error("Invalid annotation result.");
        }
        return textResult({ count: result.count, visible: result.visible });
      } catch {
        // Transport and host errors can contain private request fields. Never forward them to Pi.
        throw new Error(
          signal?.aborted
            ? "VS Code annotation request was cancelled."
            : "VS Code annotation request failed. Verify the foreground session and current open-document text before trying again.",
        );
      }
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
): (() => void) | undefined {
  const connection = bridgeConnection();
  if (!connection) {
    return undefined;
  }

  const id = randomUUID();
  const socket = net.createConnection({ host: "127.0.0.1", port: connection.port });
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let authenticated = false;
  let disposed = false;

  const disconnect = (error?: Error) => {
    if (disposed) return;
    disposed = true;
    if (error || authenticated) {
      pi.events.emit("vscode:disconnected", error ? { error: error.message } : {});
    }
  };
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
    if (disposed || socket.destroyed) return;
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
    if (disposed || socket.destroyed) return;
    buffer += decoder.write(chunk);
    if (Buffer.byteLength(buffer, "utf8") > responseLimitBytes) {
      socket.destroy(new Error("VS Code bridge event stream exceeded 1 MiB."));
      return;
    }
    while (!disposed && !socket.destroyed) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) {
        break;
      }
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      processLine(line);
    }
  });
  socket.once("error", disconnect);
  socket.once("close", () => disconnect());
  return () => {
    disposed = true;
    buffer = "";
    socket.destroy();
  };
}

function bridgeConnection(): { port: number; token: string } | undefined {
  const port = Number.parseInt(process.env.PI_VSCODE_BRIDGE_PORT ?? "", 10);
  const token = process.env.PI_VSCODE_BRIDGE_TOKEN;
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
