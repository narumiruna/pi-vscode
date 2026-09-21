import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import type { GitFinding, GitReviewResult } from "./gitReview";
import { type GitReviewSnapshot, scopeLabel } from "./gitSnapshots";

const scheme = "picode-review";
const maxReviews = 8;
export interface ReviewRecord {
  readonly id: string;
  readonly snapshot: GitReviewSnapshot;
  readonly result: GitReviewResult;
  readonly folder: vscode.Uri;
  readonly sessionId?: string;
}

export class ReviewFindingStore implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly records = new Map<string, ReviewRecord>();
  private readonly contents = new Map<string, string>();
  private readonly targets = new Map<string, { record: ReviewRecord; side: "before" | "after"; path: string }>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection("pi-review");
  private readonly registration = vscode.workspace.registerTextDocumentContentProvider(scheme, this);

  public publish(input: Omit<ReviewRecord, "id">): ReviewRecord {
    for (const record of this.records.values()) {
      if (
        record.snapshot.repository.root === input.snapshot.repository.root &&
        record.snapshot.scope.kind === input.snapshot.scope.kind
      )
        this.remove(record.id);
    }
    while (this.records.size >= maxReviews) this.remove(this.records.keys().next().value!);
    const record = { ...input, id: randomUUID() };
    this.records.set(record.id, record);
    for (const file of record.snapshot.files.filter((file) => !file.skipped)) {
      for (const side of ["before", "after"] as const) {
        const name = side === "before" ? file.oldPath : file.path;
        const uri = this.uri(record, side, name);
        this.contents.set(uri.toString(), file[side] ?? "");
        this.targets.set(uri.toString(), { record, side, path: name });
        const values = record.result.findings
          .filter((finding) => finding.path === name && finding.side === side)
          .map((finding, index) => {
            const diagnostic = new vscode.Diagnostic(
              findingRange(finding, file[side] ?? ""),
              finding.message,
              severity(finding.severity),
            );
            diagnostic.source = `Pi captured ${scopeLabel(record.snapshot.scope)} · ${new Date(record.snapshot.capturedAt).toISOString()}`;
            diagnostic.code = `${record.id}:${side}:${index}`;
            return diagnostic;
          });
        this.diagnostics.set(uri, values);
      }
    }
    return record;
  }

  public latest(stagedOnly = false): ReviewRecord | undefined {
    return [...this.records.values()]
      .reverse()
      .find((record) => !stagedOnly || record.snapshot.scope.kind === "staged");
  }
  public get(id: string): ReviewRecord | undefined {
    return this.records.get(id);
  }
  public target(uri: vscode.Uri): { record: ReviewRecord; side: "before" | "after"; path: string } | undefined {
    return this.targets.get(uri.toString());
  }
  public uri(record: ReviewRecord, side: "before" | "after", name: string): vscode.Uri {
    return vscode.Uri.from({ scheme, path: `/${side}/${name}`, query: record.id });
  }
  public provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? "This captured Pi review expired. Run Review Changes again.";
  }
  public remove(id: string): void {
    this.records.delete(id);
    for (const [key, target] of this.targets)
      if (target.record.id === id) {
        this.targets.delete(key);
        this.contents.delete(key);
        this.diagnostics.delete(vscode.Uri.parse(key));
      }
  }
  public dispose(): void {
    this.records.clear();
    this.contents.clear();
    this.targets.clear();
    this.diagnostics.dispose();
    this.registration.dispose();
  }
}

export function findingRange(finding: GitFinding, text: string): vscode.Range {
  const last = text.split(/\r?\n/)[finding.endLine - 1] ?? "";
  return new vscode.Range(finding.startLine - 1, 0, finding.endLine - 1, last.length);
}
function severity(value: GitFinding["severity"]): vscode.DiagnosticSeverity {
  return value === "error"
    ? vscode.DiagnosticSeverity.Error
    : value === "warning"
      ? vscode.DiagnosticSeverity.Warning
      : vscode.DiagnosticSeverity.Information;
}
