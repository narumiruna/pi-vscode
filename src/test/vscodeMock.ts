import { EventEmitter as NodeEmitter } from "node:events";
import path from "node:path";

export class MockUri {
  public constructor(public readonly scheme: string, public readonly path: string, public readonly query = "") {}
  public static file(file: string): MockUri { return new MockUri("file", path.resolve(file)); }
  public static from(value: { scheme: string; path: string; query?: string }): MockUri { return new MockUri(value.scheme, value.path, value.query); }
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
    Range: class { constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {} },
    EventEmitter: class { private emitter = new NodeEmitter(); event = (listener: (...args: any[]) => void) => { this.emitter.on("event", listener); return { dispose: () => this.emitter.off("event", listener) }; }; fire(value: unknown) { this.emitter.emit("event", value); } dispose() { this.emitter.removeAllListeners(); } },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [],
      registerTextDocumentContentProvider: disposable,
      getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
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
