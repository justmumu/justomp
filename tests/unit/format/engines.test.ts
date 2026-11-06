import { afterEach, expect, spyOn, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { type AdapterContext } from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import * as runner from "../../../src/dependencies/runner";
import { formatGo } from "../../../src/format/engines/go";
import { assertFormatProcess } from "../../../src/format/engines/process";
import { formatPython } from "../../../src/format/engines/python";
import { type LintCheckContext } from "../../../src/lint/adapters/types";
import * as install from "../../../src/lint/go/install";
import * as ruff from "../../../src/lint/ruff-install";
import * as runtime from "../../../src/lint/runtime";
import { output, target } from "../checks/fixture";

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
for (const language of ["python", "go"] as const) {
  test(`${language} format invokes only exact selected files in the prepared environment`, async () => {
    const selected = target(language);
    selected.scope.env = {
      PATH: "/bin",
      UV_PROJECT_ENVIRONMENT: ".custom-env",
      RUFF_OUTPUT_FILE: "bad",
    };
    const context: LintCheckContext = {
      target: selected,
      versions: { ruff: "0.17.3", "golangci-lint": "2.15.0" },
      policy: resolveLintConfig().policy,
      signal: new AbortController().signal,
      projection: {
        target: selected,
        files: [],
        current: true,
        configs: { lint: "/repo/lint", format: "/repo/format" },
      },
    };
    keep(spyOn(paths, "safePath").mockImplementation(async (_root, path) => path));
    keep(spyOn(install, "localGolangci").mockResolvedValue("/repo/golangci-lint"));
    keep(spyOn(ruff, "localRuff").mockResolvedValue("/repo/.justomp/tools/ruff/0.17.3/platform/ruff"));
    keep(spyOn(runtime, "lintManagerContext").mockResolvedValue({} as AdapterContext));
    const result = output({ exit_code: 9, stderr: "native failure" });
    const invoke = keep(spyOn(runner, "runProcess").mockResolvedValue(result));
    const files = language === "python" ? ["src/a file.py", "--flag.py"] : ["src/a file.go", "--flag.go"];
    expect(await (language === "python" ? formatPython : formatGo)(context, files)).toBe(result);
    const [binary, args, options] = invoke.mock.calls[0] ?? [];
    expect(binary).toBe(
      language === "python" ? "/repo/.justomp/tools/ruff/0.17.3/platform/ruff" : "/repo/golangci-lint",
    );
    expect(args).toEqual([
      language === "python" ? "format" : "fmt",
      "--config",
      "/repo/format",
      ...(language === "python" ? ["--force-exclude"] : []),
      "--",
      ...files.map((file) => `./${file}`),
    ]);
    expect(options).toMatchObject({
      cwd: selected.scope.cwd,
      signal: context.signal,
    });
    expect(options?.env).toMatchObject(
      language === "python" ? { RUFF_OUTPUT_FILE: undefined } : { GOPROXY: "off", GOTOOLCHAIN: "local" },
    );
    expect(invoke).toHaveBeenCalledTimes(1);
    if (language === "go") {
      for (const path of ["x...go", "nested.../main.go", ".hidden.go", "Main.GO"]) {
        await expect(formatGo(context, [path])).rejects.toThrow("safe explicit Go file");
      }
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  });
}
test("native format failures remain failures, including cancellation, termination and truncation", () => {
  expect(() => assertFormatProcess(output(), "ruff")).not.toThrow();
  for (const result of [
    output({ exit_code: 1, stderr: "parse failed" }),
    output({ exit_code: null, cancelled: true }),
    output({ exit_code: null, signal: "SIGTERM" }),
    output({ truncated: true }),
  ]) {
    expect(() => assertFormatProcess(result, "ruff")).toThrow();
  }
});
