import { afterEach, expect, spyOn, test } from "bun:test";
import { FORMAT_DEFAULTS } from "../../../src/config/format/defaults";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import * as config from "../../../src/config/load";
import { type AdapterContext } from "../../../src/dependencies/model";
import * as paths from "../../../src/dependencies/paths";
import * as runner from "../../../src/dependencies/runner";
import { checkProjectFormat } from "../../../src/format/check";
import * as go from "../../../src/format/engines/go";
import * as prettier from "../../../src/format/engines/prettier";
import * as python from "../../../src/format/engines/python";
import * as files from "../../../src/format/files";
import * as scope from "../../../src/format/scope";
import { type LintCheckContext } from "../../../src/lint/adapters/types";
import * as coordinator from "../../../src/lint/coordinator";
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
function setup(paths: string[], language: "python" | "go" = "python") {
  const selected = target(language);
  const signal = new AbortController().signal;
  const policy = {
    format: FORMAT_DEFAULTS,
    lint: resolveLintConfig().policy,
  } as config.LoadedConfig;
  const context: LintCheckContext = {
    target: selected,
    versions: { ruff: "0.17.3", "golangci-lint": "2.15.0" },
    policy: policy.lint,
    signal,
    projection: {
      target: selected,
      files: [],
      current: true,
      configs: { lint: "/config", format: "/format" },
    },
  };
  keep(
    spyOn(coordinator, "withReadyLintTarget").mockImplementation(async (_root, _id, _adapters, operation) =>
      operation(context),
    ),
  );
  const load = keep(spyOn(config, "loadConfig").mockResolvedValue(policy));
  const collect = keep(
    spyOn(scope, "collectFormatScope").mockResolvedValue({
      ecosystem: language,
      files: paths,
    }),
  );
  keep(
    spyOn(files, "readFormatFile").mockResolvedValue({
      text: "source",
      identity: "1",
      mode: 0o644,
    }),
  );
  const publish = keep(spyOn(files, "publishFormatFile").mockRejectedValue(new Error("must not write")));
  const pretty = keep(spyOn(prettier, "checkPrettier").mockResolvedValue(true));
  const native = keep(
    (language === "python" ? spyOn(python, "checkPythonFormat") : spyOn(go, "checkGoFormat")).mockResolvedValue(
      output(),
    ),
  );
  return {
    selected,
    signal,
    context,
    policy,
    load,
    collect,
    publish,
    pretty,
    native,
  };
}
test("full format check retains metadata scope and configured policy without writes", async () => {
  const f = setup(["pyproject.toml", "README.md", "main.py"]);
  f.pretty.mockResolvedValueOnce(false);
  const result = await checkProjectFormat("/repo", f.selected.project.project_id, f.signal);
  expect(result).toMatchObject({
    success: false,
    complete: true,
    cancelled: false,
  });
  expect(result.files.map((file) => [file.path, file.status])).toEqual([
    ["pyproject.toml", "unformatted"],
    ["README.md", "passed"],
    ["main.py", "passed"],
  ]);
  expect(f.collect).toHaveBeenCalledWith(f.selected, f.policy.format, f.policy.lint);
  expect(f.pretty.mock.calls.map((call) => call[1])).toEqual(["toml", "markdown"]);
  expect(f.native.mock.calls[0]?.[1]).toEqual(["main.py"]);
  expect(f.publish).not.toHaveBeenCalled();
  expect(f.load.mock.calls.every((call) => call[1]?.flush !== true)).toBe(true);
});
test("native differences are completed failures, infrastructure failures stay incomplete", async () => {
  for (const [process, complete, status] of [
    [output({ exit_code: 1 }), true, "unformatted"],
    [output({ exit_code: 2, stderr: "parse failed" }), false, "error"],
    [output({ truncated: true }), false, "error"],
    [output({ exit_code: null, cancelled: true }), false, "error"],
  ] as const) {
    const f = setup(["main.py"]);
    f.native.mockResolvedValue(process);
    const result = await checkProjectFormat("/repo", f.selected.project.project_id, f.signal);
    expect(result).toMatchObject({
      success: false,
      complete,
      files: [{ status }],
    });
    for (const restore of restores.splice(0).reverse()) {
      restore();
    }
  }
});
test("Go diff output fails format even with zero exit, and an empty scope succeeds", async () => {
  const f = setup(["main.go"], "go");
  f.native.mockResolvedValue(output({ stdout: "diff source" }));
  expect(await checkProjectFormat("/repo", f.selected.project.project_id, f.signal)).toMatchObject({
    success: false,
    complete: true,
    files: [{ status: "unformatted" }],
  });
  f.native.mockResolvedValue(output({ exit_code: 1, stdout: "diff source" }));
  expect(await checkProjectFormat("/repo", f.selected.project.project_id, f.signal)).toMatchObject({
    success: false,
    complete: true,
    files: [{ status: "unformatted" }],
  });
  f.native.mockResolvedValue(output({ exit_code: 1, stderr: "invalid config" }));
  expect(await checkProjectFormat("/repo", f.selected.project.project_id, f.signal)).toMatchObject({
    success: false,
    complete: false,
    files: [{ status: "error" }],
  });
  f.collect.mockResolvedValue({ ecosystem: "go", files: [] });
  f.native.mockClear();
  expect(await checkProjectFormat("/repo", f.selected.project.project_id, f.signal)).toMatchObject({
    success: true,
    complete: true,
    files: [],
  });
  expect(f.native).not.toHaveBeenCalled();
});

for (const language of ["python", "go"] as const) {
  test(`${language} check passes non-writing flags and exact native paths`, async () => {
    const f = setup([], language);
    f.native.mockRestore();
    keep(spyOn(paths, "safePath").mockImplementation(async (_root, path) => path));
    keep(spyOn(install, "localGolangci").mockResolvedValue("/repo/golangci-lint"));
    keep(spyOn(ruff, "localRuff").mockResolvedValue("/repo/ruff"));
    keep(spyOn(runtime, "lintManagerContext").mockResolvedValue({} as AdapterContext));
    const invoke = keep(spyOn(runner, "runProcess").mockResolvedValue(output()));
    const filename = language === "python" ? "--flag.py" : "--flag.go";
    await (language === "python" ? python.checkPythonFormat : go.checkGoFormat)(f.context, [filename]);
    expect(invoke.mock.calls[0]?.[1]).toEqual([
      language === "python" ? "format" : "fmt",
      language === "python" ? "--check" : "--diff",
      "--config",
      "/format",
      ...(language === "python" ? ["--force-exclude"] : []),
      "--",
      `./${filename}`,
    ]);
  });
}
