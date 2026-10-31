import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonTestAdapter } from "../../../src/testing/python/adapter";
import { createLocalHost } from "./local-checkers";

// Host boundary only: native runner handoffs are proved once in testing/*.native.test.ts.
test("OMP project_test validates before setup, reports results and joins execution on root switch", async () => {
  const root = await mkdtemp(join(tmpdir(), "justomp-omp-test-")),
    other = await mkdtemp(join(tmpdir(), "justomp-omp-other-"));
  await writeFile(
    join(root, "pyproject.toml"),
    '[project]\nname="fixture"\nversion="0.1.0"\n[tool.uv]\npackage=false\n',
  );
  await mkdir(join(root, "tests/unit"), { recursive: true });
  await writeFile(join(root, "tests/unit/test_app.py"), "# test fixture");
  await mkdir(join(root, "tests/integration"));
  await writeFile(
    join(root, "tests/integration/test_api.py"),
    "# integration fixture",
  );
  let blocked = false,
    entered = () => {},
    joined = false;
  const mocks = [
    spyOn(pythonTestAdapter, "resolve").mockResolvedValue({
      pytest: "9.0.2",
      "pytest-cov": "7.0.0",
    }),
    spyOn(pythonTestAdapter, "preflight").mockResolvedValue(),
    spyOn(pythonTestAdapter, "verify").mockResolvedValue(true),
    spyOn(pythonTestAdapter, "run").mockImplementation(async (ctx) => {
      if (blocked) {
        entered();
        await new Promise<void>((resolve) => {
          if (ctx.signal.aborted) resolve();
          else
            ctx.signal.addEventListener("abort", () => resolve(), {
              once: true,
            });
        });
        joined = true;
      }
      return {
        tests: { total: 1, passed: 1, failed: 0, skipped: 0, cases: [] },
        coverage: { total: 0, covered: 0 },
        errors: [],
        executed_files: ctx.scope.selected,
        stdout: "",
        stderr: "",
        logs_truncated: false,
      };
    }),
  ];
  const host = await createLocalHost(root);
  try {
    const registration = host.runner.getRegisteredTool("project_test");
    expect(registration).toBeDefined();
    expect(registration?.definition.approval).toBe("exec");
    const schema = registration?.definition.parameters as {
      safeParse(v: unknown): { success: boolean };
    };
    expect(
      schema.safeParse({
        project_id: "python:pyproject.toml",
        ecosystem: "python",
      }).success,
    ).toBe(false);
    const tool = host.getTool("project_test"),
      unknown = await tool.execute("missing", { project_id: "missing" });
    expect(unknown.isError).toBe(true);
    expect(mocks[0]).not.toHaveBeenCalled();
    const result = await tool.execute("full", {
      project_id: "python:pyproject.toml",
    });
    expect(result.isError, JSON.stringify(result.details)).not.toBe(true);
    expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual(
      result.details,
    );
    expect((result.details as { success: boolean }).success).toBe(true);
    const integrationTool = host.getTool("project_integration_test");
    expect(
      host.runner.getRegisteredTool("project_integration_test")?.definition
        .approval,
    ).toBe("exec");
    const integration = await integrationTool.execute("integration", {
      project_id: "python:pyproject.toml",
    });
    expect(integration.details).toMatchObject({
      suite: "integration",
      success: true,
      coverage: { status: "disabled" },
    });
    expect(
      JSON.parse((integration.content[0] as { text: string }).text),
    ).toEqual(integration.details);
    const invalid = await integrationTool.execute("invalid", {
      project_id: "python:pyproject.toml",
      test_files: ["tests/unit/test_app.py"],
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.details).toMatchObject({
      suite: "integration",
      success: false,
    });
    blocked = true;
    const ready = new Promise<void>((r) => {
      entered = r;
    });
    const running = integrationTool.execute("blocked", {
      project_id: "python:pyproject.toml",
    });
    await ready;
    await host.session.moveTo(other, join(other, ".host/sessions"));
    await host.tool.execute("switch", {});
    const cancelled = await running;
    expect(cancelled.isError).toBe(true);
    expect(joined).toBe(true);
  } finally {
    await host.close();
    for (const mock of mocks.reverse()) mock.mockRestore();
    await rm(root, { recursive: true, force: true });
    await rm(other, { recursive: true, force: true });
  }
});
