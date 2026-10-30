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
