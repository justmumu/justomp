import { expect, test } from "bun:test";
import {
  evaluateCost,
  readGateReports,
  readTestReport,
} from "../../scripts/test-cost-report";

const xml =
  '<testsuites tests="1" failures="0" skipped="0"><testsuite><testcase file="tests/integration/example.native.test.ts" name="native boundary" classname="" time="1.2" /></testsuite></testsuites>';
test("Bun JUnit file attributes and optional errors count are parsed", () => {
  expect(readTestReport(xml)).toEqual({
    counts: { tests: 1, failures: 0, errors: 0, skipped: 0 },
    cases: [
      {
        file: "tests/integration/example.native.test.ts",
        name: "native boundary",
        seconds: 1.2,
      },
    ],
  });
});
test("missing, truncated or incomplete reports cannot prove a faster complete run", () => {
  for (const bad of [
    "",
    xml.replace("</testsuites>", ""),
    xml.replace('tests="1"', 'tests="2"'),
    xml.replace('time="1.2"', 'time="NaN"'),
  ])
    expect(() => readTestReport(bad)).toThrow();
});
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
  ])
    expect(evaluateCost(1, modified, [0, 0], 1000).complete).toBe(false);
  expect(evaluateCost(1, counts, [0, 1], 1000).complete).toBe(false);
  expect(evaluateCost(1, counts, [0], 1000).complete).toBe(false);
  expect(evaluateCost(1, counts, [0, 0]).reduction).toBeNull();
});

test("gate evidence includes unit skips and requires both reports", () => {
  const skippedUnit = xml.replace('skipped="0"', 'skipped="1"');
  const gate = readGateReports(skippedUnit, xml);
  expect(gate.counts).toEqual({ tests: 2, failures: 0, errors: 0, skipped: 1 });
  expect(evaluateCost(1, gate.counts, [0, 0], 1000).complete).toBe(false);
  expect(() => readGateReports("", xml)).toThrow();
  expect(() => readGateReports(xml, "")).toThrow();
  expect(readGateReports(xml, xml).counts.tests).toBe(2);
});
