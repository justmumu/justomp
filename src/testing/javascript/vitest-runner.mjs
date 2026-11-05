import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Load the selected project's public API through its package-manager environment.
 * @param {string} request
 */
export async function runVitest(request) {
  /** @type {{root: string, config: string, options: Record<string, unknown>}} */
  const payload = JSON.parse(await readFile(request, "utf8"));
  const req = createRequire(join(payload.root, "package.json"));
  const { startVitest } = await import(pathToFileURL(req.resolve("vitest/node")).href);
  const invocation = {
    name: "justomp-test-invocation",
    enforce: "post",
    /** @param {{test?: Record<string, unknown>}} config */
    config(config) {
      // Replace selection arrays after native config loading; Vite's normal merge concatenates them.
      const { projects: _projects, workspace: _workspace, ...native } = config.test ?? {};
      config.test = {
        ...native,
        ...payload.options,
        testNamePattern: undefined,
        changed: undefined,
        related: undefined,
        shard: undefined,
      };
    },
  };
  const instance = await startVitest(
    "test",
    [],
    { root: payload.root, config: payload.config, run: true, watch: false },
    { plugins: [invocation] },
  );
  await instance.close();
}
