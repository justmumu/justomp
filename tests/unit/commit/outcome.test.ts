import { expect, test } from "bun:test";
import { classifyCommit } from "../../../src/commit/outcome";

test("a successful process cannot claim a concurrent different HEAD", () => {
  const native = {
    exit_code: 0,
    cancelled: false,
    stdout: "[main abcdef123] feat: ours\n",
  };
  expect(classifyCommit("old", "abcdef123456", native)).toBe(true);
  expect(classifyCommit("old", "987654321000", native)).toBeNull();
});
test("valid abbreviated hashes and closing brackets in branch names are recognized", () => {
  expect(
    classifyCommit("old", "abcdef123456", {
      exit_code: 0,
      cancelled: false,
      stdout: "[feature]demo abcd] feat: ours\n",
    }),
  ).toBe(true);
});
test("cancellation remains uncertain without an announced matching commit", () => {
  expect(
    classifyCommit("old", "old", {
      exit_code: null,
      cancelled: true,
      stdout: "",
    }),
  ).toBeNull();
  expect(
    classifyCommit("old", "old", {
      exit_code: 1,
      cancelled: false,
      stdout: "",
    }),
  ).toBe(false);
  expect(
    classifyCommit(null, "abcdef123456", {
      exit_code: null,
      cancelled: true,
      stdout: "[main (root-commit) abcdef123] feat: ours\n",
    }),
  ).toBe(true);
});
