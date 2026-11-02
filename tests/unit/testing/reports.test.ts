import { expect, test } from "bun:test";
import { junitReport, lcovReport, pythonCoverage } from "../../../src/testing/python/reports";

test("JUnit retains failures and validates report structure and ownership", () => {
  const xml =
    '<testsuites><testsuite tests="2"><testcase name="bad" file="a.test.ts"><failure message="oops"/></testcase><testcase name="good" file="a.test.ts"/></testsuite></testsuites>';
  expect(junitReport(xml, "/p", ["a.test.ts"]).tests).toMatchObject({
    total: 2,
    failed: 1,
    passed: 1,
  });
  for (const invalid of [xml.slice(0, -2), `<!DOCTYPE test>${xml}`, xml.replaceAll("a.test.ts", "foreign.ts")]) {
    expect(() => junitReport(invalid, "/p", ["a.test.ts"])).toThrow();
  }
});
test("LCOV counts only owned sources and requires every source", () => {
  const lcov = "SF:src/a.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n";
  expect(lcovReport(lcov, "/p", ["src/a.ts"])).toEqual({
    covered: 1,
    total: 2,
  });
  expect(() => lcovReport(lcov, "/p", ["src/a.ts", "src/unused.ts"])).toThrow();
  expect(() => lcovReport(lcov.replace("end_of_record", ""), "/p", ["src/a.ts"])).toThrow();
});

test("coverage.py JSON rejects missing, malformed and foreign-source reports", () => {
  const data = {
    files: { "src/a.py": { summary: { covered_lines: 1, num_statements: 3 } } },
  };
  expect(pythonCoverage(JSON.stringify(data), "/p", ["src/a.py"])).toEqual({
    covered: 1,
    total: 3,
  });
  for (const bad of [
    "{broken",
    JSON.stringify({ files: {} }),
    JSON.stringify({ files: { "other.py": data.files["src/a.py"] } }),
  ]) {
    expect(() => pythonCoverage(bad, "/p", ["src/a.py"])).toThrow();
  }
});
