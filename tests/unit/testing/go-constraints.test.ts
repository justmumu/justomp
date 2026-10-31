import { expect, test } from "bun:test";
import { validateIntegrationConstraints } from "../../../src/testing/go/constraints";
import { testGoFlags } from "../../../src/testing/go/environment";

const integration = { tag: "integration" };
const linux = { tag: "linux" };
test("integration is a required positive condition, including conjunctions and safe alternatives", () => {
  for (const expression of [
    integration,
    { and: [integration, linux] },
    { or: [{ and: [integration, linux] }, integration] },
  ])
    expect(() =>
      validateIntegrationConstraints([
        { file: "a_integration_test.go", expression },
      ]),
    ).not.toThrow();
  for (const expression of [
    null,
    { not: integration },
    { or: [integration, linux] },
  ])
    expect(() =>
      validateIntegrationConstraints([
        { file: "a_integration_test.go", expression },
      ]),
    ).toThrow("a_integration_test.go");
  expect(() =>
    validateIntegrationConstraints([
      { file: "bad.go", error: "malformed directive" },
    ]),
  ).toThrow("malformed directive");
});
test("suite owns integration tag while repeated tags use native last-value precedence", () => {
  expect(testGoFlags("-tags=old -tags=custom,integration -race", "unit")).toBe(
    "-race -tags=custom -mod=readonly",
  );
  expect(
    testGoFlags("-tags=custom,integration,integration", "integration"),
  ).toBe("-tags=custom,integration -mod=readonly");
  expect(testGoFlags("", "integration")).toBe(
    "-tags=integration -mod=readonly",
  );
});
