import { expect, test } from "bun:test";
import { goCoverage } from "../../../src/testing/go/coverage";
import { GoEvents } from "../../../src/testing/go/reports";

test("Go counts top-level results once and rejects missing completion and foreign tests", () => {
  const events = new GoEvents("example/app", [
    { file: "a_test.go", name: "TestA" },
  ]);
  for (const event of [
    { Action: "start" },
    { Action: "run", Test: "TestA" },
    { Action: "run", Test: "TestA/child" },
    { Action: "pass", Test: "TestA/child" },
    { Action: "fail", Test: "TestA" },
    { Action: "fail" },
  ])
    events.write(
      Buffer.from(`${JSON.stringify({ Package: "example/app", ...event })}\n`),
    );
  expect(events.result().tests).toMatchObject({
    total: 1,
    failed: 1,
    passed: 0,
  });
  expect(events.result().tests.cases).toHaveLength(2);
  expect(events.result().errors.map((e) => e.code)).toEqual(["test-failed"]);
  const missing = new GoEvents("example/app", []);
  expect(() =>
    missing.write(Buffer.from('{"Package":"foreign","Action":"pass"}\n')),
  ).toThrow();
  expect(missing.result().tests.total).toBeNull();
});
test("Go native coverage merges blocks once and rejects inconsistent profiles", () => {
  const one = "mode: set\nexample/app/a.go:2.1,4.2 2 0\n",
    two =
      "mode: set\nexample/app/a.go:2.1,4.2 2 1\nexample/app/unused.go:1.1,1.5 1 0\n";
  const paths = new Map([
    ["example/app/a.go", "a.go"],
    ["example/app/unused.go", "unused.go"],
  ]);
  expect(goCoverage([one, two], paths)).toEqual({ covered: 2, total: 3 });
  expect(() =>
    goCoverage([one, two.replace("4.2 2 1", "4.2 3 1")], paths),
  ).toThrow();
  expect(() =>
    goCoverage([one.replace("mode: set", "mode: invalid")], paths),
  ).toThrow();
});

test("Go environment preserves native build tags and replaces only owned execution controls", async () => {
  const { testGoFlags } = await import("../../../src/testing/go/environment");
  expect(
    testGoFlags("-tags=custom -race -count=4 -failfast -run=Old -vet=off"),
  ).toBe("-tags=custom -race -mod=readonly");
  expect(testGoFlags("'-gcflags=all=-N -l'")).toBe(
    "'-gcflags=all=-N -l' -mod=readonly",
  );
  expect(() => testGoFlags("-exec=arbitrary")).toThrow("Unsupported");
});

test("Go retains same-name internal/external occurrences without inventing file ownership", () => {
  const events = new GoEvents("example/app", [
    { file: "internal_test.go", name: "TestSame" },
    { file: "external_test.go", name: "TestSame" },
  ]);
  for (const event of [
    { Action: "start" },
    { Action: "run", Test: "TestSame" },
    { Action: "run", Test: "TestSame" },
    { Action: "pass", Test: "TestSame" },
    { Action: "pass", Test: "TestSame" },
    { Action: "pass" },
  ])
    events.write(
      Buffer.from(`${JSON.stringify({ Package: "example/app", ...event })}\n`),
    );
  const result = events.result();
  expect(result.errors).toEqual([]);
  expect(result.tests).toMatchObject({ total: 2, passed: 2 });
  expect(result.tests.cases.every((c) => c.file === undefined)).toBe(true);
  expect(result.executed_files).toEqual([
    "internal_test.go",
    "external_test.go",
  ]);
  expect(() =>
    events.write(
      Buffer.from(
        `${JSON.stringify({
          Package: "example/app",
          Action: "pass",
          Test: "TestSame",
        })}\n`,
      ),
    ),
  ).toThrow("Repeated");
});
