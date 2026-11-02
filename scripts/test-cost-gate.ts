import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { readManagedGateReports } from "./test-cost-report";
import { runCostStage } from "./test-cost-runner";

export async function measureGate(root: string, output: string, env: NodeJS.ProcessEnv) {
  const stages: { name: string; exit_code: number; seconds: number }[] = [];
  let gate: ReturnType<typeof readManagedGateReports> | undefined;
  let error: string | undefined;
  const began = performance.now();
  try {
    for (const name of ["check", "integration"] as const) {
      const stage = await runCostStage(
        [
          process.execPath,
          resolve(root, "scripts/development.ts"),
          name,
          "--report",
          resolve(output, `${name}.json`),
          ...(name === "integration" ? ["--timeout-seconds", "1800"] : []),
        ],
        root,
        env,
        resolve(output, `${name}.log`),
      );
      stages.push({ name, ...stage });
      process.stdout.write(`${name}: exit ${stage.exit_code}, ${stage.seconds.toFixed(2)}s\n`);
      if (stage.exit_code !== 0) {
        break;
      }
    }
    const [check, integration] = await Promise.all(
      ["check", "integration"].map(
        async (name) => JSON.parse(await readFile(resolve(output, `${name}.json`), "utf8")) as unknown,
      ),
    );
    gate = readManagedGateReports(check, integration);
  } catch (failure) {
    error = failure instanceof Error ? failure.message : String(failure);
  }
  return { stages, gate, error, seconds: (performance.now() - began) / 1000 };
}
