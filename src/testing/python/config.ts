import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestRunContext } from "../adapters";
import { coverageEnabled } from "../native-tools";
export function pythonConfig(context: TestRunContext) {
  const enabled = coverageEnabled(context),
    report = join(context.artifacts, "junit.xml"),
    coverage = join(context.artifacts, "coverage.json"),
    rc = join(context.artifacts, "coverage.ini");
  const dirs = [...new Set(context.scope.sources.map((file) => dirname(resolve(context.target.scope.cwd, file))))];
  const config = `[run]\nbranch = false\ndata_file = ${join(context.artifacts, ".coverage")}\nsource =\n${dirs.map((d) => `    ${d}`).join("\n")}\n[report]\ninclude_namespace_packages = true\ninclude =\n${context.scope.sources.map((f) => `    ${resolve(context.target.scope.cwd, f)}`).join("\n")}\nfail_under = 0\n`;
  const pytestArgs = [
    "-o",
    "addopts=",
    "-o",
    "junit_family=xunit1",
    "-o",
    "junit_logging=no",
    "--maxfail=0",
    "-p",
    "no:rerunfailures",
    "-p",
    "no:flaky",
    "-p",
    "no:xdist",
    `--junitxml=${report}`,
    ...(enabled
      ? ["--cov", `--cov-config=${rc}`, `--cov-report=json:${coverage}`, "--cov-fail-under=0"]
      : ["--no-cov"]),
    ...context.scope.selected.map((f) => `./${f}`),
  ];
  const args = [
    fileURLToPath(new URL("./managed_pytest.py", import.meta.url)),
    JSON.stringify({ args: pytestArgs, selected: context.scope.selected }),
  ];
  return {
    args,
    pytestArgs,
    config,
    report,
    coverage,
    rc,
    env: {
      ...context.target.scope.env,
      COVERAGE_PROCESS_START: undefined,
      COVERAGE_RCFILE: rc,
    },
  };
}
