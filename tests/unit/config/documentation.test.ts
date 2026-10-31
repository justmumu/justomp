import { expect, test } from "bun:test";
import lintExample from "../../../docs/lint-defaults.json";
import typecheckExample from "../../../docs/typecheck-defaults.json";
import { INSPECTION_DEFAULTS } from "../../../src/config/inspection/defaults";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";

test("published inspection and lint example matches field-completed policy", async () => {
  const example = lintExample;
  expect<unknown>(example).toEqual({
    inspection_rules: INSPECTION_DEFAULTS,
    lint: resolveLintConfig().policy,
  });
});

test("published typecheck default example matches field-completed policy", async () => {
  const example = typecheckExample;
  expect<unknown>(example).toEqual({
    typecheck: resolveTypecheckConfig().policy,
  });
});

import testExample from "../../../docs/test-defaults.json";
import { resolveTestConfig } from "../../../src/config/test/resolve";

test("documented test policy matches code defaults", () => {
  expect(testExample.test).toEqual(resolveTestConfig().policy);
});

import integrationExample from "../../../docs/integration-test-defaults.json";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";

test("documented integration policy matches code defaults", () => {
  expect<unknown>(integrationExample.integration_test).toEqual(
    resolveIntegrationTestConfig().policy,
  );
});
