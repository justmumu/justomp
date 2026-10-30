import { expect, test } from "bun:test";
import {
  exactGlob,
  vitestOptions,
} from "../../../src/testing/javascript/config";
import {
  vitestCoverage,
  vitestReport,
} from "../../../src/testing/javascript/reports";
import { context } from "./fixture";

test("Vitest owns exact includes, workspace selection and all coverage thresholds", () => {
  const c = context();
  c.scope.selected = ["tests/a[one]+(two).test.ts"];
  const options = vitestOptions(c);
  expect(options.include).toEqual([exactGlob(c.scope.selected[0] ?? "")]);
  expect(options.include[0]).toContain("\\[");
  expect(options).not.toHaveProperty("projects");
  expect(options.retry).toBe(0);
  expect(options.bail).toBe(0);
  expect(options.coverage.thresholds).toBeUndefined();
  expect(vitestOptions(context("targeted")).coverage.enabled).toBe(false);
});
test("Vitest reports validate selected files and line totals without averaging", () => {
  const raw = {
    numTotalTests: 1,
    testResults: [
      {
        name: "/p/a.test.ts",
        assertionResults: [{ title: "fails", status: "failed" }],
      },
    ],
  };
  expect(
    vitestReport(JSON.stringify(raw), "/p", ["a.test.ts"]).tests.failed,
  ).toBe(1);
  expect(() =>
    vitestReport(JSON.stringify(raw), "/p", ["b.test.ts"]),
  ).toThrow();
  expect(
    vitestCoverage(
      JSON.stringify({
        "/p/a.ts": {
          statementMap: {
            0: { start: { line: 1 } },
            1: { start: { line: 1 } },
            2: { start: { line: 2 } },
          },
          s: { 0: 0, 1: 1, 2: 0 },
        },
      }),
      "/p",
      ["a.ts"],
    ),
  ).toEqual({ covered: 1, total: 2 });
});

test("Vitest rejects truncated JSON and coverage missing an owned source", () => {
  expect(() => vitestReport("{broken", "/p", ["a.test.ts"])).toThrow();
  expect(() => vitestCoverage("{}", "/p", ["src/unused.ts"])).toThrow();
  expect(() =>
    vitestCoverage(
      JSON.stringify({ "/elsewhere/a.ts": { statementMap: {}, s: {} } }),
      "/p",
      ["src/a.ts"],
    ),
  ).toThrow();
});
