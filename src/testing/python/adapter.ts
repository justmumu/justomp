import { writeFile } from "node:fs/promises";
import { runProcess } from "../../dependencies/runner";
import type { TestAdapter } from "../adapters";
import {
  classifyResult,
  coverageEnabled,
  nativeResult,
  parseEvidence,
  preflightPython,
  preparePython,
  pythonBinary,
  verifyPython,
} from "../native-tools";
import { latestPython } from "../versions";
import { pythonConfig } from "./config";
import { junitReport, pythonCoverage, reportText } from "./reports";
export const pythonTestAdapter: TestAdapter = {
  async resolve(_targets, signal) {
    return {
      pytest: await latestPython("pytest", signal),
      "pytest-cov": await latestPython("pytest-cov", signal),
    };
  },
  preflight: preflightPython,
  prepare: preparePython,
  verify: verifyPython,
  async run(context) {
    const config = pythonConfig(context);
    await writeFile(config.rc, config.config);
    const process = await runProcess(
        pythonBinary(context.target),
        config.args,
        {
          cwd: context.target.scope.cwd,
          env: config.env,
          signal: context.signal,
        },
      ),
      result = nativeResult(process);
    await parseEvidence(result, async () => {
      const report = junitReport(
        await reportText(config.report),
        context.target.scope.cwd,
        context.scope.selected,
      );
      result.tests = report.tests;
      result.executed_files = report.executed_files;
      if (process.exit_code === 5 && report.tests.total === 0)
        result.errors = result.errors.filter(
          (e) => e.code !== "native-test-failed",
        );
      classifyResult(
        result,
        report.collectionError || ![0, 1, 5].includes(process.exit_code ?? -1),
      );
    });
    if (process.exit_code === 4)
      result.errors.push({ code: "invalid-config", message: result.stderr });
    if (coverageEnabled(context))
      await parseEvidence(result, async () => {
        result.coverage = pythonCoverage(
          await reportText(config.coverage),
          context.target.scope.cwd,
          context.scope.sources,
        );
      });
    return result;
  },
};
