import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { nodeRun } from "../../lint/javascript/native";
import { lintManagerContext } from "../../lint/runtime";
import { type TestAdapter } from "../adapters";
import {
  classifyResult,
  coverageEnabled,
  nativeResult,
  parseEvidence,
  preflightJavascript,
  prepareJavascript,
  verifyJavascript,
} from "../native-tools";
import { reportText } from "../python/reports";
import { latestNpm } from "../versions";
import { vitestOptions } from "./config";
import { findVitestConfig } from "./native-config";
import { vitestCoverage, vitestReport } from "./reports";
export const vitestTestAdapter: TestAdapter = {
  async resolve(_targets, signal) {
    const version = await latestNpm("vitest", signal);
    return { vitest: version, "@vitest/coverage-v8": version };
  },
  preflight: preflightJavascript,
  prepare: prepareJavascript,
  verify: verifyJavascript,
  async run(context) {
    const config = await findVitestConfig(context.target);
    const request = join(context.artifacts, "vitest-request.json");
    await writeFile(
      request,
      JSON.stringify({ root: context.target.scope.cwd, config, options: vitestOptions(context) }),
    );
    const native = await lintManagerContext(context.target, context.signal),
      process = await nodeRun(
        context.target,
        native,
        [
          "--input-type=module",
          "-e",
          "const {runVitest}=await import(process.argv[1]);await runVitest(process.argv[2]);",
          new URL("./vitest-runner.mjs", import.meta.url).href,
          request,
        ],
        context.signal,
      ),
      result = nativeResult(process);
    await parseEvidence(result, async () => {
      const report = vitestReport(
        await reportText(join(context.artifacts, "vitest.json")),
        context.target.scope.cwd,
        context.scope.selected,
      );
      result.tests = report.tests;
      result.executed_files = report.executed_files;
      classifyResult(result, report.collectionError);
    });
    if (coverageEnabled(context)) {
      await parseEvidence(result, async () => {
        result.coverage = vitestCoverage(
          await reportText(join(context.artifacts, "coverage/coverage-final.json")),
          context.target.scope.cwd,
          context.scope.sources,
        );
      });
    }
    return result;
  },
};
