import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";
import { assertSafeFile } from "./backgroundResults";

interface Annotation {
  readonly startLine: number;
  readonly endLine: number;
  readonly expectedText: string;
  readonly message: string;
}

interface RetainedAnnotations {
  readonly version: number;
  readonly options: vscode.DecorationOptions[];
  readonly threads: vscode.CommentThread[];
}

/** Temporary, buffer-only annotations. The runtime supplies the foreground authorization check. */
export class EditorAnnotations implements vscode.Disposable {
  private readonly entries = new Map<vscode.TextDocument, RetainedAnnotations>();
  private readonly revisions = new WeakMap<vscode.TextDocument, number>();
  private readonly subscriptions: vscode.Disposable[];
  private decoration: vscode.TextEditorDecorationType | undefined;
  private commentController: vscode.CommentController | undefined;
  private generation = 0;
  private disposed = false;

  public constructor() {
    this.subscriptions = [
      vscode.workspace.onDidChangeTextDocument(({ document, contentChanges }) => {
        const retained = this.entries.get(document);
        if (contentChanges.length > 0 || (retained && retained.version !== document.version)) this.remove(document);
      }),
      vscode.workspace.onDidCloseTextDocument((document) => this.remove(document)),
      vscode.window.onDidChangeVisibleTextEditors(() => this.redraw()),
      vscode.window.tabGroups.onDidChangeTabs(({ closed }) => this.closeTabs(closed)),
    ];
  }

  public async annotate(
    params: Record<string, unknown>,
    origin: { cwd: string; root: string; assertCurrent: () => void },
  ): Promise<{ count: number; visible: boolean }> {
    const generation = this.generation;
    const folders = [...(vscode.workspace.workspaceFolders ?? [])];
    const folderPaths = folders.map((folder) => folder.uri.toString());
    const cwd = origin.cwd;
    const expectedRoot = origin.root;
    const check = () => {
      origin.assertCurrent();
      if (this.disposed || generation !== this.generation) throw new Error("Annotation request is no longer current.");
      if (!vscode.workspace.isTrusted) throw new Error("Annotations require a trusted workspace.");
      const currentFolders = vscode.workspace.workspaceFolders ?? [];
      if (
        origin.cwd !== cwd ||
        origin.root !== expectedRoot ||
        currentFolders.length !== folders.length ||
        currentFolders.some((folder, index) => folder.uri.toString() !== folderPaths[index])
      )
        throw new Error("Annotation workspace changed.");
    };
    const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
      check();
      try {
        return await operation();
      } finally {
        check();
      }
    };
    check();
    const annotations = validateParams(params);
    const requested = params.path as string;
    if (
      [cwd, expectedRoot].some((value) => typeof value !== "string" || !path.isAbsolute(value) || value.includes("\0"))
    )
      throw new Error("Annotations require an absolute originating working directory.");
    // A closed tab can leave a cached TextDocument. Require an actual text/diff tab at admission.
    const openUris = this.openTabUris();
    // Capture versions and revisions before any asynchronous filesystem validation.
    const documents = vscode.workspace.textDocuments.map((document) => ({
      document,
      open: openUris.has(document.uri.toString()),
      version: document.version,
      revision: this.revisions.get(document) ?? 0,
    }));
    const root = await checked(() => realpath(cwd));
    if (root !== expectedRoot) throw new Error("Annotation working directory no longer matches its originating root.");
    const candidates: { folder: vscode.WorkspaceFolder; relative: string }[] = [];
    for (const folder of folders) {
      if (folder.uri.scheme !== "file") continue;
      const folderRoot = await checked(() => realpath(folder.uri.fsPath));
      if (folderRoot !== root) continue;
      const relative = relativeInside(folder.uri.fsPath, requested) ?? relativeInside(root, requested);
      if (relative !== undefined) candidates.push({ folder, relative });
    }
    const candidate = candidates[0];
    if (candidates.length !== 1 || !candidate)
      throw new Error("Annotation path must belong to the originating workspace.");
    const { folder, relative } = candidate;
    const file = await checked(() => assertSafeFile(root, relative));
    const before = await checked(() => lstat(file));
    if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)
      throw new Error("Annotations require a regular single-link file.");
    const matches: typeof documents = [];
    for (const snapshot of documents) {
      const { document } = snapshot;
      if (document.isClosed || document.uri.scheme !== "file") continue;
      let canonical: string;
      try {
        canonical = await checked(() => realpath(document.uri.fsPath));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      if (canonical === file) matches.push(snapshot);
    }
    if (matches.length !== 1) throw new Error("Annotations require one unambiguous already-open document.");
    const { document, version, revision, open } = matches[0] as (typeof documents)[number];
    if (!open) throw new Error("Annotations require an already-open text or diff tab.");
    if (document.uri.query || document.uri.fragment) throw new Error("Unsupported annotation document URI.");
    const documentRelative =
      relativeInside(folder.uri.fsPath, document.uri.fsPath) ?? relativeInside(root, document.uri.fsPath);
    if (documentRelative !== relative) throw new Error("Annotation document is not a safe workspace resource.");
    const checkDocument = () => {
      check();
      if (
        document.isClosed ||
        !vscode.workspace.textDocuments.includes(document) ||
        !this.openTabUris().has(document.uri.toString()) ||
        vscode.workspace.textDocuments.some(
          (current) => current.uri.scheme === "file" && !documents.some((snapshot) => snapshot.document === current),
        ) ||
        document.version !== version ||
        (this.revisions.get(document) ?? 0) !== revision
      )
        throw new Error("Annotation document changed during validation.");
    };
    checkDocument();
    const checkContent = () => {
      for (const annotation of annotations) {
        if (annotation.endLine > document.lineCount) throw new Error("Annotation range is outside the document.");
        const expectedLines = annotation.expectedText.replace(/\r\n/g, "\n").split("\n");
        if (
          expectedLines.length !== annotation.endLine - annotation.startLine + 1 ||
          expectedLines.some((text, index) => document.lineAt(annotation.startLine - 1 + index).text !== text)
        )
          throw new Error("Annotation expected text does not match the current complete lines.");
      }
    };
    checkContent();
    const groups = new Map<number, { range: vscode.Range; comments: vscode.Comment[] }>();
    const options = annotations.map((annotation): vscode.DecorationOptions => {
      const line = annotation.endLine - 1;
      const end = document.lineAt(line).text.length;
      let group = groups.get(line);
      if (!group) {
        group = { range: new vscode.Range(line, end, line, end), comments: [] };
        groups.set(line, group);
      }
      group.comments.push({
        body: literalMarkdown(annotation.message),
        mode: vscode.CommentMode.Preview,
        author: { name: "Pi" },
      });
      return {
        range: new vscode.Range(
          annotation.startLine - 1,
          0,
          annotation.endLine - 1,
          document.lineAt(annotation.endLine - 1).text.length,
        ),
        hoverMessage: literalMarkdown("Pi annotation\n\n", annotation.message),
      };
    });
    await checked(() => assertSafeFile(root, relative));
    const after = await checked(() => lstat(file));
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.nlink !== 1 ||
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      (await checked(() => realpath(document.uri.fsPath))) !== file
    )
      throw new Error("Annotation file binding changed.");
    // Recheck root aliases last, after the asynchronous document and leaf validation.
    const bindings = await checked(() => Promise.all([realpath(folder.uri.fsPath), realpath(cwd)]));
    if (bindings.some((binding) => binding !== root)) throw new Error("Annotation workspace root binding changed.");
    checkDocument();
    checkContent();
    const previous = this.entries.get(document);
    const total = [...this.entries.values()].reduce((count, entry) => count + entry.options.length, 0);
    if (
      total - (previous?.options.length ?? 0) + options.length > 100 ||
      (options.length > 0 && !previous && this.entries.size >= 20)
    )
      throw new Error("Annotation retention limit exceeded.");
    const threads: vscode.CommentThread[] = [];
    try {
      if (options.length > 0) {
        this.decoration ??= vscode.window.createTextEditorDecorationType({
          isWholeLine: true,
          backgroundColor: new vscode.ThemeColor("editor.findMatchHighlightBackground"),
          borderColor: new vscode.ThemeColor("editor.findMatchHighlightBorder"),
          borderStyle: "solid",
          borderWidth: "1px",
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        });
        this.commentController ??= vscode.comments.createCommentController("pi.annotations", "Pi annotations");
        const expand = vscode.workspace.getConfiguration("pi").get("annotations.initialState") === "expanded";
        for (const { range, comments } of groups.values()) {
          const thread = this.commentController.createCommentThread(document.uri, range, comments);
          // Own each handle before setting properties so setter failures also release it.
          threads.push(thread);
          thread.label = "Pi annotation";
          thread.canReply = false;
          // Otherwise leave the API default (Collapsed) unchanged.
          if (expand) thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        }
      }
      // Native UI preparation must not authorize stale work. No await separates these checks and commit.
      checkDocument();
      checkContent();
    } catch (error) {
      for (const thread of threads) thread.dispose();
      throw error;
    }
    if (options.length > 0) this.entries.set(document, { version, options, threads });
    else this.entries.delete(document);
    this.revisions.set(document, revision + 1);
    for (const thread of previous?.threads ?? []) thread.dispose();
    this.render(document, options);
    return {
      count: options.length,
      visible: vscode.window.visibleTextEditors.some((editor) => editor.document === document),
    };
  }

  public clear(): void {
    this.generation++;
    for (const entry of this.entries.values()) for (const thread of entry.threads) thread.dispose();
    this.entries.clear();
    if (this.decoration)
      for (const editor of vscode.window.visibleTextEditors) editor.setDecorations(this.decoration, []);
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    for (const subscription of this.subscriptions) subscription.dispose();
    this.decoration?.dispose();
    this.decoration = undefined;
    this.commentController?.dispose();
    this.commentController = undefined;
  }

  private remove(document: vscode.TextDocument): void {
    this.revisions.set(document, (this.revisions.get(document) ?? 0) + 1);
    const retained = this.entries.get(document);
    this.entries.delete(document);
    for (const thread of retained?.threads ?? []) thread.dispose();
    this.render(document, []);
  }

  private render(document: vscode.TextDocument, options: vscode.DecorationOptions[]): void {
    if (!this.decoration) return;
    for (const editor of vscode.window.visibleTextEditors)
      if (editor.document === document) editor.setDecorations(this.decoration, options);
  }

  private openTabUris(): Set<string> {
    return new Set(vscode.window.tabGroups.all.flatMap((group) => group.tabs.flatMap((tab) => textTabUris(tab.input))));
  }

  private closeTabs(closed: readonly vscode.Tab[]): void {
    const closedUris = new Set(closed.flatMap((tab) => textTabUris(tab.input)));
    if (closedUris.size === 0) return;
    const openUris = this.openTabUris();
    // VS Code can cache a TextDocument after its last editor tab closes.
    for (const document of vscode.workspace.textDocuments) {
      const uri = document.uri.toString();
      if (closedUris.has(uri) && !openUris.has(uri)) this.remove(document);
    }
  }

  private redraw(): void {
    for (const [document, entry] of this.entries) {
      if (document.isClosed || document.version !== entry.version || !vscode.workspace.textDocuments.includes(document))
        this.remove(document);
    }
    if (!this.decoration) return;
    for (const editor of vscode.window.visibleTextEditors)
      editor.setDecorations(this.decoration, this.entries.get(editor.document)?.options ?? []);
  }
}

function literalMarkdown(...parts: string[]): vscode.MarkdownString {
  const markdown = new vscode.MarkdownString();
  markdown.isTrusted = false;
  markdown.supportHtml = false;
  // appendText escapes Markdown syntax but leaves HTML character references intact.
  for (const part of parts) markdown.appendText(part.replace(/&/g, "&amp;"));
  // Disable bare URL/email autolinks while preserving the literal displayed characters.
  markdown.value = markdown.value.replace(/[:@.]/g, (character) => `&#${character.charCodeAt(0)};`);
  return markdown;
}

function textTabUris(input: unknown): string[] {
  if (input instanceof vscode.TabInputText) return [input.uri.toString()];
  if (input instanceof vscode.TabInputTextDiff) return [input.original.toString(), input.modified.toString()];
  return [];
}

function relativeInside(root: string, file: string): string | undefined {
  const relative = path.relative(root, file);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    return undefined;
  return relative.split(path.sep).join("/");
}

function validateParams(params: Record<string, unknown>): Annotation[] {
  if (
    !params ||
    typeof params !== "object" ||
    Array.isArray(params) ||
    Object.keys(params).length !== 2 ||
    Object.keys(params).some((key) => key !== "path" && key !== "annotations") ||
    typeof params.path !== "string" ||
    !path.isAbsolute(params.path) ||
    params.path.includes("\0") ||
    !Array.isArray(params.annotations) ||
    params.annotations.length > 20
  )
    throw new Error("Invalid annotation parameters.");
  return Array.from(params.annotations, (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid annotation.");
    const item = value as Record<string, unknown>;
    if (
      Object.keys(item).length !== 4 ||
      Object.keys(item).some((key) => !["startLine", "endLine", "expectedText", "message"].includes(key)) ||
      !Number.isSafeInteger(item.startLine) ||
      !Number.isSafeInteger(item.endLine) ||
      (item.startLine as number) < 1 ||
      (item.endLine as number) < (item.startLine as number) ||
      (item.endLine as number) - (item.startLine as number) + 1 > 200 ||
      typeof item.expectedText !== "string" ||
      item.expectedText.length > 10_000 ||
      typeof item.message !== "string" ||
      item.message.length < 1 ||
      item.message.length > 1_000
    )
      throw new Error("Invalid annotation range, text, or message.");
    return {
      startLine: item.startLine as number,
      endLine: item.endLine as number,
      expectedText: item.expectedText,
      message: item.message,
    };
  });
}
