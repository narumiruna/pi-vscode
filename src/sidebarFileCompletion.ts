import { randomUUID } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import type { FileCompletionMessage, FileCompletionRequest } from "./composerFileToken";
import type { SidebarAttachmentManager } from "./sidebarAttachments";
import { safeRelativePath } from "./workspaceFiles";

export const fileCompletionLimits = { discovered: 2_000, candidates: 30, path: 1_024, deadlineMs: 2_000 } as const;
const generated = [".git", "node_modules", "out", "dist", "build", "coverage", ".next", ".cache", "vendor"].map(
  (directory) => `**/${directory}/**`,
);
const exclusionLimits = { patterns: 2_000, characters: 64_000 } as const;

// Native search rejects nested brace groups. Expand configured alternatives before joining the union.
function completionExclusionGlob(patterns: readonly string[]): string {
  const flattened: string[] = [];
  let characters = 2;
  for (const pattern of patterns) {
    let expanded = [""];
    let literal = "";
    let choices: string[] | undefined;
    let bracket = false;
    const append = (parts: string[]) => {
      if (expanded.length * parts.length + flattened.length > exclusionLimits.patterns)
        throw new Error("Too many completion exclusions.");
      const size =
        expanded.reduce((sum, value) => sum + value.length, 0) * parts.length +
        parts.reduce((sum, value) => sum + value.length, 0) * expanded.length;
      if (size + characters + expanded.length * parts.length > exclusionLimits.characters)
        throw new Error("Completion exclusions are too large.");
      expanded = expanded.flatMap((prefix) => parts.map((part) => prefix + part));
    };
    for (const character of pattern) {
      if (character === "[" && !bracket) bracket = true;
      else if (character === "]" && bracket) {
        bracket = false;
        literal += character;
        continue;
      }
      if (!bracket && character === "{") {
        if (choices) throw new Error("Nested completion exclusion alternatives are not supported.");
        append([literal]);
        literal = "";
        choices = [];
      } else if (!bracket && character === "," && choices) {
        choices.push(literal);
        literal = "";
      } else if (!bracket && character === "}") {
        if (!choices) throw new Error("Malformed completion exclusion.");
        choices.push(literal);
        append(choices);
        choices = undefined;
        literal = "";
      } else literal += !bracket && character === "," ? "[,]" : character;
    }
    if (bracket || choices) throw new Error("Malformed completion exclusion.");
    append([literal]);
    flattened.push(...expanded);
    characters += expanded.reduce((sum, value) => sum + value.length + 1, 0);
  }
  return `{${flattened.join(",")}}`;
}

export interface CompletionCandidate {
  readonly id: string;
  readonly path: string;
  readonly uri: vscode.Uri;
  readonly root: string;
  readonly folder: vscode.WorkspaceFolder;
}

/** One query per view. Candidate paths never come back from the browser as authority. */
export class SidebarFileCompletion {
  private active:
    | {
        request: FileCompletionRequest;
        session: string;
        source: vscode.CancellationTokenSource;
        candidates: CompletionCandidate[];
        selected: boolean;
        expires: number;
      }
    | undefined;
  public constructor(
    private readonly options: {
      readonly cwd: () => string;
      readonly session: () => string;
      readonly attachments: SidebarAttachmentManager;
      readonly post: (message: Record<string, unknown>) => void;
    },
  ) {}

  public dispose(): void {
    this.cancel();
  }
  public cancel(): void {
    if (this.active?.selected)
      this.options.post({
        type: "fileCompletionFailed",
        id: this.active.request.id,
        revision: this.active.request.revision,
      });
    this.active?.source.cancel();
    this.active?.source.dispose();
    this.active = undefined;
  }
  public async handle(message: FileCompletionMessage): Promise<void> {
    if (message.type === "fileCompletionCancel") return this.cancel();
    if (message.type === "fileCompletionQuery") return this.query(message);
    const active = this.active;
    if (!active || active.selected || active.request.id !== message.id || active.request.revision !== message.revision)
      return;
    active.selected = true;
    const selectionTimer = setTimeout(() => {
      if (this.active === active) this.cancel();
    }, 5_000);
    try {
      const candidate = active.candidates.find((item) => item.id === message.candidateId);
      if (!candidate) throw new Error("Unknown completion candidate.");
      const validate = async () => {
        if (this.active !== active || active.session !== this.options.session() || Date.now() > active.expires)
          throw new Error("Completion expired. Search again.");
        await validateCompletionCandidate(candidate);
        if ((await realpath(this.options.cwd())) !== candidate.root) throw new Error("Workspace changed.");
        if (this.active !== active || active.session !== this.options.session()) throw new Error("Completion expired.");
      };
      await validate();
      if (active.request.token.kind === "attachment") {
        await this.options.attachments.attachCompletion(candidate, validate);
      }
      active.selected = false;
      this.options.post({
        type: "fileCompletionApplied",
        id: message.id,
        revision: message.revision,
        token: active.request.token,
        replacement:
          active.request.token.kind === "attachment"
            ? ""
            : /[\s"'()[\]{},;!?]/.test(candidate.path)
              ? JSON.stringify(candidate.path)
              : candidate.path,
      });
    } catch {
      active.selected = false;
      if (this.active === active)
        this.options.post({ type: "fileCompletionFailed", id: message.id, revision: message.revision });
    } finally {
      clearTimeout(selectionTimer);
      if (this.active === active) this.cancel();
    }
  }

  private async query(request: FileCompletionRequest): Promise<void> {
    this.cancel();
    const active = {
      request,
      session: this.options.session(),
      source: new vscode.CancellationTokenSource(),
      candidates: [] as CompletionCandidate[],
      selected: false,
      expires: Date.now() + 30_000,
    };
    this.active = active;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const discovery = async () => {
        if (!vscode.workspace.isTrusted) throw new Error("Workspace trust is required.");
        const cwd = await realpath(this.options.cwd());
        const folders = vscode.workspace.workspaceFolders ?? [];
        let folder: vscode.WorkspaceFolder | undefined;
        for (const item of folders) {
          if (item.uri.scheme === "file" && (await realpath(item.uri.fsPath)) === cwd) {
            folder = item;
            break;
          }
        }
        if (!folder) throw new Error("A matching file workspace is required.");
        const excludes = [...generated];
        for (const section of ["files", "search"]) {
          const values = vscode.workspace
            .getConfiguration(section, folder.uri)
            .get<Record<string, unknown>>("exclude", {});
          for (const [pattern, enabled] of Object.entries(values)) {
            if (enabled !== true) continue;
            if (pattern.length > 1_024) throw new Error("Completion exclusion is too long.");
            excludes.push(pattern);
          }
        }
        if (active.source.token.isCancellationRequested) throw new Error("Cancelled");
        const found = await vscode.workspace.findFiles(
          new vscode.RelativePattern(folder, "**/*"),
          completionExclusionGlob(excludes),
          fileCompletionLimits.discovered,
          active.source.token,
        );
        const paths = new Map<string, vscode.Uri>();
        for (const uri of found.slice(0, fileCompletionLimits.discovered)) {
          if (uri.scheme !== "file") continue;
          const relative = path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join("/");
          if (
            relative.length <= fileCompletionLimits.path &&
            safeRelativePath(relative) &&
            !/[\p{Cc}\u202a-\u202e\u2066-\u2069]/u.test(relative) &&
            relative.toLowerCase().includes(request.token.query.toLowerCase())
          )
            paths.set(relative, uri);
        }
        const candidates: CompletionCandidate[] = [];
        for (const relative of [...paths.keys()].sort()) {
          if (active.source.token.isCancellationRequested) throw new Error("Cancelled");
          const uri = paths.get(relative);
          if (!uri) continue;
          const candidate = { id: randomUUID(), path: relative, uri, root: cwd, folder };
          try {
            await validateCompletionCandidate(candidate);
            candidates.push(candidate);
          } catch {
            /* Unsafe or disappeared result. */
          }
          if (candidates.length === fileCompletionLimits.candidates) break;
        }
        return candidates;
      };
      const candidates = await Promise.race([
        discovery(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            active.source.cancel();
            reject(new Error("Search deadline"));
          }, fileCompletionLimits.deadlineMs);
        }),
      ]);
      if (this.active !== active || active.session !== this.options.session()) return;
      active.candidates = candidates;
      this.options.post({
        type: "fileCompletionResults",
        id: request.id,
        revision: request.revision,
        token: request.token,
        candidates: candidates.map((item) => ({ id: item.id, path: item.path })),
      });
    } catch {
      if (this.active === active) {
        this.options.post({
          type: "fileCompletionResults",
          id: request.id,
          revision: request.revision,
          token: request.token,
          candidates: [],
        });
        this.cancel();
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export async function validateCompletionCandidate(candidate: CompletionCandidate): Promise<void> {
  if (
    !vscode.workspace.isTrusted ||
    candidate.uri.scheme !== "file" ||
    !safeRelativePath(candidate.path) ||
    !(vscode.workspace.workspaceFolders ?? []).some(
      (folder) => folder.uri.toString() === candidate.folder.uri.toString(),
    ) ||
    (await realpath(candidate.folder.uri.fsPath)) !== candidate.root ||
    candidate.uri.fsPath !== path.join(candidate.folder.uri.fsPath, candidate.path)
  )
    throw new Error("Workspace changed.");
  let current = candidate.root;
  for (const [index, part] of candidate.path.split("/").entries()) {
    current = path.join(current, part);
    const stat = await lstat(current);
    if (
      stat.isSymbolicLink() ||
      (index === candidate.path.split("/").length - 1 ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
    )
      throw new Error("Unsupported workspace path.");
  }
  if ((await realpath(candidate.uri.fsPath)) !== current) throw new Error("Workspace path changed.");
}
