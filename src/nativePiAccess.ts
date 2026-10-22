import { realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { piConfiguration } from "./configuration";
import { captureNativeEditorGuard } from "./nativePiEditors";
import {
  type NativeFileKind,
  type NativeFileSnapshot,
  nativeFileTarget,
  readNativeFile,
  resolveNativeAgentDirectory,
  saveNativeFile,
} from "./nativePiFiles";
import type { PiRuntimeManager } from "./piRuntime";
import { readPiInvocationOptions } from "./vscodePi";

export interface NativeFilePair {
  readonly root: string;
  readonly cwd: string;
  readonly agentDir: string;
  readonly approved: boolean;
  readonly global: NativeFileSnapshot;
  readonly project: NativeFileSnapshot;
  readonly assertEditors: (documents: readonly vscode.TextDocument[]) => Promise<void>;
  readonly assertOrigin: () => Promise<void>;
}

/** Shared host-only access for native dialogs and the bounded settings form. */
export class NativePiAccess {
  public constructor(
    private readonly runtime: PiRuntimeManager,
    private readonly isDisposed: () => boolean,
  ) {}

  public async files(kind: NativeFileKind): Promise<NativeFilePair> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (this.isDisposed() || !vscode.workspace.isTrusted || folder?.uri.scheme !== "file")
      throw new Error("Trusted file workspace required.");
    const folderUri = folder.uri.toString();
    const root = await realpath(folder.uri.fsPath);
    const cwd = readPiInvocationOptions(folder.uri).cwd;
    const approved = piConfiguration().get<boolean>("approveProjectResources", false);
    const envDir = process.env.PI_CODING_AGENT_DIR;
    const agentDir = resolveNativeAgentDirectory(root);
    const assertOrigin = async () => {
      const current = vscode.workspace.workspaceFolders?.[0];
      if (
        this.isDisposed() ||
        !vscode.workspace.isTrusted ||
        current?.uri.scheme !== "file" ||
        current.uri.toString() !== folderUri ||
        approved !== piConfiguration().get<boolean>("approveProjectResources", false) ||
        envDir !== process.env.PI_CODING_AGENT_DIR ||
        (await realpath(current.uri.fsPath)) !== root ||
        (await realpath(readPiInvocationOptions(current.uri).cwd)) !== root ||
        (await realpath(this.runtime.currentCwd)) !== root
      )
        throw new Error("Native configuration origin changed.");
    };
    await assertOrigin();
    const global = await readNativeFile(await nativeFileTarget(agentDir, "global", kind));
    const project = await readNativeFile(await nativeFileTarget(path.join(root, ".pi"), "project", kind));
    const assertEditors = await captureNativeEditorGuard(vscode.workspace.textDocuments, [
      path.join(global.target.root, global.target.relative),
      path.join(project.target.root, project.target.relative),
    ]);
    await assertOrigin();
    await assertEditors(vscode.workspace.textDocuments);
    return { root, cwd, agentDir, approved, global, project, assertEditors, assertOrigin };
  }

  public async write(
    state: NativeFilePair,
    snapshot: NativeFileSnapshot,
    keys: readonly string[],
    value: unknown,
    guard: () => Promise<void>,
  ): Promise<void> {
    const inherited = snapshot === state.global ? state.project : state.global;
    const verify = async () => {
      await guard();
      await state.assertOrigin();
      await state.assertEditors(vscode.workspace.textDocuments);
      if ((await readNativeFile(inherited.target)).revision !== inherited.revision)
        throw new Error("Inherited native configuration changed.");
      await guard();
      await state.assertOrigin();
    };
    await verify();
    await saveNativeFile(snapshot, keys, value, verify);
  }
}
