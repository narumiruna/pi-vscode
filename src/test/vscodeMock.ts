import { EventEmitter as NodeEmitter } from "node:events";
import path from "node:path";

export class MockUri {
  public constructor(
    public readonly scheme: string,
    public readonly path: string,
    public readonly query = "",
  ) {}
  public static joinPath(base: MockUri, ...segments: string[]): MockUri {
    return new MockUri(base.scheme, path.posix.join(base.path, ...segments));
  }
  public static file(file: string): MockUri {
    return new MockUri("file", path.resolve(file));
  }
  public static from(value: { scheme: string; path: string; query?: string }): MockUri {
    return new MockUri(value.scheme, value.path, value.query);
  }
  public static parse(value: string): MockUri {
    const match = /^([^:]+):\/\/([^?]*)(?:\?(.*))?$/.exec(value);
    if (!match) throw new Error("Invalid mock URI");
    return new MockUri(match[1]!, match[2]!, match[3] ?? "");
  }
  public get fsPath(): string {
    return this.path;
  }
  public with(value: { query: string }): MockUri {
    return new MockUri(this.scheme, this.path, value.query);
  }
  public toString(): string {
    return `${this.scheme}://${this.path}?${this.query}`;
  }
}
export function installVscodeMock(): any {
  const Module = require("node:module");
  const original = Module._load;
  const disposable = () => ({ dispose() {} });
  const registrations = new Map<string, (...args: any[]) => any>();
  const configurationEvents = new NodeEmitter();
  const workspaceEvents = new NodeEmitter();
  const panels: any[] = [];
  const listen = (events: NodeEmitter, name: string, listener: (...args: any[]) => void) => {
    events.on(name, listener);
    return { dispose: () => events.off(name, listener) };
  };
  const mock: any = {
    Uri: MockUri,
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ViewColumn: { Active: -1 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    DecorationRangeBehavior: { ClosedClosed: 1 },
    CommentMode: { Editing: 0, Preview: 1 },
    CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
    comments: {
      controllers: [],
      createCommentController: (id: string, label: string) => {
        const controller = {
          id,
          label,
          threads: [] as any[],
          disposed: false,
          disposeCalls: 0,
          createCommentThread(uri: MockUri, range: unknown, comments: unknown[]) {
            const thread = {
              uri,
              range,
              comments,
              label: undefined as string | undefined,
              canReply: true,
              collapsibleState: 0,
              disposed: false,
              disposeCalls: 0,
              dispose() {
                this.disposed = true;
                this.disposeCalls++;
              },
            };
            this.threads.push(thread);
            return thread;
          },
          dispose() {
            this.disposed = true;
            this.disposeCalls++;
            for (const thread of this.threads) if (!thread.disposed) thread.dispose();
          },
        };
        mock.comments.controllers.push(controller);
        return controller;
      },
    },
    ThemeColor: class {
      constructor(public id: string) {}
    },
    MarkdownString: class {
      public value = "";
      public isTrusted = false;
      public supportHtml = false;
      public readonly appendedText: string[] = [];
      public appendText(value: string) {
        this.appendedText.push(value);
        this.value += value.replace(/[\\`*_{}[\]()<>#+!|~-]/g, "\\$&");
        return this;
      }
    },
    TabInputText: class {
      constructor(public uri: MockUri) {}
    },
    TabInputTextDiff: class {
      constructor(
        public original: MockUri,
        public modified: MockUri,
      ) {}
    },
    CancellationTokenSource: class {
      private events = new NodeEmitter();
      public token = {
        isCancellationRequested: false,
        onCancellationRequested: (listener: () => void) => listen(this.events, "cancel", listener),
      };
      public cancel() {
        if (this.token.isCancellationRequested) return;
        this.token.isCancellationRequested = true;
        this.events.emit("cancel");
      }
      public dispose() {
        this.events.removeAllListeners();
      }
    },
    ProgressLocation: { Notification: 15 },
    version: "1.140.0",
    env: {},
    outputChannels: [],
    InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
    InlineCompletionItem: class {
      constructor(
        public insertText: string,
        public range: unknown,
      ) {}
    },
    panels,
    configurationEvents,
    workspaceEvents,
    Range: class {
      public start: { line: number; character: number };
      public end: { line: number; character: number };
      constructor(
        public startLine: any,
        public startCharacter: any,
        public endLine?: number,
        public endCharacter?: number,
      ) {
        this.start = typeof startLine === "number" ? { line: startLine, character: startCharacter } : startLine;
        this.end = typeof startLine === "number" ? { line: endLine!, character: endCharacter! } : startCharacter;
      }
      intersection(other: any) {
        return this.start.line <= other.end.line && this.end.line >= other.start.line ? this : undefined;
      }
    },
    Position: class {
      constructor(
        public line: number,
        public character: number,
      ) {}
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    FilePermission: { Readonly: 1 },
    Diagnostic: class {
      public source?: string;
      public code?: string;
      constructor(
        public range: unknown,
        public message: string,
        public severity: number,
      ) {}
    },
    CodeActionKind: { QuickFix: "quickfix" },
    CodeAction: class {
      public command?: unknown;
      constructor(
        public title: string,
        public kind: unknown,
      ) {}
    },
    SymbolKind: { 11: "Function", 4: "Class" },
    languages: {
      inlineProviders: [],
      registerInlineCompletionItemProvider: (_selector: unknown, provider: unknown) => {
        mock.languages.inlineProviders.push(provider);
        return disposable();
      },
      getDiagnostics: () => [],
      registerCodeActionsProvider: disposable,
      onDidChangeDiagnostics: disposable,
      createDiagnosticCollection: () => {
        const values = new Map();
        return {
          values,
          set: (uri: MockUri, diagnostics: unknown) => values.set(uri.toString(), diagnostics),
          delete: (uri: MockUri) => values.delete(uri.toString()),
          dispose: () => values.clear(),
        };
      },
    },
    EventEmitter: class {
      private emitter = new NodeEmitter();
      event = (listener: (...args: any[]) => void) => {
        this.emitter.on("event", listener);
        return { dispose: () => this.emitter.off("event", listener) };
      };
      fire(value: unknown) {
        this.emitter.emit("event", value);
      }
      dispose() {
        this.emitter.removeAllListeners();
      }
    },
    workspace: {
      isTrusted: true,
      onDidChangeConfiguration: (listener: (...args: any[]) => void) => listen(configurationEvents, "change", listener),
      onDidChangeWorkspaceFolders: (listener: (...args: any[]) => void) => listen(workspaceEvents, "folders", listener),
      onDidGrantWorkspaceTrust: (listener: (...args: any[]) => void) => listen(workspaceEvents, "trust", listener),
      onDidCloseTextDocument: (listener: (...args: any[]) => void) =>
        listen(workspaceEvents, "closeDocument", listener),
      onDidChangeTextDocument: (listener: (...args: any[]) => void) =>
        listen(workspaceEvents, "changeDocument", listener),
      textDocuments: [],
      workspaceFolders: [],
      registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: (key: string) => ({ key }),
        update: async () => {},
      }),
      getWorkspaceFolder: () => undefined,
    },
    window: {
      createOutputChannel: (name: string, options: unknown) => {
        const channel = {
          name,
          options,
          records: [] as { level: string; message: string }[],
          shown: [] as boolean[],
          disposed: false,
          disposeCalls: 0,
          info(message: string) {
            this.records.push({ level: "info", message });
          },
          warn(message: string) {
            this.records.push({ level: "warn", message });
          },
          error(message: string) {
            this.records.push({ level: "error", message });
          },
          debug(message: string) {
            this.records.push({ level: "debug", message });
          },
          trace(message: string) {
            this.records.push({ level: "trace", message });
          },
          show(preserveFocus: boolean) {
            this.shown.push(preserveFocus);
          },
          dispose() {
            this.disposed = true;
            this.disposeCalls++;
          },
        };
        mock.outputChannels.push(channel);
        return channel;
      },
      visibleTextEditors: [],
      decorationTypes: [],
      createTextEditorDecorationType: (options: unknown) => {
        const decoration = {
          options,
          disposed: false,
          dispose() {
            this.disposed = true;
          },
        };
        mock.window.decorationTypes.push(decoration);
        return decoration;
      },
      onDidChangeVisibleTextEditors: (listener: (...args: any[]) => void) =>
        listen(workspaceEvents, "visibleEditors", listener),
      onDidChangeActiveTextEditor: (listener: (...args: any[]) => void) =>
        listen(workspaceEvents, "activeEditor", listener),
      tabGroups: {
        all: [],
        onDidChangeTabs: (listener: (...args: any[]) => void) => listen(workspaceEvents, "tabs", listener),
        close: async () => true,
      },
      createStatusBarItem: () => ({ text: "", command: "", tooltip: "", show() {}, hide() {}, dispose() {} }),
      withProgress: async (_options: unknown, task: (progress: unknown, token: unknown) => Promise<unknown>) =>
        task({ report() {} }, { isCancellationRequested: false, onCancellationRequested: disposable }),
      createWebviewPanel: (viewType: string, title: string, column: unknown, options: unknown) => {
        const events = new NodeEmitter();
        const panel = {
          viewType,
          title,
          column,
          options,
          reveals: 0,
          disposed: false,
          webview: {
            html: "",
            cspSource: "https://mock.invalid",
            messages: [] as any[],
            asWebviewUri: (uri: MockUri) => uri,
            postMessage: async (message: unknown) => {
              panel.webview.messages.push(message);
              return true;
            },
            onDidReceiveMessage: (listener: (...args: any[]) => void) => listen(events, "message", listener),
          },
          receive: (message: unknown) => events.emit("message", message),
          reveal: () => {
            panel.reveals++;
          },
          onDidDispose: (listener: (...args: any[]) => void) => listen(events, "dispose", listener),
          dispose: () => {
            if (!panel.disposed) {
              panel.disposed = true;
              events.emit("dispose");
            }
          },
        };
        panels.push(panel);
        return panel;
      },
      showWarningMessage: async () => undefined,
      showErrorMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showQuickPick: async () => undefined,
      showInputBox: async () => undefined,
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => any) => {
        registrations.set(id, handler);
        return disposable();
      },
      executeCommand: async () => undefined,
    },
    registrations,
    restore: () => {
      Module._load = original;
    },
  };
  Module._load = function (id: string, ...args: unknown[]) {
    return id === "vscode" ? mock : original.call(this, id, ...args);
  };
  return mock;
}
