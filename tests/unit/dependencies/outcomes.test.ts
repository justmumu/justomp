import { expect, test } from "bun:test";
import { parseInventory } from "../../../src/dependencies/inventory";
import { redactValues } from "../../../src/dependencies/model";
import { context } from "./adapters/npm-pnpm-fixture";

test("inventory keeps planning credentials while response redaction copies safe values", () => {
  const source =
    "git+https://fixture-user:fixture-secret@example.invalid/repo.git?token=fixture-token#main";
  const inventory = parseInventory(
    context("npm").project,
    JSON.stringify({ dependencies: { foo: source } }),
  );
  expect(inventory.dependencies[0]?.declared_specifier).toBe(source);
  const visible = redactValues(inventory);
  expect(JSON.stringify(visible)).not.toContain("fixture-secret");
  expect(JSON.stringify(visible)).not.toContain("fixture-token");
  expect(inventory.dependencies[0]?.declared_specifier).toBe(source);
});
