#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { checkProjectLint, lintFailure } from "./service";

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Lint check cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: { root: { type: "string" }, "project-id": { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (!values.root || !values["project-id"]) {
      throw new Error(
        "Usage: justomp-lint --root <directory> --project-id <id> (check-only; prepare explicitly first)",
      );
    }
    const result = await checkProjectLint(values.root, values["project-id"], controller.signal);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.success ? 0 : result.complete ? 1 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(lintFailure(error, controller.signal))}\n`);
    process.exitCode = 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  await main();
}
