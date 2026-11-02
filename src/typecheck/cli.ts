#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { checkProjectTypecheck, typecheckFailure, typecheckProject } from "./service";

async function main(): Promise<void> {
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("Typecheck cancelled"));
  process.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    const { values } = parseArgs({
      args: process.argv.slice(2),
      options: {
        root: { type: "string" },
        "project-id": { type: "string" },
        "check-only": { type: "boolean", default: false },
      },
      strict: true,
      allowPositionals: false,
    });
    if (!values.root || !values["project-id"]) {
      throw new Error("Usage: justomp-typecheck --root <directory> --project-id <id> [--check-only]");
    }
    const result = await (values["check-only"] ? checkProjectTypecheck : typecheckProject)(
      values.root,
      values["project-id"],
      controller.signal,
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
    process.exitCode = result.success ? 0 : result.complete ? 1 : 2;
  } catch (error) {
    process.stdout.write(`${JSON.stringify(typecheckFailure(error, controller.signal))}\n`);
    process.exitCode = 2;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (import.meta.main) {
  await main();
}
