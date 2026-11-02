import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type TestCase } from "./test-cost-report";
export function costArguments(args: string[]) {
  let cold = false;
  let baseline: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === "--cold" && !cold) {
      cold = true;
    } else if (
      arg === "--baseline" &&
      baseline === undefined &&
      args[index + 1] &&
      !args[index + 1]?.startsWith("--")
    ) {
      baseline = args[++index];
    } else {
      throw new Error("Usage: bun run test:cost [--cold] [--baseline report.json]");
    }
  }
  return { cold, baseline };
}
export function costStores(output: string, cold: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, JUSTOMP_TEST_TIMINGS: resolve(output, "fixture-timings.jsonl") };
  if (cold) {
    for (const [key, folder] of Object.entries({
      npm_config_cache: "npm",
      npm_config_store_dir: "pnpm",
      YARN_CACHE_FOLDER: "yarn",
      BUN_INSTALL_CACHE_DIR: "bun",
      UV_CACHE_DIR: "uv",
      GOCACHE: "go-build",
      GOPATH: "go-path",
    })) {
      env[key] = resolve(output, "cache", folder);
    }
  }
  return env;
}
export function caseCosts(unit: TestCase[], integration: TestCase[]) {
  const files: Record<string, number> = {};
  const groups = { unit: 0, local: 0, native: 0 };
  for (const item of unit) {
    groups.unit += item.seconds;
  }
  for (const item of integration) {
    groups[item.file.endsWith(".native.test.ts") ? "native" : "local"] += item.seconds;
  }
  for (const item of [...unit, ...integration]) {
    files[item.file] = (files[item.file] ?? 0) + item.seconds;
  }
  return { groups, files };
}
export async function fixtureCosts(path: string) {
  const stages: Record<string, { calls: number; seconds: number }> = {};
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return stages;
    }
    throw error;
  }
  for (const line of text.trim().split("\n").filter(Boolean)) {
    const item = JSON.parse(line) as { stage: string; seconds: number };
    if (typeof item.stage !== "string" || !Number.isFinite(item.seconds) || item.seconds < 0) {
      throw new Error("Invalid fixture timing");
    }
    const aggregate = stages[item.stage] ?? { calls: 0, seconds: 0 };
    stages[item.stage] = aggregate;
    aggregate.calls++;
    aggregate.seconds += item.seconds;
  }
  return stages;
}
