import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { localTool } from "../../lint/javascript/native";
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
import { vitestConfig } from "./config";
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
    const userConfig = await findUserConfig(context.target);
    const config = join(context.artifacts, "vitest.config.mjs");
    await writeFile(config, vitestConfig(context, userConfig));
    const native = await lintManagerContext(context.target, context.signal),
      process = await localTool(
        context.target,
        native,
        { package: "vitest", binary: "vitest" },
        ["run", "--config", config],
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

async function findUserConfig(target: import("../targets").TestTarget): Promise<string | undefined> {
  let userConfig = target.configFile;
  for (const base of ["vitest", "vite"]) {
    if (userConfig) {
      break;
    }
    for (const extension of ["ts", "mts", "cts", "js", "mjs", "cjs"]) {
      const path = join(target.scope.cwd, `${base}.config.${extension}`);
      try {
        await access(path);
        userConfig = path;
        break;
      } catch {
        /* Missing or inaccessible candidates do not select a native config. */
      }
    }
    if (userConfig) {
      break;
    }
  }
  return userConfig;
}
