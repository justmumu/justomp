import { expect, test } from "bun:test";
import { commitRules } from "../../../src/commit/message";
import { resolveCommitConfig } from "../../../src/config/commit/resolve";

test("commit policy fills absent fields and honors explicit arrays", () => {
  const { policy, missing } = resolveCommitConfig({
    types: ["custom"],
    ignore_prefixes: [],
  });
  expect(missing).toBe(true);
  expect(policy.header_max_length).toBe(72);
  expect(policy.types).toEqual(["custom"]);
  expect(policy.ignore_prefixes).toEqual([]);
  expect(resolveCommitConfig(policy).missing).toBe(false);
  expect(commitRules(policy)["header-max-length"]).toEqual([2, "always", 72]);
  expect(commitRules(policy)).not.toHaveProperty("subject-case");
});
