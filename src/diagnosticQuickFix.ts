export interface PositionLike {
  readonly line: number;
  readonly character: number;
}

export interface RangeLike {
  readonly start: PositionLike;
  readonly end: PositionLike;
}

export interface DiagnosticLike {
  readonly range: RangeLike;
  readonly severity: number;
  readonly message: string;
  readonly source?: string;
  readonly code?: string | number | { readonly value: string | number };
}

export interface LineWindow {
  readonly startLine: number;
  readonly endLine: number;
}

export function selectDiagnosticAtPosition<T extends DiagnosticLike>(
  diagnostics: readonly T[],
  position: PositionLike,
): T | undefined {
  return diagnostics
    .filter(diagnostic => containsPosition(diagnostic.range, position))
    .sort((left, right) => left.severity - right.severity || rangeSize(left.range) - rangeSize(right.range))[0];
}

export function diagnosticLineWindow(
  lineCount: number,
  range: RangeLike,
  surroundingLines = 2,
): LineWindow {
  const lastLine = Math.max(0, lineCount - 1);
  return {
    startLine: Math.max(0, range.start.line - surroundingLines),
    endLine: Math.min(lastLine, range.end.line + surroundingLines),
  };
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

function containsPosition(range: RangeLike, position: PositionLike): boolean {
  return comparePositions(position, range.start) >= 0 && comparePositions(position, range.end) <= 0;
}

function comparePositions(left: PositionLike, right: PositionLike): number {
  return left.line - right.line || left.character - right.character;
}

function rangeSize(range: RangeLike): number {
  return (range.end.line - range.start.line) * 1_000_000 + range.end.character - range.start.character;
}
