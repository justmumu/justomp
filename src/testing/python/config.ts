import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type TestRunContext } from "../adapters";
import { coverageEnabled } from "../native-tools";
export function pythonConfig(context: TestRunContext) {
  const enabled = coverageEnabled(context),
    report = join(context.artifacts, "junit.xml"),
    coverage = join(context.artifacts, "coverage.json");
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
    "--no-cov",
    ...context.scope.selected.map((f) => `./${f}`),
  ];
  const payload = {
    args: pytestArgs,
    selected: context.scope.selected,
    ...(enabled
      ? {
          coverage: {
            sources: context.scope.sources.map((file) => resolve(context.target.scope.cwd, file)),
            data_file: join(context.artifacts, ".coverage"),
            report: coverage,
            include_namespace_packages: true,
          },
        }
      : {}),
  };
  const request = join(context.artifacts, "pytest-request.json");
  const args = [fileURLToPath(new URL("./managed_pytest.py", import.meta.url)), request];
  return {
    args,
    request,
    payload,
    pytestArgs,
    report,
    coverage,
    env: {
      ...context.target.scope.env,
      COVERAGE_PROCESS_START: undefined,
      COVERAGE_RCFILE: undefined,
    },
  };
}
