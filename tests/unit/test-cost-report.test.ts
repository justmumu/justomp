import { expect, test } from "bun:test";
import { evaluateCost } from "../../scripts/test-cost-report";

test("cost acceptance requires successful gates, no skips and both requested targets", () => {
  const counts = { tests: 1, failures: 0, errors: 0, skipped: 0 };
  expect(evaluateCost(300, counts, [0, 0], 1000)).toMatchObject({
    complete: true,
    budget_met: true,
    reduction_met: true,
  });
  expect(evaluateCost(301, counts, [0, 0], 1000).budget_met).toBe(false);
  expect(evaluateCost(250, counts, [0, 0], 500).reduction_met).toBe(false);
  for (const modified of [
    { ...counts, skipped: 1 },
    { ...counts, failures: 1 },
    { ...counts, errors: 1 },
    { ...counts, tests: 0 },
  ]) {
    expect(evaluateCost(1, modified, [0, 0], 1000).complete).toBe(false);
  }
  expect(evaluateCost(1, counts, [0, 1], 1000).complete).toBe(false);
  expect(evaluateCost(1, counts, [0], 1000).complete).toBe(false);
  expect(evaluateCost(1, counts, [0, 0]).reduction).toBeNull();
});
