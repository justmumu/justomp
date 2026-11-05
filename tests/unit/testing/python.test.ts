import { expect, test } from "bun:test";
import { pythonConfig } from "../../../src/testing/python/config";
import { context } from "./fixture";

test("pytest overrides owned addopts/retry/report controls and uses namespace directories", () => {
  const config = pythonConfig(context());
  expect(config.pytestArgs).toContain("./tests/test-a.py");
  expect(config.pytestArgs).toContain("--maxfail=0");
  expect(config.pytestArgs).toContain("addopts=");
  expect(config).not.toHaveProperty("config");
  expect(config).not.toHaveProperty("rc");
  expect(config.pytestArgs).toContain("--no-cov");
  expect(config.payload).toMatchObject({
    coverage: { sources: ["/project/src/ns/never.py"], include_namespace_packages: true },
  });
  expect(config.args[0]).toEndWith("managed_pytest.py");
  expect(config.args[1]).toBe("/reports/pytest-request.json");
  const targeted = pythonConfig(context("targeted"));
  expect(targeted.pytestArgs).toContain("--no-cov");
  expect(targeted.pytestArgs.some((a) => a.startsWith("--cov-report"))).toBe(false);
});
