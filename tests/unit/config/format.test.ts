import { expect, test } from "bun:test";
import { resolveFormatConfig } from "../../../src/config/format/resolve";

test("format attributes prefer explicit values, then legacy values, then defaults", () => {
  const legacy = { singleQuote: true, printWidth: 88, futureOption: "keep" };
  const { policy, missing } = resolveFormatConfig(
    { prettier: { printWidth: 100 } },
    legacy,
  );
  expect(policy.prettier.singleQuote).toBe(true);
  expect(policy.prettier.printWidth).toBe(100);
  expect(policy.prettier.tabWidth).toBe(2);
  expect(policy.prettier.futureOption).toBe("keep");
  expect(missing).toBe(true);
  expect(legacy.printWidth).toBe(88);
  expect(resolveFormatConfig(policy).missing).toBe(false);
});

test("format empty pattern arrays and unknown attributes survive default resolution", () => {
  const { policy } = resolveFormatConfig({
    include: [],
    exclude: [],
    future: 1,
    prettier: { overrides: [] },
  });
  expect(policy.include).toEqual([]);
  expect(policy.exclude).toEqual([]);
  expect(policy.future).toBe(1);
  expect(policy.prettier.overrides).toEqual([]);
});

test.each([
  null,
  { include: [5] },
  { exclude: null },
  { prettier: { semi: "yes" } },
  { prettier: [] },
])("invalid format config is rejected: %j", (value) => {
  expect(() => resolveFormatConfig(value)).toThrow("format");
});
