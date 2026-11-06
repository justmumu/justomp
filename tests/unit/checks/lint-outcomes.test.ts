import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { type ProcessResult } from "../../../src/dependencies/model";
import * as runner from "../../../src/dependencies/runner";
import * as prettier from "../../../src/format/engines/prettier";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { pythonAdapter } from "../../../src/lint/adapters/python";
import { type LintCheckContext } from "../../../src/lint/adapters/types";
import * as ruff from "../../../src/lint/ruff-install";
import * as scopes from "../../../src/lint/scope";
import * as toolchain from "../../../src/lint/toolchain";
import { suppliedResponse } from "../../response";
import { output, scope, target } from "./fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function keep<T extends { mockRestore(): void }>(spy: T): T {
  restores.push(() => spy.mockRestore());
  return spy;
}
function biomeReport(diagnostics: unknown[] = [], summary: Record<string, number> = {}) {
  return JSON.stringify({
    command: "check",
    summary: {
      changed: 0,
      unchanged: 1,
      matches: 0,
      errors: diagnostics.length,
      warnings: 0,
      infos: 0,
      skipped: 0,
      diagnosticsNotPrinted: 0,
      suggestedFixesSkipped: 0,
      ...summary,
    },
    diagnostics,
  });
}
function fixture(language: "python" | "javascript") {
  const selected = target(language),
    controller = new AbortController();
  const context: LintCheckContext = {
    target: selected,
    versions: { ruff: "0.17.3", "@biomejs/biome": toolchain.BIOME_VERSION, prettier: "3.9.10" },
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
    spyOn(scopes, "collectLintScope").mockResolvedValue(scope(language === "python" ? "module.py" : "index.ts")),
  );
  const invoke = keep(spyOn(runner, "runProcess"));
  keep(spyOn(ruff, "localRuff").mockResolvedValue("/owned/ruff"));
  keep(spyOn(toolchain, "bundledBiome").mockResolvedValue("/owned/biome"));
  const formatted = keep(spyOn(prettier, "checkPrettierFile").mockResolvedValue(true));
  const adapter = language === "python" ? pythonAdapter : javascriptAdapter;
  function results(lint: ProcessResult, format = output({ stdout: language === "python" ? "[]" : "" })) {
    invoke.mockImplementation(() => {
      return suppliedResponse(() => {
        controller.signal.throwIfAborted();
        return format;
      });
    });
    invoke.mockResolvedValueOnce(lint);
  }
  return {
    context,
    controller,
    files,
    invoke,
    formatted,
    results,
    check: () => adapter.check(context),
    fix: () => {
      if (!adapter.fix) {
        throw new Error("Missing fixture fixer");
      }
      return adapter.fix(context, ["module.py", "index.ts"]);
    },
  };
}
for (const language of ["python", "javascript"] as const) {
  test(`${language} empty scope returns no-sources without invoking a tool`, async () => {
    const f = fixture(language);
    f.files.mockResolvedValue({ ...scope("unused"), files: [], empty: true });
    expect((await f.check()).map((c) => c.status)).toEqual(["no-sources", "no-sources"]);
    expect(f.invoke).not.toHaveBeenCalled();
  });
  test(`${language} successful outputs pass both stages with explicit read-only arguments`, async () => {
    const f = fixture(language);
    f.results(output({ stdout: language === "python" ? "[]" : biomeReport() }));
    expect((await f.check()).map((c) => c.status)).toEqual(["passed", "passed"]);
    expect(f.invoke).toHaveBeenCalledTimes(language === "python" ? 2 : 1);
    const argumentsText = JSON.stringify(f.invoke.mock.calls);
    expect(argumentsText).toContain(f.context.projection.configs.lint);
    if (language === "python") {
      expect(argumentsText).toContain(f.context.projection.configs.format);
    } else {
      expect(f.formatted).toHaveBeenCalledWith(
        "/repo/apps/app/index.ts",
        "typescript",
        f.context.policy.javascript.prettier,
      );
    }
    if (language === "python") {
      expect(argumentsText).toContain("--no-fix");
    } else {
      expect(argumentsText).toContain("--formatter-enabled=false");
      expect(argumentsText).toContain("--enforce-assist=true");
      expect(argumentsText).toContain("--max-diagnostics=none");
      expect(argumentsText).not.toContain("--write");
      expect(argumentsText).not.toContain("--unsafe");
    }
    if (language === "python") {
      expect(argumentsText).toContain("--check");
    }
  });
  for (const [name, result] of [
    ["truncated", output({ exit_code: 1, stdout: "[", truncated: true })],
    ["cancelled", output({ exit_code: null, cancelled: true })],
    ["crashed", output({ exit_code: 9 })],
    ["malformed diagnostics", output({ exit_code: 1, stdout: "not JSON" })],
  ] as const) {
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
      expect(f.invoke).toHaveBeenCalledTimes(language === "python" ? 2 : 1);
    });
  }
  test(`${language} pre-aborted invocation marks both stages cancelled`, async () => {
    const f = fixture(language);
    f.invoke.mockImplementation(() => {
      return suppliedResponse(() => {
        f.controller.signal.throwIfAborted();
        return output();
      });
    });
    f.controller.abort(new Error("cancelled"));
    expect((await f.check()).every((c) => c.cancelled && c.status === "not-run")).toBe(true);
  });
  test(`${language} process startup failure remains incomplete`, async () => {
    const f = fixture(language);
    f.invoke.mockRejectedValue(new Error("executable missing"));
    expect((await f.check()).map((c) => ({ status: c.status, reason: c.reason }))).toEqual([
      { status: "not-run", reason: "executable missing" },
      language === "python"
        ? { status: "not-run", reason: "executable missing" }
        : { status: "passed", reason: undefined },
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
test("Biome import assist and Prettier source differences remain separate checks", async () => {
  const f = fixture("javascript");
  f.results(
    output({
      exit_code: 1,
      stdout: biomeReport([
        {
          severity: "error",
          message: "Imports not organized",
          category: "assist/source/organizeImports",
          location: {
            path: "index.ts",
            start: { line: 2, column: 1 },
            end: { line: 2, column: 8 },
          },
        },
      ]),
    }),
  );
  f.formatted.mockResolvedValue(false);
  const checks = await f.check();
  expect(checks[0]).toMatchObject({
    status: "failed",
    tool: "biome",
    diagnostics: [
      {
        kind: "lint",
        severity: "error",
        rule: "assist/source/organizeImports",
        path: "apps/app/index.ts",
        project_path: "index.ts",
      },
    ],
  });
  expect(checks[1]).toMatchObject({
    status: "failed",
    diagnostics: [{ project_path: "index.ts" }],
  });
});
for (const [label, report] of [
  ["skipped file", biomeReport([], { skipped: 1 })],
  ["unprinted diagnostics", biomeReport([], { diagnosticsNotPrinted: 1 })],
  ["missing required summary", JSON.stringify({ command: "check", diagnostics: [] })],
  ["foreign report command", JSON.stringify({ command: "lint", summary: {}, diagnostics: [] })],
  [
    "configuration diagnostic",
    biomeReport([
      {
        severity: "error",
        message: "Invalid config",
        category: "configuration",
      },
    ]),
  ],
  [
    "unknown category",
    biomeReport([
      {
        severity: "error",
        message: "Internal failure",
        category: "internalError",
      },
    ]),
  ],
  ["empty failing report", biomeReport()],
] as const) {
  test(`Biome ${label} cannot pass as a completed lint`, async () => {
    const f = fixture("javascript");
    f.results(output({ exit_code: 1, stdout: report }));
    expect((await f.check())[0]).toMatchObject({ status: "not-run" });
  });
}
test("Biome source parser diagnostics are completed failures and escaped locations are omitted", async () => {
  const f = fixture("javascript");
  f.results(
    output({
      exit_code: 1,
      stdout: biomeReport([
        {
          severity: "error",
          message: "Expected expression",
          category: "parse",
          location: { path: "../../outside.ts", start: { line: 1, column: 2 } },
        },
      ]),
    }),
  );
  const check = (await f.check())[0];
  expect(check?.status).toBe("failed");
  expect(check?.diagnostics[0]).toMatchObject({
    rule: "parse",
    message: "Expected expression",
  });
  expect(check?.diagnostics[0]?.path).toBeUndefined();
  expect(check?.diagnostics[0]?.line).toBeUndefined();
});
test("bundled Prettier parse errors leave format incomplete and report its runtime version", async () => {
  const f = fixture("javascript");
  f.results(output({ stdout: biomeReport() }));
  f.formatted.mockRejectedValue(new Error("formatter parse failed"));
  expect((await f.check())[1]).toMatchObject({
    status: "not-run",
    version: prettier.prettierVersion,
    reason: "formatter parse failed",
    diagnostics: [],
  });
});

for (const language of ["python", "javascript"] as const) {
  test(`${language} native fixer uses prepared executable, exact files and explicit fix policy`, async () => {
    const f = fixture(language);
    f.results(output({ exit_code: 1 }));
    expect((await f.fix()).exit_code).toBe(1);
    const argv = JSON.stringify(f.invoke.mock.calls);
    expect(argv).toContain(language === "python" ? "--fix" : "--write");
    expect(argv).not.toContain('"--no-fix"');
    expect(argv).toContain(f.context.projection.configs.lint);
    expect(argv).toContain("./module.py");
    expect(argv).toContain("./index.ts");
    if (language === "python") {
      expect(argv).toContain("--no-unsafe-fixes");
      expect(argv).toContain("--no-fix-only");
      expect(argv).toContain("--force-exclude");
    } else {
      expect(argv).not.toContain("--fix-type");
    }
    expect(f.formatted).not.toHaveBeenCalled();
    expect(f.invoke).toHaveBeenCalledTimes(1);
  });
}

test("Biome diagnostics outside selected files cannot claim a trusted child-project location", async () => {
  const f = fixture("javascript");
  f.results(
    output({
      exit_code: 1,
      stdout: biomeReport([
        {
          severity: "error",
          message: "Foreign source",
          category: "lint/suspicious/noDebugger",
          location: { path: "nested/index.ts", start: { line: 1, column: 1 } },
        },
      ]),
    }),
  );
  const diagnostic = (await f.check())[0]?.diagnostics[0];
  expect(diagnostic?.path).toBeUndefined();
  expect(diagnostic?.line).toBeUndefined();
});

test("Biome cannot pass when native traversal silently omits a selected file", async () => {
  const f = fixture("javascript");
  f.files.mockResolvedValue({
    ...scope("index.ts"),
    files: ["index.ts", "other.ts"],
  });
  f.results(output({ stdout: biomeReport() }));
  expect((await f.check())[0]?.status).toBe("not-run");
});

for (const severity of ["warning", "info"] as const) {
  for (const exit_code of [0, 1]) {
    test(`Biome ${severity} report preserves severity with native exit ${exit_code}`, async () => {
      const f = fixture("javascript");
      f.results(
        output({
          exit_code,
          stdout: biomeReport(
            [
              {
                severity,
                message: "Supplied diagnostic",
                category: "lint/suspicious/noDebugger",
                location: { path: "index.ts" },
              },
            ],
            {
              errors: 0,
              warnings: severity === "warning" ? 1 : 0,
              infos: severity === "info" ? 1 : 0,
            },
          ),
        }),
      );
      const result = (await f.check())[0];
      // Info alone cannot explain a failing exit; warnings can fail under native policy.
      expect(result?.status).toBe(exit_code === 0 ? "passed" : severity === "warning" ? "failed" : "not-run");
      if (result?.status !== "not-run") {
        expect(result?.diagnostics[0]?.severity).toBe(severity);
      }
    });
  }
}

for (const mismatch of ["command", "totals"] as const) {
  test(`Biome rejects otherwise completed reports with mismatched ${mismatch}`, async () => {
    const f = fixture("javascript");
    const report = JSON.parse(biomeReport());
    if (mismatch === "command") {
      report.command = "lint";
    } else {
      report.summary.warnings = 1;
    }
    f.results(output({ stdout: JSON.stringify(report) }));
    expect((await f.check())[0]?.status).toBe("not-run");
  });
}

test("JavaScript checks pass only the lint exclusions to source selection", async () => {
  const f = fixture("javascript");
  f.context.policy.javascript.exclude = [".private/**"];
  f.results(output({ stdout: biomeReport() }));
  await f.check();
  expect(f.files).toHaveBeenCalledWith(f.context.target, [".private/**"]);
});
