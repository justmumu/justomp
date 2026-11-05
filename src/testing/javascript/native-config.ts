import { join } from "node:path";
import { readProjectionFile } from "../../lint/files";
import { type TestTarget } from "../targets";

export const VITEST_CONFIG_NAMES = ["vitest", "vite"].flatMap((base) =>
  ["ts", "mts", "cts", "js", "mjs", "cjs"].map((extension) => `${base}.config.${extension}`),
);
/** Native Vitest precedence; inaccessible existing files fail instead of silently selecting another. */
export async function findVitestConfig(target: TestTarget): Promise<string> {
  if (target.configFile) {
    return target.configFile;
  }
  for (const name of VITEST_CONFIG_NAMES) {
    const path = join(target.scope.cwd, name);
    if ((await readProjectionFile(target.root, path)).text !== null) {
      return path;
    }
  }
  return join(target.scope.cwd, "vitest.config.ts");
}
