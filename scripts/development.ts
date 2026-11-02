import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { closePackagingStructure } from "../src/packaging/get-structure";
import { parseDevelopmentArgs, runDevelopment } from "./development/command";

async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Repository command cancelled"));
  process.on("SIGINT", abort);
  process.on("SIGTERM", abort);
  try {
    const command = parseDevelopmentArgs(process.argv.slice(2));
    const result = await runDevelopment(root, command, controller.signal);
    const text = `${JSON.stringify(result, null, 2)}\n`;
    if (command.report) {
      await writeFile(resolve(command.report), text);
    }
    process.stdout.write(text);
    process.exitCode = result.success && result.complete && !result.cancelled ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", abort);
    process.off("SIGTERM", abort);
    await closePackagingStructure(root);
  }
}
if (import.meta.main) {
  await main();
}
