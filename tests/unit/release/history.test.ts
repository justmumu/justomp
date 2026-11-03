import { expect, test } from "bun:test";
import { parseHistoryRecords, selectReleaseTag } from "../../../src/release/history";

test("baseline selects the highest canonical stable repository tag", () => {
  expect(selectReleaseTag(["v1.9.0", "v1.10.0", "other/v9.0.0", "v2.0.0-beta.1", "v01.0.0"])).toBe("v1.10.0");
  expect(selectReleaseTag([])).toBeNull();
});
test("native record parsing rejects incomplete history", () => {
  const hash = "a".repeat(40);
  expect(parseHistoryRecords(`${hash}\0feat: one\n\0\n`)).toEqual([{ hash, message: "feat: one\n" }]);
  expect(() => parseHistoryRecords(`${hash}\0feat: one`)).toThrow();
});
