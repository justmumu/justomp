import { expect, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";

test("JavaScript policy declares runtime globals and preserves explicit empty globals", () => {
  expect(resolveLintConfig().policy.javascript.eslint.globals.console).toBe(
    "readonly",
  );
  expect(
    resolveLintConfig({ javascript: { eslint: { globals: {} } } }).policy
      .javascript.eslint.globals,
  ).toEqual({});
});
