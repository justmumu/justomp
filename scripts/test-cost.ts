import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { WORKLOAD } from "./development/receipt";
import { caseCosts, costArguments, costStores, fixtureCosts } from "./test-cost-analysis";
import { costEnvironment } from "./test-cost-environment";
import { measureGate } from "./test-cost-gate";
import { compareBaseline, evaluateCost, WARM_BUDGET_SECONDS } from "./test-cost-report";

async function main(): Promise<void> {
  const { cold, baseline } = costArguments(process.argv.slice(2));
  const root = resolve(import.meta.dir, "..");
  const output = resolve(root, ".private/test-cost", new Date().toISOString().replaceAll(":", "-"));
  await mkdir(output, { recursive: true });
  const environment = await costEnvironment(root);
  const previous: unknown = baseline ? JSON.parse(await readFile(resolve(baseline), "utf8")) : undefined;
  const measurement = await measureGate(root, output, costStores(output, cold));
  const { gate, stages, seconds, error } = measurement;
  const emptyCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  const evidence = gate ?? {
    counts: emptyCounts,
    unit: { counts: emptyCounts, cases: [] },
    integration: { counts: emptyCounts, cases: [] },
    coverage: null,
  };
  const effectiveEnvironment = { ...environment, managed_tools: gate?.managed_tools ?? null };
  const comparison = compareBaseline(previous, effectiveEnvironment);
  const baselineSeconds = comparison.seconds;
  const counts = evidence.counts;
  const result = evaluateCost(
    seconds,
    counts,
    stages.map((stage) => stage.exit_code),
    baselineSeconds,
  );
  const report = {
    version: 2,
    workload: WORKLOAD,
    ...caseCosts(evidence.unit.cases, evidence.integration.cases),
    fixtureStages: await fixtureCosts(resolve(output, "fixture-timings.jsonl")),
    ...result,
    seconds,
    cache: cold ? "cold" : "warm",
    environment: effectiveEnvironment,
    stages,
    counts,
    unit_counts: evidence.unit.counts,
    integration_counts: evidence.integration.counts,
    coverage: evidence.coverage,
    comparison: comparison.kind,
    comparison_error: comparison.error,
    budget_seconds: WARM_BUDGET_SECONDS,
    error,
  };
  const path = resolve(output, "report.json");
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${path}\nTotal ${seconds.toFixed(2)}s; complete=${result.complete}; warm budget=${result.budget_met}; reduction=${result.reduction === null ? "unmeasured" : `${(result.reduction * 100).toFixed(1)}%`}\n`,
  );
  process.exitCode =
    result.complete &&
    !comparison.error &&
    (cold || (result.budget_met && (baselineSeconds === undefined || result.reduction_met)))
      ? 0
      : 1;
}
if (import.meta.main) {
  await main();
}
