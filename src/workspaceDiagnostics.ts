import { createHash } from "node:crypto";
import type { DiagnosticLike } from "./diagnosticQuickFix";

export const maxRepairDiagnostics = 100;
export const maxRepairFiles = 20;
export const maxRepairFileCharacters = 100_000;
export const maxRepairSnapshotCharacters = 400_000;
export interface RepairDiagnostic extends DiagnosticLike {
  readonly id: string;
  readonly path: string;
}
export interface DiagnosticRepairFile {
  readonly path: string;
  readonly version: number;
  readonly content: string;
}
export interface DiagnosticRepairSnapshot {
  readonly files: readonly DiagnosticRepairFile[];
  readonly diagnostics: readonly RepairDiagnostic[];
}
export interface DiagnosticReplacement {
  readonly path: string;
  readonly content: string;
}

export function diagnosticIdentity(path: string, diagnostic: DiagnosticLike): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        path,
        range: diagnostic.range,
        severity: diagnostic.severity,
        message: diagnostic.message,
        source: diagnostic.source,
        code: typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code,
      }),
    )
    .digest("hex")
    .slice(0, 24);
}

export function serializeDiagnosticRepair(snapshot: DiagnosticRepairSnapshot): string {
  if (
    !snapshot.files.length ||
    snapshot.files.length > maxRepairFiles ||
    !snapshot.diagnostics.length ||
    snapshot.diagnostics.length > maxRepairDiagnostics
  )
    throw new Error("Diagnostic repair file/count limit exceeded or selection is empty.");
  const paths = new Set(snapshot.files.map((file) => file.path));
  if (
    paths.size !== snapshot.files.length ||
    snapshot.files.some(
      (file) =>
        file.content.length > maxRepairFileCharacters ||
        !safePath(file.path) ||
        !Number.isSafeInteger(file.version) ||
        file.version < 0,
    )
  )
    throw new Error("Invalid, duplicate, or oversized repair file.");
  if (snapshot.diagnostics.some((item) => !paths.has(item.path)))
    throw new Error("Diagnostic refers to an uncaptured file.");
  const content = JSON.stringify(snapshot);
  if (content.length > maxRepairSnapshotCharacters)
    throw new Error("Diagnostic snapshot exceeds 400,000 characters. Select fewer files.");
  return content;
}

export function parseDiagnosticReplacements(
  response: string,
  snapshot: DiagnosticRepairSnapshot,
): DiagnosticReplacement[] {
  if (response.length > maxRepairSnapshotCharacters) throw new Error("Repair response exceeds 400,000 characters.");
  const value: unknown = JSON.parse(response.replace(/^```(?:json)?\s*\n([\s\S]*?)\n```\s*$/, "$1"));
  if (
    !record(value) ||
    !Array.isArray(value.files) ||
    !value.files.length ||
    value.files.length > maxRepairFiles ||
    Object.keys(value).some((key) => key !== "files")
  )
    throw new Error("Invalid multi-file repair response.");
  const seen = new Set<string>();
  const result: DiagnosticReplacement[] = [];
  for (const file of value.files) {
    if (
      !record(file) ||
      typeof file.path !== "string" ||
      typeof file.content !== "string" ||
      file.content.length > maxRepairFileCharacters ||
      file.content.includes("\0") ||
      Object.keys(file).some((key) => !["path", "content"].includes(key))
    )
      throw new Error("Invalid or oversized replacement file.");
    const source = snapshot.files.find((source) => source.path === file.path);
    if (!source || seen.has(file.path)) throw new Error("Unknown or duplicate replacement path.");
    seen.add(file.path);
    if (file.content !== source.content) result.push({ path: file.path, content: file.content });
  }
  if (!result.length) throw new Error("Pi proposed no changes.");
  return result;
}

function safePath(value: string): boolean {
  return (
    !!value &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes(":") &&
    value.split("/").every((part) => !!part && part !== ".." && part !== ".")
  );
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
