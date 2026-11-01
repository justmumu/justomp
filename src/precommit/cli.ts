#!/usr/bin/env bun
import { runPrecommit } from "./service";

const controller = new AbortController();
const cancel = () => controller.abort(new Error("Pre-commit cancelled"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
  if (process.argv.length > 2)
    throw new Error(
      "justomp-precommit takes no arguments; run it inside the repository",
    );
  const result = await runPrecommit(process.cwd(), controller.signal);
  console.log(JSON.stringify(result));
  for (const stage of result.stages)
    console.error(
      `justomp: ${stage.project_id ?? "repository"} ${stage.stage}: ${stage.success ? "passed" : "failed"}`,
    );
  for (const error of result.errors) console.error(`justomp: ${error}`);
  process.exitCode = result.success ? 0 : result.complete ? 1 : 2;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 2;
} finally {
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
}
