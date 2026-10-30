import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import type { TypecheckCheckContext } from "../../../src/typecheck/adapters/types";
import * as native from "../../../src/typecheck/javascript/native";
import * as scopes from "../../../src/typecheck/scope";
import { output, scope, target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function fixture() {
  const selected = target("javascript"),
    controller = new AbortController();
  const context: TypecheckCheckContext = {
    target: selected,
    versions: { typescript: "7.0.2" },
    policy: resolveTypecheckConfig().policy,
    signal: controller.signal,
    projection: {
      target: selected,
      files: [],
      current: true,
      configs: { check: ["/repo/apps/app/tsconfig.justomp.json"] },
    },
  };
  const files = spyOn(scopes, "collectTypecheckScope").mockResolvedValue(
    scope("index.ts"),
  );
  const plan = spyOn(javascriptAdapter, "plan").mockResolvedValue(
    context.projection,
  );
  const run = spyOn(native, "typescriptRun").mockResolvedValue(output());
  restores.push(
    () => files.mockRestore(),
    () => plan.mockRestore(),
    () => run.mockRestore(),
  );
  return {
    context,
    controller,
    files,
    plan,
    run,
    check: () => javascriptAdapter.check(context),
  };
}
test("TypeScript empty scope needs neither projection nor compiler", async () => {
  const f = fixture();
  f.files.mockResolvedValue({ ...scope("index.ts"), files: [], empty: true });
  expect((await f.check())[0]?.status).toBe("no-sources");
  expect(f.plan).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
test("TypeScript checks every configuration read-only and retains earlier diagnostics", async () => {
  const f = fixture();
  f.context.projection.configs.check.push("/repo/apps/app/tests.json");
  f.run.mockResolvedValueOnce(
    output({
      exit_code: 2,
      stdout: "index.ts(2,3): error TS2345: Wrong argument.\n",
    }),
  );
  const check = (await f.check())[0];
  expect(check).toMatchObject({
    status: "failed",
    exit_code: 2,
    diagnostics: [
      {
        rule: "TS2345",
        path: "apps/app/index.ts",
        project_id: "javascript:apps/app",
      },
    ],
  });
  expect(f.run).toHaveBeenCalledTimes(2);
  for (const call of f.run.mock.calls) {
    expect(call[1]).toContain("--noEmit");
    expect(call[1].slice(-2)).toEqual(["--incremental", "false"]);
  }
});
for (const [name, result] of [
  ["crash with empty stderr", output({ exit_code: 9 })],
  ["truncated output", output({ truncated: true })],
  ["cancelled output", output({ exit_code: null, cancelled: true })],
  ["stderr failure", output({ stderr: "compiler failed" })],
  [
    "nonzero without diagnostics",
    output({ exit_code: 1, stdout: "unrecognized output" }),
  ],
] as const)
  test(`TypeScript ${name} cannot pass`, async () => {
    const f = fixture();
    f.run.mockResolvedValue(result);
    const check = (await f.check())[0];
    expect(check).toMatchObject({
      status: "not-run",
      exit_code: result.exit_code,
      truncated: result.truncated,
      cancelled: result.cancelled,
    });
    expect(check?.reason).toBeTruthy();
  });
test("TypeScript pre-aborted compiler invocation reports cancellation", async () => {
  const f = fixture();
  f.controller.abort(new Error("cancelled"));
  f.run.mockImplementation(async () => {
    f.controller.signal.throwIfAborted();
    return output();
  });
  expect((await f.check())[0]).toMatchObject({
    status: "not-run",
    cancelled: true,
  });
});
test("TypeScript stale or missing configurations never invoke the compiler", async () => {
  const f = fixture();
  f.plan.mockResolvedValue({ ...f.context.projection, current: false });
  expect((await f.check())[0]?.reason).toContain("needs preparation");
  f.plan.mockResolvedValue(f.context.projection);
  f.context.projection.configs.check = [];
  expect((await f.check())[0]?.reason).toContain("Missing TypeScript");
  expect(f.run).not.toHaveBeenCalled();
});
