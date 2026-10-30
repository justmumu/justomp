import { expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";
import type { TestAdapter } from "../../../src/testing/adapters";
import { testProject } from "../../../src/testing/service";

test("service validates before setup, owns fresh artifacts, and rejects changed sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-test-service-"));
  let preparations = 0,
    mutate = false;
  const artifacts: string[] = [];
  const adapter: TestAdapter = {
    resolve: async () => ({ vitest: "1.0.0" }),
    preflight: async () => {},
    verify: async () => true,
    prepare: async () => {
      preparations++;
    },
    run: async (ctx) => {
      artifacts.push(ctx.artifacts);
      expect(await readdir(ctx.artifacts)).toEqual([]);
      expect(ctx.remainingMs()).toBeGreaterThan(0);
      if (mutate)
        await writeFile(join(root, "src/app.ts"), "export const n=2;");
      return {
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, cases: [] },
        coverage: { total: 10, covered: 8 },
        errors: [],
        executed_files: ctx.scope.selected,
        stdout: "",
        stderr: "",
        logs_truncated: false,
      };
    },
  };
  try {
    await mkdir(join(root, "tests/unit"), { recursive: true });
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "package.json"),
      JSON.stringify({ name: "fixture", packageManager: "npm@10.9.0" }),
    );
    await writeFile(join(root, "src/app.ts"), "export const n=1;");
    await writeFile(join(root, "tests/unit/app.test.ts"), "// fixture");
    const id = (await getPackagingStructure(root, { publish: false })).structure
      .projects[0]?.project_id as string;
    await expect(
      testProject(root, { project_id: "missing" }, undefined, {
        vitest: adapter,
      }),
    ).rejects.toThrow();
    expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(
      false,
    );
    await expect(
      testProject(
        root,
        { project_id: id, test_files: ["src/app.ts"] },
        undefined,
        { vitest: adapter },
      ),
    ).rejects.toThrow();
    expect(preparations).toBe(0);
    const full = await testProject(root, { project_id: id }, undefined, {
      vitest: adapter,
    });
    expect(full.success).toBe(true);
    expect(full.coverage.percentage).toBe(80);
    const targeted = await testProject(
      root,
      { project_id: id, test_files: ["tests/unit/app.test.ts"] },
      undefined,
      { vitest: adapter },
    );
    expect(targeted.success).toBe(true);
    expect(targeted.coverage.status).toBe("not-enforced-targeted");
    expect(new Set(artifacts).size).toBe(2);
    expect(await readdir(join(root, ".justomp/test_runs"))).toEqual([]);
    mutate = true;
    const stale = await testProject(root, { project_id: id }, undefined, {
      vitest: adapter,
    });
    expect(stale.complete).toBe(false);
    expect(stale.errors.some((e) => e.code === "sources-changed")).toBe(true);
    expect(stale.tests.total).toBe(1);
    expect(
      JSON.parse(await readFile(join(root, ".justomp/config.json"), "utf8"))
        .test.javascript.coverage.minimum,
    ).toBe(70);
  } finally {
    await closePackagingStructure(root);
    await rm(root, { recursive: true, force: true });
  }
});
