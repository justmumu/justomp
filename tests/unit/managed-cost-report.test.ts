import { expect, test } from "bun:test";
import { WORKLOAD } from "../../scripts/development/receipt";
import { baselineDuration, readManagedGateReports } from "../../scripts/test-cost-report";
import { receipts } from "./cost-fixture";

test("managed receipts retain both lanes and convert milliseconds to seconds", () => {
  const f = receipts();
  const report = readManagedGateReports(f.check, f.integrated);
  expect(report.counts).toEqual({ tests: 2, failures: 0, errors: 0, skipped: 0 });
  expect(report.unit.cases[0]?.seconds).toBe(1.2);
  expect(report.coverage.percentage).toBe(75);
});
test("missing unit stage and false completion never become successful cost evidence", () => {
  const f = receipts();
  f.check.result.stages = [];
  expect(() => readManagedGateReports(f.check, f.integrated)).toThrow();
  for (const field of ["success", "complete"] as const) {
    const incomplete = receipts();
    incomplete.check[field] = false;
    expect(() => readManagedGateReports(incomplete.check, incomplete.integrated)).toThrow();
  }
  const cancelled = receipts();
  cancelled.integrated.cancelled = true;
  expect(() => readManagedGateReports(cancelled.check, cancelled.integrated)).toThrow();
});
test("owned report validation rejects inconsistent counts, missing timings and unusable coverage", () => {
  const changes = [
    (f: ReturnType<typeof receipts>) => {
      f.unit.tests.total = 0;
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.tests.passed = 2;
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.tests.skipped = 1;
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.tests.cases[0] = { name: "bad", file: "test.ts", status: "passed", duration_ms: Number.NaN };
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.coverage.status = "unavailable";
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.coverage.percentage = 20;
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.coverage.total = 0;
    },
    (f: ReturnType<typeof receipts>) => {
      f.unit.logs_truncated = true;
    },
    (f: ReturnType<typeof receipts>) => {
      f.integrated.root = "/other";
    },
  ];
  for (const change of changes) {
    const f = receipts();
    change(f);
    expect(() => readManagedGateReports(f.check, f.integrated)).toThrow();
  }
});
test("only matching complete warm workloads supply a reduction baseline", () => {
  const baseline = {
    version: 2,
    workload: WORKLOAD,
    complete: true,
    cache: "warm",
    environment: { bun: "1.4.2" },
    seconds: 400,
  };
  expect(baselineDuration(baseline, baseline.environment)).toBe(400);
  for (const override of [
    { workload: "historical-shell-chain" },
    { cache: "cold" },
    { seconds: Number.NaN },
    { environment: {} },
    { complete: false },
  ]) {
    expect(() => baselineDuration({ ...baseline, ...override }, baseline.environment)).toThrow();
  }
});
