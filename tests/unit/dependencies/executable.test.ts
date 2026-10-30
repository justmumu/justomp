import { expect, test } from "bun:test";
import { uvRequirement } from "../../../src/dependencies/executable";

test("uv requirement matching rejects exclusions and retains compatible release bounds", () => {
  expect(uvRequirement("0.11.6", "!=0.11.6")).toBe(false);
  expect(uvRequirement("0.11.6", "~=0.10")).toBe(true);
  expect(uvRequirement("0.11.6", "~=0.10.0")).toBe(false);
  expect(uvRequirement("0.11.6", ">=0.11,!=0.11.5,<0.12")).toBe(true);
});
