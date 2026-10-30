import { expect, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import type { TypecheckCheckContext } from "../../../src/typecheck/adapters/types";
import {
  assertGoSuccess,
  goCompileOutcome,
  goDiagnostics,
  recordGoProcess,
} from "../../../src/typecheck/diagnostics/go";
import type { TypecheckCheck } from "../../../src/typecheck/model";
import { output, target } from "./fixture";

function context(): TypecheckCheckContext {
  const selected = target("go");
  return {
    target: selected,
    versions: { go: "1.25.0" },
    policy: resolveTypecheckConfig().policy,
    projection: {
      target: selected,
      current: true,
      files: [],
      configs: { check: [] },
    },
    signal: new AbortController().signal,
  };
}
test("Go process aggregation retains a failure after a clean package", () => {
  const check: TypecheckCheck = {
    status: "not-run",
    tool: "go",
    version: "1.25.0",
    exit_code: null,
    duration_ms: 0,
    diagnostics: [],
    truncated: false,
    cancelled: false,
  };
  recordGoProcess(
    check,
    output({ exit_code: 2, truncated: true, cancelled: true }),
  );
  recordGoProcess(check, output());
  expect(check).toMatchObject({
    exit_code: 2,
    truncated: true,
    cancelled: true,
  });
});
test("truncated Go discovery is rejected before parsing or compilation", () => {
  expect(() =>
    assertGoSuccess(
      output({ stdout: '{"GoFiles":', truncated: true }),
      "Go package discovery failed",
    ),
  ).toThrow("truncated");
});
test("Go compiler diagnostics containing runtime failure words remain completed failures", () => {
  const result = goCompileOutcome(
    context(),
    output({
      exit_code: 1,
      stderr:
        'main.go:3:5: cannot use "missing go.sum permission denied" (untyped string constant) as int value',
    }),
  );
  expect(result).toMatchObject({
    status: "failed",
    diagnostics: [{ message: expect.stringContaining("cannot use") }],
  });
});
test("Go diagnostics choose the longest Go project path regardless of ecosystem ordering", () => {
  const ctx = context();
  ctx.target.structure.projects.unshift({
    ...ctx.target.project,
    ecosystem: "javascript",
    project_id: "javascript:apps/app",
  });
  ctx.target.structure.projects.push({
    ...ctx.target.project,
    project_id: "go:apps/app/lib",
    path: "apps/app/lib",
  });
  expect(
    goDiagnostics(ctx, "main.go:1:2: wrong\nlib/extra.go:3: bad"),
  ).toMatchObject([
    {
      project_id: "go:apps/app",
      path: "apps/app/main.go",
      project_path: "main.go",
      line: 1,
      column: 2,
    },
    { project_id: "go:apps/app/lib", project_path: "extra.go", line: 3 },
  ]);
});
for (const [name, result] of [
  ["success", output()],
  [
    "missing dependency",
    output({
      exit_code: 1,
      stderr: "main.go:3:2: no required module provides package missing",
    }),
  ],
  [
    "compiler unavailable",
    output({ exit_code: 2, stderr: "cgo: C compiler not found" }),
  ],
  ["truncation", output({ truncated: true })],
  ["cancellation", output({ cancelled: true, exit_code: null })],
  ["unknown failure", output({ exit_code: 9 })],
] as const)
  test(`Go ${name} result is classified without a native compiler`, () => {
    const outcome = goCompileOutcome(context(), result);
    expect(outcome.status).toBe(name === "success" ? "passed" : "not-run");
    if (name !== "success")
      expect(outcome.reason).toContain("did not complete");
  });

test("pre-aborted Go check never resolves or invokes the native runtime", async () => {
  const { spyOn } = await import("bun:test");
  const runtime = await import("../../../src/lint/runtime");
  const { goAdapter } = await import("../../../src/typecheck/adapters/go");
  const probe = spyOn(runtime, "lintManagerContext");
  const ctx = context(),
    controller = new AbortController();
  controller.abort(new Error("cancelled"));
  try {
    expect(
      (await goAdapter.check({ ...ctx, signal: controller.signal }))[0],
    ).toMatchObject({ status: "not-run", cancelled: true });
    expect(probe).not.toHaveBeenCalled();
  } finally {
    probe.mockRestore();
  }
});
