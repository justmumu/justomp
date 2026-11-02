import { expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { goLintAdapter } from "../../../src/lint/adapters/go";
import { type LintCheckContext } from "../../../src/lint/adapters/types";
import { applyGoLintResult, applyGoReadiness } from "../../../src/lint/go/result";
import { type LintCheck } from "../../../src/lint/model";
import * as runtime from "../../../src/lint/runtime";
import * as scopes from "../../../src/lint/scope";
import { suppliedResponse } from "../../response";
import { output, scope, target } from "./fixture";

function fixture() {
  const selected = target("go");
  const context: LintCheckContext = {
    target: selected,
    versions: { "golangci-lint": "2.15.0" },
    policy: resolveLintConfig().policy,
    signal: new AbortController().signal,
    projection: {
      target: selected,
      current: true,
      files: [],
      configs: { lint: "lint.yml", format: "lint.yml" },
    },
  };
  const checks: LintCheck[] = (["lint", "format"] as const).map((kind) => ({
    kind,
    status: "not-run",
    tool: "golangci-lint",
    version: "2.15.0",
    exit_code: null,
    duration_ms: 0,
    diagnostics: [],
    truncated: false,
    cancelled: false,
  }));
  return { context, checks };
}
for (const [name, result] of [
  ["truncated", output({ truncated: true, stdout: "{", exit_code: 1 })],
  ["cancelled", output({ cancelled: true, exit_code: null })],
  ["crashed", output({ exit_code: 9 })],
] as const) {
  test(`Go lint ${name} result leaves both checks incomplete`, () => {
    const f = fixture();
    applyGoLintResult(f.context, f.checks, result);
    for (const check of f.checks) {
      expect(check).toMatchObject({
        status: "not-run",
        exit_code: result.exit_code,
        truncated: result.truncated,
        cancelled: result.cancelled,
      });
      expect(check.reason).toBeTruthy();
    }
  });
}
test("Go lint empty diagnostics pass while malformed or missing failure diagnostics reject", () => {
  const f = fixture();
  applyGoLintResult(f.context, f.checks, output({ stdout: '{"Issues":null}' }));
  expect(f.checks.map((c) => c.status)).toEqual(["passed", "passed"]);
  for (const stdout of ['{"Issues":[]}', '{"Issues":{}}', '{"Issues":[{}]}', "invalid JSON"]) {
    const other = fixture();
    expect(() => applyGoLintResult(other.context, other.checks, output({ exit_code: 1, stdout }))).toThrow();
  }
});
test("Go lint separates formatter diagnostics and compiler failures block both stages", () => {
  const issue = (FromLinter: string) => ({
    FromLinter,
    Text: "issue",
    Severity: "warning",
    Pos: { Filename: "/repo/apps/app/main.go", Line: 2, Column: 3 },
  });
  const f = fixture();
  applyGoLintResult(
    f.context,
    f.checks,
    output({
      exit_code: 1,
      stdout: JSON.stringify({ Issues: [issue("gofumpt")] }),
    }),
  );
  expect(f.checks.map((c) => c.status)).toEqual(["passed", "failed"]);
  expect(f.checks[1]?.diagnostics[0]).toMatchObject({
    rule: "gofumpt",
    path: "apps/app/main.go",
    project_path: "main.go",
    line: 2,
    column: 3,
    severity: "warning",
  });
  const compiler = fixture();
  applyGoLintResult(
    compiler.context,
    compiler.checks,
    output({
      exit_code: 1,
      stdout: JSON.stringify({ Issues: [issue("typecheck")] }),
    }),
  );
  expect(compiler.checks.every((c) => c.status === "not-run" && c.reason?.includes("compiler diagnostics"))).toBe(true);
});
test("empty Go lint scope never invokes the runtime", async () => {
  const f = fixture(),
    files = spyOn(scopes, "collectLintScope").mockResolvedValue({
      ...scope("main.go"),
      files: [],
      empty: true,
    });
  const probe = spyOn(runtime, "lintManagerContext");
  try {
    expect((await goLintAdapter.check(f.context)).map((c) => c.status)).toEqual(["no-sources", "no-sources"]);
    expect(probe).not.toHaveBeenCalled();
  } finally {
    files.mockRestore();
    probe.mockRestore();
  }
});
test("pre-aborted Go lint leaves both checks cancelled", async () => {
  const f = fixture(),
    controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const files = spyOn(scopes, "collectLintScope").mockResolvedValue(scope("main.go"));
  const probe = spyOn(runtime, "lintManagerContext").mockImplementation(() => {
    return suppliedResponse(() => {
      throw controller.signal.reason;
    });
  });
  try {
    expect(
      (await goLintAdapter.check({ ...f.context, signal: controller.signal })).every(
        (c) => c.cancelled && c.status === "not-run",
      ),
    ).toBe(true);
  } finally {
    files.mockRestore();
    probe.mockRestore();
  }
});

test("truncated Go readiness probe preserves evidence and blocks both stages", () => {
  const f = fixture();
  expect(() => applyGoReadiness(f.checks, output({ exit_code: 1, stdout: "partial", truncated: true }))).toThrow(
    "truncated",
  );
  expect(f.checks.every((check) => check.truncated && check.status === "not-run" && check.exit_code === 1)).toBe(true);
});

test("Go lint failure preserves error severity without failing the formatter stage", () => {
  const f = fixture();
  applyGoLintResult(
    f.context,
    f.checks,
    output({
      exit_code: 1,
      stdout: JSON.stringify({
        Issues: [
          {
            FromLinter: "errcheck",
            Text: "unhandled error",
            Pos: { Filename: "/repo/apps/app/main.go", Line: 2 },
          },
        ],
      }),
    }),
  );
  expect(f.checks.map((check) => check.status)).toEqual(["failed", "passed"]);
  expect(f.checks[0]?.diagnostics[0]).toMatchObject({
    severity: "error",
    project_path: "main.go",
  });
});
