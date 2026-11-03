import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gitText } from "../../src/precommit/git";
import { CI_STAGES, type DriftObservation, parseGitStatus, summarizeCi } from "./report";

export async function observeCheckout(root: string, stage: string): Promise<DriftObservation> {
  const [head, status] = await Promise.all([
    gitText(root, ["rev-parse", "HEAD"]),
    gitText(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
  ]);
  return { stage, head: head.trim(), changes: parseGitStatus(status) };
}

async function json(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

async function main(): Promise<void> {
  const temporary = process.env.RUNNER_TEMP;
  if (!temporary) {
    throw new Error("RUNNER_TEMP is required for CI evidence");
  }
  const root = resolve(import.meta.dir, "../.."),
    output = join(temporary, "justomp-ci");
  await mkdir(output, { recursive: true });
  const stage = process.argv[2];
  if (stage === "summary") {
    const baseline = (await json(join(output, "baseline.json"))) as DriftObservation;
    const observations = await Promise.all(
      CI_STAGES.map(async (name) => (await json(join(output, `${name}-drift.json`))) as DriftObservation),
    );
    const outcomes = Object.fromEntries(
      CI_STAGES.map((name) => [name, process.env[`JUSTOMP_CI_${name.toUpperCase()}_OUTCOME`] ?? "missing"]),
    );
    const report = summarizeCi(
      outcomes,
      baseline.head,
      observations,
      await json(join(output, "check.json")),
      await json(join(output, "integration.json")),
    );
    await writeFile(join(output, "summary.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.success ? 0 : 1;
    return;
  }
  if (!stage || !["baseline", ...CI_STAGES].includes(stage)) {
    throw new Error("Expected baseline, install, check, integration or summary");
  }
  const observation = await observeCheckout(root, stage);
  await writeFile(
    join(output, stage === "baseline" ? "baseline.json" : `${stage}-drift.json`),
    `${JSON.stringify(observation, null, 2)}\n`,
  );
  process.stdout.write(`${JSON.stringify(observation, null, 2)}\n`);
  if (observation.changes.length) {
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
