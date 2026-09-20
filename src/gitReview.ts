import type { GitReviewSnapshot } from "./gitSnapshots";

export interface GitFinding {
  readonly path: string; readonly side: "before" | "after";
  readonly startLine: number; readonly endLine: number;
  readonly severity: "error" | "warning" | "info"; readonly message: string;
}
export interface GitReviewResult { readonly findings: readonly GitFinding[]; readonly incomplete: boolean }
export function reviewContext(snapshot: GitReviewSnapshot): string {
  const context = JSON.stringify({ repository: snapshot.repository.root, revision: snapshot.revision, scope: snapshot.scope,
    capturedAt: snapshot.capturedAt, files: snapshot.files, diff: snapshot.diff });
  if (context.length > 1_000_000) throw new Error("Git review context exceeds its transmission limit. Reduce the selected scope.");
  return context;
}
export function parseGitReview(response: string, snapshot: GitReviewSnapshot): GitReviewResult {
  if (response.length > 100_000) throw new Error("Git review response exceeds its limit.");
  const result: unknown = JSON.parse(response.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1"));
  if (!record(result) || !Array.isArray(result.findings) || result.findings.length > 100 || typeof result.incomplete !== "boolean") {
    throw new Error("Invalid Git review result; this is not evidence of no findings.");
  }
  const findings = result.findings.map((item: unknown): GitFinding => {
    if (!record(item) || typeof item.path !== "string" || !["before", "after"].includes(String(item.side))
      || !["error", "warning", "info"].includes(String(item.severity)) || typeof item.message !== "string"
      || !item.message.trim() || item.message.length > 2_000 || !Number.isSafeInteger(item.startLine) || !Number.isSafeInteger(item.endLine)) {
      throw new Error("Invalid Git finding fields.");
    }
    const side = item.side as "before" | "after";
    const file = snapshot.files.find(file => !file.skipped && (side === "before" ? file.oldPath : file.path) === item.path);
    const text = file?.[side];
    const lines = text === undefined || text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
    if (!file || Number(item.startLine) < 1 || Number(item.endLine) < Number(item.startLine) || Number(item.endLine) > lines) {
      throw new Error("Finding refers to an uncaptured path or invalid captured range.");
    }
    return { path: item.path, side, startLine: Number(item.startLine), endLine: Number(item.endLine), severity: item.severity as GitFinding["severity"], message: item.message };
  });
  return { findings, incomplete: result.incomplete || snapshot.files.some(file => !!file.skipped) };
}
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null; }
