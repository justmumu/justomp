import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import type {
  AdapterContext,
  ProcessResult,
} from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import * as runner from "../../../src/dependencies/runner";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import type { LintCheckContext } from "../../../src/lint/adapters/types";
import * as native from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import * as scopes from "../../../src/lint/scope";
import { output, scope, target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function fixture(language: "python" | "javascript") {
  const selected = target(language),
    controller = new AbortController();
  const context: LintCheckContext = {
    target: selected,
    versions: { ruff: "0.17.3", eslint: "9.39.1", prettier: "3.6.2" },
    policy: resolveLintConfig().policy,
    signal: controller.signal,
    projection: {
      target: selected,
      files: [],
      current: true,
      configs: {
        lint: "/repo/apps/app/lint.config",
        format: "/repo/apps/app/format.config",
      },
    },
  };
  const files = keep(
    spyOn(scopes, "collectLintScope").mockResolvedValue(
      scope(language === "python" ? "module.py" : "index.ts"),
    ),
  );
  const invoke =
    language === "python"
      ? keep(spyOn(runner, "runProcess"))
      : keep(spyOn(native, "localTool"));
  keep(
    spyOn(paths, "safePath").mockImplementation(async (_root, path) => path),
  );
  keep(
    spyOn(runtime, "lintManagerContext").mockResolvedValue(
      {} as AdapterContext,
    ),
  );
  const adapter = language === "python" ? pythonAdapter : javascriptAdapter;
  function results(
    lint: ProcessResult,
    format = output({ stdout: language === "python" ? "[]" : "" }),
  ) {
    invoke.mockImplementation(async () => {
      controller.signal.throwIfAborted();
      return format;
    });
    invoke.mockResolvedValueOnce(lint);
  }
  return {
    context,
    controller,
    files,
    invoke,
    results,
    check: () => adapter.check(context),
  };
}
for (const language of ["python", "javascript"] as const) {
  test(`${language} empty scope returns no-sources without invoking a tool`, async () => {
    const f = fixture(language);
    f.files.mockResolvedValue({ ...scope("unused"), files: [], empty: true });
    expect((await f.check()).map((c) => c.status)).toEqual([
      "no-sources",
      "no-sources",
    ]);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  test(`${language} successful outputs pass both stages with explicit read-only arguments`, async () => {
    const f = fixture(language);
    f.results(output({ stdout: "[]" }));
    expect((await f.check()).map((c) => c.status)).toEqual([
      "passed",
      "passed",
    ]);
    expect(f.invoke).toHaveBeenCalledTimes(2);
    const argumentsText = JSON.stringify(f.invoke.mock.calls);
    expect(argumentsText).toContain(f.context.projection.configs.lint);
    expect(argumentsText).toContain(f.context.projection.configs.format);
    expect(argumentsText).toContain("--no-fix");
    expect(argumentsText).toContain(
      language === "python" ? "--check" : "--list-different",
    );
  });
  for (const [name, result] of [
    ["truncated", output({ exit_code: 1, stdout: "[", truncated: true })],
    ["cancelled", output({ exit_code: null, cancelled: true })],
    ["crashed", output({ exit_code: 9 })],
    ["malformed diagnostics", output({ exit_code: 1, stdout: "not JSON" })],
  ] as const)
    test(`${language} ${name} lint is incomplete and format still runs`, async () => {
      const f = fixture(language);
      f.results(result);
      const checks = await f.check();
      expect(checks[0]).toMatchObject({
        status: "not-run",
        exit_code: result.exit_code,
        cancelled: result.cancelled,
        truncated: result.truncated,
        diagnostics: [],
      });
      expect(checks[0]?.reason).toBeTruthy();
      expect(checks[1]?.status).toBe("passed");
      expect(f.invoke).toHaveBeenCalledTimes(2);
    });
  test(`${language} pre-aborted invocation marks both stages cancelled`, async () => {
    const f = fixture(language);
    f.invoke.mockImplementation(async () => {
      f.controller.signal.throwIfAborted();
      return output();
    });
    f.controller.abort(new Error("cancelled"));
    expect(
      (await f.check()).every((c) => c.cancelled && c.status === "not-run"),
    ).toBe(true);
  });
  test(`${language} process startup failure remains incomplete`, async () => {
    const f = fixture(language);
    f.invoke.mockRejectedValue(new Error("executable missing"));
    expect(
      (await f.check()).map((c) => ({ status: c.status, reason: c.reason })),
    ).toEqual([
      { status: "not-run", reason: "executable missing" },
      { status: "not-run", reason: "executable missing" },
    ]);
  });
}
test("Ruff diagnostics retain rule, coordinates and selected-project paths", async () => {
  const f = fixture("python");
  f.results(
    output({
      exit_code: 1,
      stdout: JSON.stringify([
        {
          filename: "/repo/apps/app/module.py",
          message: "Undefined name",
          code: "F821",
          location: { row: 3, column: 2 },
        },
      ]),
    }),
  );
  expect((await f.check())[0]).toMatchObject({
    status: "failed",
    diagnostics: [
      {
        rule: "F821",
        path: "apps/app/module.py",
        project_path: "module.py",
        line: 3,
        column: 2,
      },
    ],
  });
});
test("ESLint warnings and Prettier source differences map to independent failed checks", async () => {
  const f = fixture("javascript");
  f.results(
    output({
      exit_code: 1,
      stdout: JSON.stringify([
        {
          filePath: "/repo/apps/app/index.ts",
          messages: [
            {
              message: "Unused",
              ruleId: "no-unused-vars",
              severity: 1,
              line: 2,
              column: 1,
            },
          ],
        },
      ]),
    }),
    output({ exit_code: 1, stdout: "unrelated.log\n./index.ts\n" }),
  );
  const checks = await f.check();
  expect(checks[0]).toMatchObject({
    status: "failed",
    diagnostics: [
      {
        severity: "warning",
        rule: "no-unused-vars",
        path: "apps/app/index.ts",
      },
    ],
  });
  expect(checks[1]).toMatchObject({
    status: "failed",
    diagnostics: [{ project_path: "index.ts" }],
  });
  expect(checks[1]?.diagnostics).toHaveLength(1);
});
test("Prettier exit one without a source difference is incomplete, not a formatting failure", async () => {
  const f = fixture("javascript");
  f.results(
    output({ stdout: "[]" }),
    output({
      exit_code: 1,
      stdout: "unrelated.log",
      stderr: "formatter crashed",
    }),
  );
  expect((await f.check())[1]).toMatchObject({
    status: "not-run",
    reason: "formatter crashed",
    diagnostics: [],
  });
});
