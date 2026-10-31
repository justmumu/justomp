import { expect, test } from "bun:test";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import { resolveTestConfig } from "../../../src/config/test/resolve";

test("integration defaults are optional, preserve arrays and disable coverage", () => {
  const { policy, missing } = resolveIntegrationTestConfig({
    python: { include: [], coverage: { minimum: 12 } },
    future: true,
  });
  expect(missing).toBe(true);
  expect(policy.python.include).toEqual([]);
  expect(policy.python.coverage).toEqual({ enabled: false, minimum: 12 });
  expect(policy.javascript.include).toEqual([
    "tests/integration/**/*.test.{js,jsx,ts,tsx}",
  ]);
  expect(policy.go.include).toEqual(["**/*_integration_test.go"]);
  expect(policy.future).toBe(true);
  expect(resolveIntegrationTestConfig(policy).missing).toBe(false);
  expect(() =>
    resolveIntegrationTestConfig({ go: { coverage: { enabled: null } } }),
  ).toThrow("integration_test.go.coverage.enabled");
});
test("only new unit Go defaults exclude integration filenames", () => {
  expect(resolveTestConfig().policy.go.exclude).toContain(
    "**/*_integration_test.go",
  );
  expect(resolveTestConfig({ go: { exclude: [] } }).policy.go.exclude).toEqual(
    [],
  );
});
