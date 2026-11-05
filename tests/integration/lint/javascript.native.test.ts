import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatPrettier, prettierVersion } from "../../../src/format/engines/prettier";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { applyLintFix, pendingLintFix } from "../../../src/lint/fix";
import { cleanups, fixture } from "./javascript-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
for (const manager of ["npm", "yarn-modern"] as const) {
  test(`native ${manager} loads managed Biome and reports readonly lint/format diagnostics`, async () => {
    const f = await fixture(manager, manager === "npm" ? "next" : "js", manager === "npm");
    await f.prepare();
    const ctx = await f.checkContext(manager === "npm" ? 1 : 0);
    const cwd = ctx.target.scope.cwd;
    expect(await javascriptAdapter.verify(ctx)).toBe(true);
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    expect(manifest.devDependencies).toEqual({
      ...(manager === "npm" ? { typescript: "7.0.2" } : {}),
      "@biomejs/biome": "2.6.3",
    });
    expect((await javascriptAdapter.check(ctx)).map((c) => c.status)).toEqual(["passed", "passed"]);
    if (manager === "npm") {
      // Reconcile discovered native configs to the central policy before checking sources.
      const foreign = JSON.stringify({
        root: false,
        formatter: { enabled: true },
        linter: { enabled: false },
      });
      await writeFile(join(f.root, "biome.json"), foreign);
      await writeFile(join(cwd, "biome.json"), foreign);
      await mkdir(join(cwd, "src"));
      await writeFile(join(cwd, "src/biome.jsonc"), foreign);
      const childPath = "packages/a/nested";
      await mkdir(join(f.root, childPath));
      const childManifest = join(childPath, "package.json");
      await writeFile(join(f.root, childManifest), '{"name":"separate-child"}');
      ctx.target.structure.projects.push({
        ...ctx.target.project,
        project_id: `javascript:${childManifest}`,
        path: childPath,
        manifest: childManifest,
      });
      const untouched = "debugger; export let child=1;\n";
      await mkdir(join(cwd, ".private"));
      await writeFile(join(cwd, ".private/archive.ts"), untouched);
      ctx.policy.javascript.exclude = [".private/**"];
      await writeFile(join(f.root, childPath, "child.ts"), untouched);
      await writeFile(join(cwd, "src/values.ts"), "export const a = 1;\nexport const z = 2;\n");
      const source = 'import { z, a } from "./values.js";\nexport const values={z,a};\n';
      await writeFile(join(cwd, "src/index.ts"), source);
      await f.project();
      const metadata = await readFile(join(cwd, "package.json"), "utf8");
      // A shell environment cannot replace the selected managed binary/config.
      ctx.target.scope.env.BIOME_BINARY = "/does-not-exist/foreign-biome";
      ctx.target.scope.env.BIOME_CONFIG_PATH = join(cwd, "biome.json");
      const logTarget = join(cwd, "log-sentinel.txt");
      await writeFile(logTarget, "preserve this file\n");
      ctx.target.scope.env.BIOME_LOG_FILE = logTarget;
      ctx.target.scope.env.BIOME_LOG_LEVEL = "debug";
      const before = await javascriptAdapter.check(ctx);
      expect(await readFile(logTarget, "utf8")).toBe("preserve this file\n");
      expect(before[0]?.diagnostics).toContainEqual(
        expect.objectContaining({
          rule: "assist/source/organizeImports",
          project_path: "src/index.ts",
        }),
      );
      const fix = pendingLintFix("javascript");
      await applyLintFix(ctx, javascriptAdapter, fix);
      expect(fix).toMatchObject({
        status: "completed",
        tool: "biome",
        version: "2.6.3",
        changed_files: ["packages/a/src/index.ts"],
        observation_complete: true,
      });
      expect(await readFile(logTarget, "utf8")).toBe("preserve this file\n");
      expect(await readFile(join(cwd, ".private/archive.ts"), "utf8")).toBe(untouched);
      const fixed = await readFile(join(cwd, "src/index.ts"), "utf8");
      expect(fixed).toContain("import { a, z }");
      expect(fixed).toContain("values={z,a}");
      expect((await javascriptAdapter.check(ctx)).map((c) => c.status)).toEqual(["passed", "failed"]);
      expect(await readFile(join(f.root, childPath, "child.ts"), "utf8")).toBe(untouched);
      expect(await readFile(join(cwd, "package.json"), "utf8")).toBe(metadata);
      expect(JSON.parse(await readFile(join(cwd, "src/biome.jsonc"), "utf8"))).toMatchObject({
        root: false,
        formatter: { enabled: false },
        linter: { enabled: true },
        assist: { enabled: true },
      });
      await writeFile(
        join(cwd, "src/index.ts"),
        await formatPrettier(fixed, "typescript", ctx.policy.javascript.prettier),
      );
    }
    const sourcePath = manager === "npm" ? "src/index.ts" : "index.js";
    await writeFile(join(cwd, sourcePath), "debugger;\nexport const value=1;\n");
    const before = await f.bytes();
    const checks = await javascriptAdapter.check(ctx);
    expect(checks.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(checks[0]).toMatchObject({ tool: "biome", version: "2.6.3" });
    expect(checks[0]?.diagnostics).toContainEqual(
      expect.objectContaining({
        project_path: sourcePath,
        rule: "lint/suspicious/noDebugger",
      }),
    );
    expect(checks[1]?.diagnostics).toContainEqual(expect.objectContaining({ project_path: sourcePath }));
    expect(checks[1]?.version).toBe(prettierVersion);
    expect(await f.bytes()).toEqual(before);
    if (manager === "npm") {
      await unlink(join(f.root, "node_modules/@biomejs/biome/bin/biome"));
      expect(await javascriptAdapter.verify(ctx)).toBe(false);
      expect((await javascriptAdapter.check(ctx))[0]?.status).toBe("not-run");
    }
  }, 180000);
}
