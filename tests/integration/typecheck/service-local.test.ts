import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type TypecheckCheck } from "../../../src/typecheck/model";
import { prepareTypecheck } from "../../../src/typecheck/prepare";
import {
  checkProjectTypecheck,
  prepareProjectTypecheck,
  typecheckAdapters,
  typecheckProject,
} from "../../../src/typecheck/service";
import { fixture } from "./fixture";

const id = "python:a/pyproject.toml";
const checked: TypecheckCheck = {
  status: "failed",
  tool: "pyright",
  version: "1.0.0",
  exit_code: 1,
  duration_ms: 0,
  diagnostics: [
    {
      project_id: id,
      project_path: "module.py",
      severity: "error",
      rule: "reportAssignmentType",
      message: "Wrong type",
    },
  ],
  truncated: false,
  cancelled: false,
};
async function local(operation: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>) {
  const f = await fixture();
  const previous = typecheckAdapters.python;
  typecheckAdapters.python = f.adapter;
  f.adapter.check = async () => [structuredClone(checked)];
  await writeFile(join(f.root, "a/module.py"), 'value: int = "bad"\n');
  try {
    await operation(f);
  } finally {
    typecheckAdapters.python = previous;
  }
}
test("service retains a finished check when its caller cancels before freshness verification", async () => {
  await local(async (f) => {
    expect((await prepareProjectTypecheck(f.root, id)).complete).toBe(true);
    const controller = new AbortController();
    f.adapter.check = async () => {
      controller.abort(new Error("Caller cancelled"));
      return [structuredClone(checked)];
    };
    const result = await checkProjectTypecheck(f.root, id, controller.signal);
    expect(result).toMatchObject({
      cancelled: true,
      complete: false,
      diagnostics: checked.diagnostics,
      incomplete_stages: ["verification"],
    });
  });
});
test("service keeps aggregate setup errors visible while checking a ready selected ecosystem", async () => {
  await local(async (f) => {
    await writeFile(join(f.root, "package.json"), '{"name":"broken-js","packageManager":"npm@11.12.1"}');
    const previous = typecheckAdapters.javascript;
    typecheckAdapters.javascript = {
      ...previous,
      resolve: async () => {
        throw new Error("Unrelated JS setup failed");
      },
    };
    f.adapter.check = async () => [{ ...checked, status: "passed", exit_code: 0, diagnostics: [] }];
    try {
      const result = await typecheckProject(f.root, id);
      expect(result.success).toBe(true);
      expect(result.preparation.complete).toBe(false);
      expect(result.preparation.errors.some((e) => e.message.includes("Unrelated JS setup failed"))).toBe(true);
      expect(result.preparation.changes.length).toBeGreaterThan(0);
      expect(result.preparation.tools).toEqual({ pyright: "1.0.0" });
      expect(result.preparation).not.toHaveProperty("projects");
    } finally {
      typecheckAdapters.javascript = previous;
    }
  });
});
test("corrupt receipts remain byte-identical on read-only checks and explicit preparation revalidates them", async () => {
  await local(async (f) => {
    expect((await prepareProjectTypecheck(f.root, id)).complete).toBe(true);
    const path = join(f.root, ".justomp/typecheck_state.json");
    const verify = f.adapter.verifyTools.bind(f.adapter);
    let verifications = 0;
    f.adapter.verifyTools = async (ctx) => {
      verifications++;
      return verify(ctx);
    };
    for (const corrupt of ["{invalid", JSON.stringify({ schema: 99, projects: {}, waves: {} })]) {
      await writeFile(path, corrupt);
      expect((await checkProjectTypecheck(f.root, id)).checks[0]?.status).toBe("not-run");
      expect(await readFile(path, "utf8")).toBe(corrupt);
      const before = verifications;
      const recovered = await prepareTypecheck(f.root, typecheckAdapters, new AbortController().signal);
      expect(recovered.complete).toBe(true);
      expect(recovered.recovery).toBeDefined();
      expect(verifications).toBeGreaterThan(before);
      expect((await checkProjectTypecheck(f.root, id)).complete).toBe(true);
    }
  });
});

test("generated type orchestration retains a completed check after final tool readiness fails", async () => {
  const f = await fixture("javascript");
  await writeFile(join(f.root, "a/package.json"), JSON.stringify({ name: "a", packageManager: "npm@11.12.1" }));
  const projectId = "javascript:a/package.json";
  const adapters = { javascript: f.adapter };
  expect((await prepareTypecheck(f.root, adapters, new AbortController().signal)).complete).toBe(true);
  const { withJavascriptTypes } = await import("../../../src/typecheck/javascript/prepare-types");
  const result = await withJavascriptTypes(f.root, projectId, adapters, "check-only", async () => {
    await writeFile(join(f.root, "a/installed.json"), '{"typescript":"changed"}');
    return [
      {
        ...checked,
        status: "passed" as const,
        exit_code: 0,
        diagnostics: [],
      },
    ];
  });
  expect(result.ready).toBe(false);
  expect(result.preparation.complete).toBe(false);
  expect(result.value?.[0]?.status, JSON.stringify(result)).toBe("passed");
  expect(result.preparation.errors.some((error) => error.code === "not-ready")).toBe(true);
});
