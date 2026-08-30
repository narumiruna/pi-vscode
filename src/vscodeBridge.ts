import { randomBytes, timingSafeEqual } from "node:crypto";
import net, { type Socket } from "node:net";
import path from "node:path";
import * as vscode from "vscode";
import {
  parseVscodeBridgeRequest,
  serializeVscodeBridgeEvent,
  vscodeBridgePortEnvironmentKey,
  vscodeBridgeTokenEnvironmentKey,
  VscodeBridgeLineDecoder,
  type VscodeBridgeRequest,
} from "./vscodeBridgeProtocol";

const bridgeHost = "127.0.0.1";
const maxSelectionCharacters = 20_000;
const maxDiagnostics = 100;
const maxDiagnosticMessageCharacters = 2_000;

export class VscodeBridgeServer implements vscode.Disposable {
  private readonly token = randomBytes(32).toString("hex");
  private readonly sockets = new Set<Socket>();
  private readonly subscribers = new Set<Socket>();
  private server: net.Server | undefined;
  private startPromise: Promise<NodeJS.ProcessEnv> | undefined;
  private environment: NodeJS.ProcessEnv | undefined;
  private disposed = false;

  public start(): Promise<NodeJS.ProcessEnv> {
    if (this.disposed) {
      return Promise.reject(new Error("The VS Code bridge has been disposed."));
    }
    if (this.environment) {
      return Promise.resolve({ ...this.environment });
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    this.startPromise = this.listen();
    return this.startPromise;
  }

  public broadcast(event: string, data: unknown): number {
    const line = serializeVscodeBridgeEvent(event, data);
    let delivered = 0;
    for (const socket of this.subscribers) {
      if (!socket.destroyed && socket.writable) {
        socket.write(line);
        delivered += 1;
      }
    }
    return delivered;
  }

  public dispose(): void {
    this.disposed = true;
    this.environment = undefined;
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.subscribers.clear();
    this.server?.close();
    this.server = undefined;
  }

  private async listen(): Promise<NodeJS.ProcessEnv> {
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    server.on("error", () => {});
    try {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen({ host: bridgeHost, port: 0, exclusive: true }, () => {
          server.off("error", onError);
          resolve();
        });
      });
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("VS Code bridge did not receive a TCP port.");
      }
      this.environment = {
        [vscodeBridgePortEnvironmentKey]: String(address.port),
        [vscodeBridgeTokenEnvironmentKey]: this.token,
      };
      return { ...this.environment };
    } catch (error) {
      server.close();
      if (this.server === server) {
        this.server = undefined;
      }
      this.startPromise = undefined;
      throw error;
    }
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    socket.setTimeout(10_000);
    let received = false;
    let framingFailed = false;
    const decoder = new VscodeBridgeLineDecoder(line => {
      if (received) {
        socket.destroy(new Error("VS Code bridge accepts one request per connection."));
        return;
      }
      received = true;
      socket.pause();
      void this.handleLine(socket, line);
    });

    socket.on("data", (chunk: Buffer) => {
      if (framingFailed) return;
      try {
        decoder.push(chunk);
      } catch (error) {
        framingFailed = true;
        socket.destroy(error instanceof Error ? error : new Error(formatError(error)));
      }
    });
    socket.on("end", () => {
      if (!received && !framingFailed) {
        try {
          decoder.end();
        } catch (error) {
          framingFailed = true;
          socket.destroy(error instanceof Error ? error : new Error(formatError(error)));
        }
      }
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => {});
    socket.on("close", () => {
      this.sockets.delete(socket);
      this.subscribers.delete(socket);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    let request: VscodeBridgeRequest | undefined;
    try {
      request = parseVscodeBridgeRequest(line);
      if (!tokensMatch(request.token, this.token)) {
        throw new Error("VS Code bridge authentication failed.");
      }
      if (request.method === "subscribe") {
        socket.setTimeout(0);
        this.subscribers.add(socket);
        this.writeResponse(socket, { id: request.id, ok: true, result: { connected: true } }, false);
        socket.write(serializeVscodeBridgeEvent("bridge.connected", { connected: true }));
        return;
      }
      const result = await this.dispatch(request.method, request.params);
      this.writeResponse(socket, { id: request.id, ok: true, result });
    } catch (error) {
      this.writeResponse(socket, {
        id: request?.id ?? "unknown",
        ok: false,
        error: formatError(error),
      });
    }
  }

  private async dispatch(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (method === "context") {
      return this.editorContext();
    }
    if (method === "open") {
      return this.openFile(params);
    }
    if (method === "notify") {
      return this.notify(params);
    }
    throw new Error(`Unsupported VS Code bridge method: ${method}`);
  }

  private editorContext(): Record<string, unknown> {
    const editor = vscode.window.activeTextEditor;
    return {
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map(folder => ({
        name: folder.name,
        uri: folder.uri.toString(),
        path: folder.uri.scheme === "file" ? folder.uri.fsPath : undefined,
      })),
      activeEditor: editor ? describeEditor(editor, true) : undefined,
      visibleEditors: vscode.window.visibleTextEditors.map(visibleEditor => describeEditor(visibleEditor, false)),
      diagnostics: editor
        ? vscode.languages.getDiagnostics(editor.document.uri).slice(0, maxDiagnostics).map(describeDiagnostic)
        : [],
    };
  }

  private async openFile(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    const target = requiredString(params.path, "path");
    if (!path.isAbsolute(target)) {
      throw new Error("VS Code bridge open path must be absolute.");
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const requestedLine = optionalPositiveInteger(params.line) ?? 1;
    const line = Math.min(requestedLine - 1, Math.max(document.lineCount - 1, 0));
    const requestedColumn = optionalPositiveInteger(params.column) ?? 1;
    const column = Math.min(requestedColumn - 1, document.lineAt(line).text.length);
    const position = new vscode.Position(line, column);
    const editor = await vscode.window.showTextDocument(document, {
      preview: false,
      preserveFocus: params.preserveFocus === true,
      selection: new vscode.Range(position, position),
    });
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    return {
      uri: document.uri.toString(),
      path: document.uri.fsPath,
      line: position.line + 1,
      column: position.character + 1,
    };
  }

  private notify(params: Record<string, unknown>): Record<string, unknown> {
    const message = requiredString(params.message, "message").slice(0, 4_000);
    const level = params.level;
    if (level === "error") {
      void vscode.window.showErrorMessage(message);
    } else if (level === "warning") {
      void vscode.window.showWarningMessage(message);
    } else {
      void vscode.window.showInformationMessage(message);
    }
    return { shown: true };
  }

  private writeResponse(socket: Socket, response: Record<string, unknown>, close = true): void {
    if (socket.destroyed) {
      return;
    }
    const line = `${JSON.stringify(response)}\n`;
    if (close) {
      socket.end(line);
    } else {
      socket.write(line);
    }
  }
}

function describeEditor(editor: vscode.TextEditor, includeSelection: boolean): Record<string, unknown> {
  const document = editor.document;
  const folder = vscode.workspace.getWorkspaceFolder(document.uri);
  const selection = editor.selection;
  const selectedText = includeSelection ? document.getText(selection) : "";
  return {
    uri: document.uri.toString(),
    path: document.uri.scheme === "file" ? document.uri.fsPath : undefined,
    relativePath: folder && folder.uri.scheme === "file" && document.uri.scheme === "file"
      ? path.relative(folder.uri.fsPath, document.uri.fsPath)
      : undefined,
    languageId: document.languageId,
    version: document.version,
    dirty: document.isDirty,
    selection: includeSelection ? {
      start: describePosition(selection.start),
      end: describePosition(selection.end),
      text: selectedText.slice(0, maxSelectionCharacters),
      truncated: selectedText.length > maxSelectionCharacters,
    } : undefined,
  };
}

function describeDiagnostic(diagnostic: vscode.Diagnostic): Record<string, unknown> {
  return {
    severity: ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Unknown",
    message: diagnostic.message.slice(0, maxDiagnosticMessageCharacters),
    source: diagnostic.source,
    code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
    range: {
      start: describePosition(diagnostic.range.start),
      end: describePosition(diagnostic.range.end),
    },
  };
}

function describePosition(position: vscode.Position): Record<string, number> {
  return { line: position.line + 1, column: position.character + 1 };
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`VS Code bridge ${name} must be a non-empty string.`);
  }
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function tokensMatch(actual: string, expected: string): boolean {
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
