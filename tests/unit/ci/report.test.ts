import { expect, test } from "bun:test";
import { type DriftObservation, parseGitStatus, summarizeCi } from "../../../scripts/ci/report";
import { receipts } from "../cost-fixture";

const outcomes = { install: "success", check: "success", integration: "success" };
const clean = (): DriftObservation[] =>
  ["install", "check", "integration"].map((stage) => ({ stage, head: "abc", changes: [] }));

test("Git status preserves staged, unstaged, renamed and unusual untracked paths", () => {
  expect(parseGitStatus("M  package.json\0 M bun.lock\0R  new name.ts\0old name.ts\0?? line\nname.ts\0")).toEqual([
    { status: "M ", path: "package.json" },
    { status: " M", path: "bun.lock" },
    { status: "R ", path: "new name.ts", from: "old name.ts" },
    { status: "??", path: "line\nname.ts" },
  ]);
  expect(parseGitStatus("")).toEqual([]);
  expect(() => parseGitStatus("M  incomplete")).toThrow();
  expect(() => parseGitStatus("R  destination\0")).toThrow();
});

test("CI reports the existing complete managed evidence without a second test pipeline", () => {
  const f = receipts();
  const result = summarizeCi(outcomes, "abc", clean(), f.check, f.integrated);
  expect(result.success).toBe(true);
  expect(result.gate?.coverage.percentage).toBe(75);
  expect(result.gate?.counts.tests).toBe(2);
});

test("observed drift stays failed even if a later observation is clean", () => {
  const f = receipts(),
    observations = clean();
  observations[0]?.changes.push({ status: " M", path: "package.json" });
  const result = summarizeCi(outcomes, "abc", observations, f.check, f.integrated);
  expect(result.success).toBe(false);
  expect(result.errors.join(" ")).toContain("package.json");
  expect(result.observations[2]?.changes).toEqual([]);
});

test("missing observations, changed revision or incomplete command results cannot pass", () => {
  const f = receipts();
  expect(summarizeCi(outcomes, "abc", clean().slice(1), f.check, f.integrated).success).toBe(false);
  expect(summarizeCi(outcomes, "different", clean(), f.check, f.integrated).success).toBe(false);
  f.check.complete = false;
  expect(summarizeCi(outcomes, "abc", clean(), f.check, f.integrated).success).toBe(false);
  expect(summarizeCi(outcomes, "abc", clean(), undefined, undefined).success).toBe(false);
});

test("a failing process outcome cannot be hidden by a successful receipt", () => {
  const f = receipts();
  expect(summarizeCi({ ...outcomes, check: "failure" }, "abc", clean(), f.check, f.integrated).success).toBe(false);
  expect(summarizeCi({ ...outcomes, integration: "cancelled" }, "abc", clean(), f.check, f.integrated).success).toBe(
    false,
  );
});
