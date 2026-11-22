import { randomUUID } from "node:crypto";
import path from "node:path";
import * as vscode from "vscode";
import { ExclusiveOperationGate } from "./conversationController";
import { requireTrustedFile, workflowCommand } from "./workflowUi";

// Subset of the VS Code 1.146 built-in Git extension API, version 1.
interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly isUsingVirtualFileSystem: boolean;
  getCommit(ref: string): Promise<{ hash: string }>;
  createWorktree(options: { branch: string; commitish: string; noTrack: boolean }): Promise<string>;
}

interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): {
    readonly state: "uninitialized" | "initialized";
    readonly repositories: readonly GitRepository[];
  };
}

function assertLocalWorkspace(): void {
  requireTrustedFile();
  if (
    vscode.env.uiKind !== vscode.UIKind.Desktop ||
    vscode.env.remoteName ||
    !vscode.workspace.workspaceFolders?.some((folder) => folder.uri.scheme === "file")
  ) {
    throw new Error("Creating a Pi worktree requires a local, file-backed VS Code desktop workspace.");
  }
}

function sourceFolder(repository: GitRepository): vscode.WorkspaceFolder | undefined {
  if (repository.isUsingVirtualFileSystem || repository.rootUri.scheme !== "file") return undefined;
  const folder = vscode.workspace.getWorkspaceFolder(repository.rootUri);
  return folder?.uri.scheme === "file" ? folder : undefined;
}

export function registerWorktreeCommand(context: vscode.ExtensionContext): void {
  const gate = new ExclusiveOperationGate("Wait for the current worktree operation to finish.");
  workflowCommand(context, "pi.newWorktreeInNewWindow", async () => {
    const release = gate.acquire();
    try {
      await createAndOpenWorktree();
    } finally {
      release();
    }
  });
}

async function createAndOpenWorktree(): Promise<void> {
  assertLocalWorkspace();
  const extension = vscode.extensions.getExtension<GitExtension>("vscode.git");
  const git = await extension?.activate();
  if (!git?.enabled) throw new Error("Enable the built-in VS Code Git extension and make sure Git is installed.");
  const api = git.getAPI(1);
  assertLocalWorkspace();
  const sources = api.repositories.flatMap((repository) => {
    const folder = sourceFolder(repository);
    if (!folder) return [];
    const { rootUri } = repository;
    return [{ label: path.basename(rootUri.fsPath) || folder.name, description: rootUri.fsPath, rootUri, folder }];
  });
  if (sources.length === 0) {
    throw new Error(
      api.state === "uninitialized"
        ? "VS Code Git is still looking for repositories. Try again when the repository appears in Source Control."
        : "No Git repository was found in this workspace. Open a repository that appears in VS Code Source Control.",
    );
  }

  const selected =
    sources.length === 1
      ? sources[0]
      : await vscode.window.showQuickPick(sources, { title: "Choose a Git repository" });
  if (!selected) return;
  const root = selected.rootUri.toString();
  const folder = selected.folder.uri.toString();
  const currentRepository = () => {
    assertLocalWorkspace();
    const repository = git.enabled
      ? api.repositories.find(
          (entry) => entry.rootUri.toString() === root && sourceFolder(entry)?.uri.toString() === folder,
        )
      : undefined;
    if (!repository) throw new Error("The selected Git repository is no longer available in this workspace.");
    return repository;
  };

  const source = currentRepository();
  const { hash: commitish } = await source.getCommit("HEAD").catch((error: unknown) => {
    throw new Error("Could not read the selected repository's HEAD. Make sure it has an initial commit.", {
      cause: error,
    });
  });
  const repository = currentRepository();
  const branch = `pi/worktree-${randomUUID()}`;
  const worktreePath = await repository.createWorktree({ branch, commitish, noTrack: true }).catch((error: unknown) => {
    throw new Error("Could not create the worktree. See the Git output for details.", { cause: error });
  });
  if (!path.isAbsolute(worktreePath)) {
    throw new Error(`Git did not return an absolute path for the new worktree on ${branch}. Check Source Control.`);
  }
  try {
    await vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(worktreePath), { forceNewWindow: true });
  } catch {
    throw new Error(
      `The worktree was created at ${worktreePath}, but the new window did not open. Open that folder in a new window.`,
    );
  }
}
