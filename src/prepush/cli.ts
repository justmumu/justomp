#!/usr/bin/env bun
import { runPrepush } from "./service";

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Pre-push cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    if (process.argv.length > 2) {
      throw new Error("justomp-prepush takes no arguments; run it inside the repository");
    }
    const result = await runPrepush(process.cwd(), controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    reportResult(result);
    process.exitCode = result.success ? 0 : result.complete ? 1 : 2;
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  await main();
}

function reportResult(result: Awaited<ReturnType<typeof runPrepush>>): void {
  for (const stage of result.stages) {
    console.error(
      `justomp: ${stage.project_id ?? "repository"} ${stage.stage}: ${stage.success ? "passed" : "failed"}`,
    );
  }
  for (const error of result.errors) {
    console.error(`justomp: ${error}`);
  }
}
