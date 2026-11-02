import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as processRunner from "../../../src/dependencies/runner";
import * as javascriptNative from "../../../src/lint/javascript/native";
import * as runtime from "../../../src/lint/runtime";
import { vitestTestAdapter } from "../../../src/testing/javascript/vitest";
import { pythonTestAdapter } from "../../../src/testing/python/adapter";
import * as reports from "../../../src/testing/python/reports";
import { context } from "./fixture";

for (const runner of ["pytest", "vitest"] as const) {
  test(`${runner} targeted adapter returns native success without reading coverage`, async () => {
    const ctx = context("targeted");
    ctx.target.scope.owner = "/project";
    const process = {
      exit_code: 0,
      signal: null,
      cancelled: false,
      truncated: false,
      stdout: "native output",
      stderr: "",
    };
    const mocks = [
      spyOn(fs, "writeFile").mockResolvedValue(),
      spyOn(fs, "access").mockRejectedValue(Object.assign(new Error("absent"), { code: "ENOENT" })),
      spyOn(processRunner, "runProcess").mockResolvedValue(process),
      spyOn(runtime, "lintManagerContext").mockResolvedValue(
        {} as Awaited<ReturnType<typeof runtime.lintManagerContext>>,
      ),
      spyOn(javascriptNative, "localTool").mockResolvedValue(process),
    ];
    const evidence = spyOn(reports, "reportText").mockImplementation(async (path) => {
      if (path.endsWith("junit.xml")) {
        return '<testsuite tests="1"><testcase name="passes" file="tests/test-a.py"/></testsuite>';
      }
      if (path.endsWith("vitest.json")) {
        return JSON.stringify({
          numTotalTests: 1,
          testResults: [
            {
              name: "/project/tests/test-a.py",
              assertionResults: [{ title: "passes", status: "passed" }],
            },
          ],
        });
      }
      throw new Error("Targeted run must not read coverage");
    });
    try {
      const result = await (runner === "pytest" ? pythonTestAdapter : vitestTestAdapter).run(ctx);
      expect(result.errors).toEqual([]);
      expect(result.tests).toMatchObject({ total: 1, passed: 1, failed: 0 });
      expect(result.coverage).toBeUndefined();
      expect(result.executed_files).toEqual(["tests/test-a.py"]);
      expect(evidence).toHaveBeenCalledTimes(1);
    } finally {
      evidence.mockRestore();
      for (const mock of mocks.reverse()) {
        mock.mockRestore();
      }
    }
  });
}
