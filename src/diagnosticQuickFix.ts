export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

export interface DiagnosticIdentity {
  readonly range: RangeLike;
  readonly severity: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string | number;
}

export interface DiagnosticLike extends Omit<DiagnosticIdentity, "code"> {
  readonly code?: string | number | { readonly value: string | number };
}

export interface DiagnosticCommandTarget {
  readonly uri: string;
  readonly diagnostic: DiagnosticIdentity;
}

export function selectDiagnosticAtPosition<T extends DiagnosticLike>(
  diagnostics: readonly T[],
  position: PositionLike,
): T | undefined {
  return diagnostics
    .filter(diagnostic => containsPosition(diagnostic.range, position))
    .sort((left, right) => left.severity - right.severity || rangeSize(left.range) - rangeSize(right.range))[0];
}

export function filterFixableDiagnostics<T extends DiagnosticLike>(diagnostics: readonly T[]): T[] {
  return diagnostics.filter(diagnostic => diagnostic.severity === 0 || diagnostic.severity === 1);
}

export function serializeDiagnosticCommandTarget(
  uri: string,
  diagnostic: DiagnosticLike,
): DiagnosticCommandTarget {
  return {
    uri,
    diagnostic: {
      range: {
        start: { ...diagnostic.range.start },
        end: { ...diagnostic.range.end },
      },
      severity: diagnostic.severity,
      message: diagnostic.message,
      source: diagnostic.source,
      code: diagnosticCode(diagnostic),
    },
  };
}

export function isDiagnosticCommandTarget(value: unknown): value is DiagnosticCommandTarget {
  if (!isRecord(value) || typeof value.uri !== "string" || !isRecord(value.diagnostic)) {
    return false;
  }
  const diagnostic = value.diagnostic;
  return (
    isRangeLike(diagnostic.range)
    && Number.isSafeInteger(diagnostic.severity)
    && typeof diagnostic.message === "string"
    && (diagnostic.source === undefined || typeof diagnostic.source === "string")
    && (diagnostic.code === undefined || typeof diagnostic.code === "string" || typeof diagnostic.code === "number")
  );
}

export function diagnosticsMatch(left: DiagnosticLike, right: DiagnosticIdentity): boolean {
  return (
    left.severity === right.severity
    && left.message === right.message
    && left.source === right.source
    && diagnosticCode(left) === right.code
    && comparePositions(left.range.start, right.range.start) === 0
    && comparePositions(left.range.end, right.range.end) === 0
  );
}

export function buildDiagnosticFixInstruction(diagnostic: DiagnosticLike): string {
  const severity = ["Error", "Warning", "Information", "Hint"][diagnostic.severity] ?? "Diagnostic";
  const source = diagnostic.source ? ` Source: ${diagnostic.source}.` : "";
  const codeValue = typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
  const code = codeValue === undefined ? "" : ` Code: ${String(codeValue)}.`;
  return [
    `Fix this VS Code ${severity.toLowerCase()} at line ${diagnostic.range.start.line + 1}, column ${diagnostic.range.start.character + 1}: ${diagnostic.message}`,
    `${source}${code}`.trim(),
    "Make the smallest correct change in the provided code and preserve unrelated behavior.",
  ].filter(Boolean).join("\n");
}

function diagnosticCode(diagnostic: DiagnosticLike): string | number | undefined {
  return typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code;
}

function isRangeLike(value: unknown): value is RangeLike {
  return isRecord(value) && isPositionLike(value.start) && isPositionLike(value.end);
}

function isPositionLike(value: unknown): value is PositionLike {
  return (
    isRecord(value)
    && Number.isSafeInteger(value.line)
    && Number(value.line) >= 0
    && Number.isSafeInteger(value.character)
    && Number(value.character) >= 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function containsPosition(range: RangeLike, position: PositionLike): boolean {
  return comparePositions(position, range.start) >= 0 && comparePositions(position, range.end) <= 0;
}

function comparePositions(left: PositionLike, right: PositionLike): number {
  return left.line - right.line || left.character - right.character;
}

function rangeSize(range: RangeLike): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
