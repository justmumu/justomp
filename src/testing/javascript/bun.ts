import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "../../dependencies/runner";
import { type TestAdapter, type TestToolContext } from "../adapters";
import { TestError } from "../model";
import { classifyResult, coverageEnabled, nativeResult, parseEvidence, requireNative } from "../native-tools";
import { junitReport, lcovReport, reportText } from "../python/reports";
import { stableVersion } from "../versions";
import { bunPreload } from "./config";

async function runtime(context: Pick<TestToolContext, "target" | "signal">) {
  const command = Bun.which("bun", {
    ...(context.target.scope.env.PATH !== undefined ? { PATH: context.target.scope.env.PATH } : {}),
    cwd: context.target.scope.cwd,
  });
  if (!command) {
    throw new TestError("runtime-unavailable", "Bun is not installed");
  }
  const result = await runProcess(command, ["--version"], {
    cwd: context.target.scope.cwd,
    env: context.target.scope.env,
    signal: context.signal,
  });
  requireNative(result, "Read Bun version");
  return { command, version: stableVersion(result.stdout.trim()) };
}
export const bunTestAdapter: TestAdapter = {
  async resolve(targets, signal) {
    const target = targets[0];
    if (!target) {
      throw new TestError("project-not-found", "No Bun project");
    }
    return { bun: (await runtime({ target, signal })).version };
  },
  async preflight(context) {
    if ((await runtime(context)).version !== context.tools.bun) {
      throw new TestError("runtime-conflict", "Bun version changed during preparation");
    }
  },
  async verify(context) {
    try {
      return (await runtime(context)).version === context.tools.bun;
    } catch {
      context.signal.throwIfAborted();
      return false;
    }
  },
  prepare() {
    return Promise.resolve();
  },
  async run(context) {
    const enabled = coverageEnabled(context),
      preload = enabled ? join(context.artifacts, "coverage-preload.ts") : undefined;
    if (preload) {
      await writeFile(preload, bunPreload(context));
    }
    const config = context.target.configFile ?? join(context.target.scope.cwd, "bunfig.toml");
    const { command } = await runtime(context),
      process = await runProcess(
        command,
        [
          "test",
          `--config=${config}`,
          "--retry=0",
          ...(enabled
            ? ["--coverage", "--coverage-reporter=lcov", `--coverage-dir=${join(context.artifacts, "coverage")}`]
            : []),
          ...(preload ? ["--preload", preload] : []),
          "--reporter=junit",
          `--reporter-outfile=${join(context.artifacts, "junit.xml")}`,
          ...context.scope.selected.map((file) => `./${file}`),
        ],
        {
          cwd: context.target.scope.cwd,
          env: context.target.scope.env,
          signal: context.signal,
        },
      ),
      result = nativeResult(process);
    await parseEvidence(result, async () => {
      const report = junitReport(
        await reportText(join(context.artifacts, "junit.xml")),
        context.target.scope.cwd,
        context.scope.selected,
      );
      result.tests = report.tests;
      result.executed_files = report.executed_files;
      classifyResult(result, report.collectionError);
    });
    if (enabled) {
      await parseEvidence(result, async () => {
        const failures: unknown = JSON.parse(await reportText(join(context.artifacts, "imports.json")));
        if (!Array.isArray(failures)) {
          throw new TestError("invalid-report", "Invalid source import report");
        }
        if (failures.length) {
          throw new TestError("coverage-import-failed", JSON.stringify(failures));
        }
        result.coverage = lcovReport(
          await reportText(join(context.artifacts, "coverage/lcov.info")),
          context.target.scope.cwd,
          context.scope.sources,
        );
      });
    }
    return result;
  },
};
