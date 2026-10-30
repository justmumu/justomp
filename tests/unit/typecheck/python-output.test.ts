import { expect, test } from "bun:test";
import type { ProcessResult } from "../../../src/dependencies/model";
import { pyrightOutput } from "../../../src/typecheck/diagnostics/python";

const location = {
  root: "/repo",
  cwd: "/repo/apps/api",
  project_id: "python:apps/api/pyproject.toml",
  version: "1.1.414",
};
const result: ProcessResult = {
  exit_code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  cancelled: false,
  truncated: false,
};
const clean = {
  version: location.version,
  generalDiagnostics: [],
  summary: { filesAnalyzed: 1, errorCount: 0, warningCount: 0 },
};
test("Pyright result validates version, complete summaries and diagnostic coordinates", () => {
  expect(
    pyrightOutput(location, { ...result, stdout: JSON.stringify(clean) }, 1)
      .status,
  ).toBe("passed");
  const data = {
    ...clean,
    generalDiagnostics: [
      {
        file: "module.py",
        message: "Wrong type",
        severity: "error",
        rule: "reportAssignmentType",
        range: {
          start: { line: 0, character: 2 },
          end: { line: 0, character: 5 },
        },
      },
    ],
    summary: { filesAnalyzed: 1, errorCount: 1, warningCount: 0 },
  };
  expect(
    pyrightOutput(
      location,
      { ...result, exit_code: 1, stdout: JSON.stringify(data) },
      1,
    ),
  ).toMatchObject({
    status: "failed",
    diagnostics: [
      {
        project_id: location.project_id,
        path: "apps/api/module.py",
        project_path: "module.py",
        line: 1,
        column: 3,
        end_line: 1,
        end_column: 6,
        severity: "error",
        rule: "reportAssignmentType",
        message: "Wrong type",
      },
    ],
  });
  for (const malformed of [
    "bad json",
    JSON.stringify({ ...clean, version: "wrong" }),
    JSON.stringify({
      ...clean,
      summary: { ...clean.summary, filesAnalyzed: 0 },
    }),
    JSON.stringify({ ...clean, summary: { ...clean.summary, errorCount: 1 } }),
    JSON.stringify({
      ...data,
      generalDiagnostics: [
        {
          ...data.generalDiagnostics[0],
          range: {
            start: { line: -1, character: 0 },
            end: { line: 0, character: 0 },
          },
        },
      ],
    }),
  ])
    expect(() =>
      pyrightOutput(location, { ...result, stdout: malformed }, 1),
    ).toThrow();
  expect(
    pyrightOutput(
      location,
      { ...result, exit_code: 1, stdout: JSON.stringify(clean) },
      1,
    ),
  ).toMatchObject({
    status: "not-run",
    reason: "Pyright failed without error diagnostics",
  });
  const warning = { ...data.generalDiagnostics[0], severity: "warning" };
  const warningOnly = {
    ...clean,
    generalDiagnostics: [warning],
    summary: { filesAnalyzed: 1, errorCount: 0, warningCount: 1 },
  };
  expect(
    pyrightOutput(
      location,
      { ...result, exit_code: 1, stdout: JSON.stringify(warningOnly) },
      1,
    ),
  ).toMatchObject({
    status: "not-run",
    reason: "Pyright failed without error diagnostics",
    diagnostics: [{ severity: "warning", message: "Wrong type" }],
  });
});
test("crash, truncated and cancelled Pyright outputs cannot pass", () => {
  for (const partial of [
    { exit_code: 7 },
    { truncated: true },
    { cancelled: true },
    { stderr: "fatal error" },
  ])
    expect(
      pyrightOutput(
        location,
        { ...result, stdout: JSON.stringify(clean), ...partial },
        1,
      ).status,
    ).toBe("not-run");
});
