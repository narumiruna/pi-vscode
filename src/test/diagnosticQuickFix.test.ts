import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiagnosticFixInstruction,
  filterFixableDiagnostics,
  selectDiagnosticAtPosition,
  type DiagnosticLike,
} from "../diagnosticQuickFix";

const warning: DiagnosticLike = {
  severity: 1,
  message: "Missing property \"icon\".",
  source: "json",
  code: "missing-property",
  range: {
    start: { line: 4, character: 2 },
    end: { line: 8, character: 3 },
  },
};

test("selectDiagnosticAtPosition prefers the most severe matching diagnostic", () => {
  const error = {
    ...warning,
    severity: 0,
    message: "Invalid value",
    range: { start: { line: 5, character: 0 }, end: { line: 5, character: 20 } },
  };

  assert.equal(selectDiagnosticAtPosition([warning, error], { line: 5, character: 5 }), error);
  assert.equal(selectDiagnosticAtPosition([warning], { line: 9, character: 0 }), undefined);
});

test("filterFixableDiagnostics keeps only errors and warnings", () => {
  const error = { ...warning, severity: 0, message: "Invalid value" };
  const information = { ...warning, severity: 2, message: "Consider extracting this" };
  const hint = { ...warning, severity: 3, message: "Unused declaration" };

  assert.deepEqual(filterFixableDiagnostics([hint, information, warning, error]), [warning, error]);
  assert.equal(
    selectDiagnosticAtPosition(filterFixableDiagnostics([information, hint]), { line: 5, character: 5 }),
    undefined,
  );
});

test("buildDiagnosticFixInstruction includes actionable diagnostic details", () => {
  const instruction = buildDiagnosticFixInstruction(warning);

  assert.match(instruction, /warning at line 5, column 3/i);
  assert.match(instruction, /Missing property "icon"/);
  assert.match(instruction, /Source: json/);
  assert.match(instruction, /Code: missing-property/);
});
