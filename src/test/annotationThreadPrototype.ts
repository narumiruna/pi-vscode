import * as vscode from "vscode";

export interface PrototypeAnnotation {
  /** Inclusive, one-based end line of an already validated passage. */
  readonly endLine: number;
  readonly message: string;
}

/** Test-only native layout probe. This is not an authorized annotation workflow. */
export class AnnotationThreadPrototype implements vscode.Disposable {
  private controller: vscode.CommentController | undefined;
  private readonly entries = new Map<vscode.TextDocument, vscode.CommentThread[]>();
  private disposed = false;

  public replace(document: vscode.TextDocument, annotations: readonly PrototypeAnnotation[]): void {
    if (this.disposed) throw new Error("Annotation thread prototype is disposed.");
    if (document.isClosed) throw new Error("Annotation document is closed.");
    if (!Array.isArray(annotations) || annotations.length > 20) throw new Error("Invalid prototype annotations.");

    // Prepare every body and anchor before creating native UI or changing retained threads.
    const groups = new Map<number, { range: vscode.Range; comments: vscode.Comment[] }>();
    for (const annotation of annotations) {
      if (
        !annotation ||
        !Number.isSafeInteger(annotation.endLine) ||
        annotation.endLine < 1 ||
        annotation.endLine > document.lineCount ||
        typeof annotation.message !== "string" ||
        annotation.message.length < 1 ||
        annotation.message.length > 1_000
      )
        throw new Error("Invalid prototype annotation range or message.");
      const line = annotation.endLine - 1;
      const end = document.lineAt(line).text.length;
      let group = groups.get(line);
      if (!group) {
        group = { range: new vscode.Range(line, end, line, end), comments: [] };
        groups.set(line, group);
      }
      const body = new vscode.MarkdownString();
      body.isTrusted = false;
      body.supportHtml = false;
      // Match EditorAnnotations: escape entity input before Markdown, then disable autolinks.
      body.appendText(annotation.message.replace(/&/g, "&amp;"));
      body.value = body.value.replace(/[:@.]/g, (character) => `&#${character.charCodeAt(0)};`);
      group.comments.push({ body, mode: vscode.CommentMode.Preview, author: { name: "Pi" } });
    }

    const replacement: vscode.CommentThread[] = [];
    try {
      if (groups.size > 0) {
        this.controller ??= vscode.comments.createCommentController("pi.annotation-thread-prototype", "Pi annotations");
        for (const { range, comments } of groups.values()) {
          const thread = this.controller.createCommentThread(document.uri, range, comments);
          // Own the handle before setting properties, so setter failures also clean up.
          replacement.push(thread);
          thread.label = "Pi annotation";
          thread.canReply = false;
          thread.collapsibleState = vscode.CommentThreadCollapsibleState.Expanded;
        }
      }
    } catch (error) {
      for (const thread of replacement) thread.dispose();
      throw error;
    }

    const previous = this.entries.get(document);
    if (replacement.length > 0) this.entries.set(document, replacement);
    else this.entries.delete(document);
    for (const thread of previous ?? []) thread.dispose();
  }

  public clear(document?: vscode.TextDocument): void {
    if (document) {
      const threads = this.entries.get(document);
      this.entries.delete(document);
      for (const thread of threads ?? []) thread.dispose();
      return;
    }
    for (const threads of this.entries.values()) for (const thread of threads) thread.dispose();
    this.entries.clear();
  }

  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.clear();
    this.controller?.dispose();
    this.controller = undefined;
  }
}
