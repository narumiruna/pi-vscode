import { EventEmitter as NodeEmitter } from "node:events";
import path from "node:path";

export class MockUri {
  public constructor(public readonly scheme: string, public readonly path: string, public readonly query = "") {}
  public static file(file: string): MockUri { return new MockUri("file", path.resolve(file)); }
  public static from(value: { scheme: string; path: string; query?: string }): MockUri { return new MockUri(value.scheme, value.path, value.query); }
  public static parse(value: string): MockUri { const match = /^([^:]+):\/\/([^?]*)(?:\?(.*))?$/.exec(value); if (!match) throw new Error("Invalid mock URI"); return new MockUri(match[1]!, match[2]!, match[3] ?? ""); }
  public get fsPath(): string { return this.path; }
  public with(value: { query: string }): MockUri { return new MockUri(this.scheme, this.path, value.query); }
  public toString(): string { return `${this.scheme}://${this.path}?${this.query}`; }
}
export function installVscodeMock(): any {
  const Module = require("node:module");
  const original = Module._load;
  const disposable = () => ({ dispose() {} });
  const registrations = new Map<string, (...args: any[]) => any>();
  const mock: any = {
    Uri: MockUri,
    Range: class {
      public start: { line: number; character: number }; public end: { line: number; character: number };
      constructor(public startLine: any, public startCharacter: any, public endLine?: number, public endCharacter?: number) {
        this.start = typeof startLine === "number" ? { line: startLine, character: startCharacter } : startLine;
        this.end = typeof startLine === "number" ? { line: endLine!, character: endCharacter! } : startCharacter;
      }
      intersection(other: any) { return this.start.line <= other.end.line && this.end.line >= other.start.line ? this : undefined; }
    },
    Position: class { constructor(public line: number, public character: number) {} },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    EndOfLine: { LF: 1, CRLF: 2 },
    FilePermission: { Readonly: 1 },
    Diagnostic: class { public source?: string; public code?: string; constructor(public range: unknown, public message: string, public severity: number) {} },
    CodeActionKind: { QuickFix: "quickfix" },
    CodeAction: class { public command?: unknown; constructor(public title: string, public kind: unknown) {} },
    SymbolKind: { 11: "Function", 4: "Class" },
    languages: {
      getDiagnostics: () => [],
      registerCodeActionsProvider: disposable,
      onDidChangeDiagnostics: disposable,
      createDiagnosticCollection: () => { const values = new Map(); return { values, set: (uri: MockUri, diagnostics: unknown) => values.set(uri.toString(), diagnostics), delete: (uri: MockUri) => values.delete(uri.toString()), dispose: () => values.clear() }; },
    },
    EventEmitter: class { private emitter = new NodeEmitter(); event = (listener: (...args: any[]) => void) => { this.emitter.on("event", listener); return { dispose: () => this.emitter.off("event", listener) }; }; fire(value: unknown) { this.emitter.emit("event", value); } dispose() { this.emitter.removeAllListeners(); } },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [],
      registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({
        get: (_key: string, fallback: unknown) => fallback,
        inspect: (key: string) => ({ key }),
      }),
      getWorkspaceFolder: () => undefined,
    },
    window: { showWarningMessage: async () => undefined, showErrorMessage: async () => undefined, showInformationMessage: async () => undefined, showQuickPick: async () => undefined, showInputBox: async () => undefined },
    commands: { registerCommand: (id: string, handler: (...args: any[]) => any) => { registrations.set(id, handler); return disposable(); }, executeCommand: async () => undefined },
    registrations,
    restore: () => { Module._load = original; },
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === "vscode" ? mock : original.call(this, id, ...args); };
  return mock;
}
