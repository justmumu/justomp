import { expect, test } from "bun:test";
import { pythonConfig } from "../../../src/testing/python/config";
import { context } from "./fixture";

test("pytest overrides owned addopts/retry/report controls and uses namespace directories", () => {
  const config = pythonConfig(context());
  expect(config.pytestArgs).toContain("./tests/test-a.py");
  expect(config.pytestArgs).toContain("--maxfail=0");
  expect(config.pytestArgs).toContain("addopts=");
  expect(config.config).toContain("    /project/src/ns");
  expect(config.config).toContain("include_namespace_packages = true");
  expect(config.args[0]).toEndWith("managed_pytest.py");
  const targeted = pythonConfig(context("targeted"));
  expect(targeted.pytestArgs).toContain("--no-cov");
  expect(targeted.pytestArgs.some((a) => a.startsWith("--cov-report"))).toBe(
    false,
  );
});
