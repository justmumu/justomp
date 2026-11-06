import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { formatPrettier, prettierVersion } from "../../../src/format/engines/prettier";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { applyLintFix, pendingLintFix } from "../../../src/lint/fix";
import { BIOME_VERSION } from "../../../src/lint/toolchain";
import { cleanups, fixture } from "./javascript-fixture";

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
for (const manager of ["npm", "yarn-modern"] as const) {
  const sourcePath = manager === "npm" ? "src/index.ts" : "index.js";
  test(`bundled Biome preserves ${manager === "npm" ? "node_modules workspace" : "PnP loader"} source ownership and readonly diagnostics`, async () => {
    const f = await fixture(manager, manager === "npm" ? "next" : "js", manager === "npm");
    const manifestPath = join(f.root, "package.json");
    const original = JSON.parse(await readFile(manifestPath, "utf8"));
    original.dependencies = { "@biomejs/biome": "1.9.4" };
    original.scripts = { lint: "biome check ." };
    await writeFile(manifestPath, JSON.stringify(original));
    const foreignBinary = join(f.root, "node_modules/@biomejs/biome/bin/biome");
    if (manager === "npm") {
      await mkdir(join(f.root, "node_modules/@biomejs/biome/bin"), { recursive: true });
      await writeFile(foreignBinary, "#!/bin/sh\nexit 79\n", { mode: 0o755 });
      await writeFile(
        join(f.root, "node_modules/@biomejs/biome/package.json"),
        JSON.stringify({ name: "@biomejs/biome", version: "1.9.4", bin: { biome: "bin/biome" } }),
      );
      await writeFile(join(f.root, "node_modules/@biomejs/biome/generated.js"), "debugger;\n");
      await mkdir(join(f.root, "packages/a/node_modules/application"), { recursive: true });
      await writeFile(join(f.root, "packages/a/node_modules/application/generated.js"), "debugger;\n");
    } else {
      await mkdir(join(f.root, ".yarn/cache"), { recursive: true });
      await writeFile(join(f.root, ".pnp.cjs"), "debugger;\n");
      await writeFile(join(f.root, ".pnp.loader.mjs"), "debugger;\n");
      await writeFile(join(f.root, ".yarn/cache/generated.js"), "debugger;\n");
    }
    const manifestBefore = await readFile(manifestPath, "utf8");
    const lockPath = join(f.root, manager === "npm" ? "package-lock.json" : "yarn.lock");
    const lock = manager === "npm" ? '{"lockfileVersion":3,"packages":{}}\n' : "# Existing project lock\n";
    await writeFile(lockPath, lock);
    for (const target of f.targets) {
      target.scope.env.PATH = "";
    }
    await f.prepare();
    const ctx = await f.checkContext(manager === "npm" ? 1 : 0);
    const cwd = ctx.target.scope.cwd;
    expect(await javascriptAdapter.verify(ctx)).toBe(true);
    const manifest = JSON.parse(await readFile(join(cwd, "package.json"), "utf8"));
    expect(manifest.devDependencies).toEqual(manager === "npm" ? { typescript: "7.0.2" } : undefined);
    expect(await readFile(manifestPath, "utf8")).toBe(manifestBefore);
    expect(await readFile(lockPath, "utf8")).toBe(lock);
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
        version: BIOME_VERSION,
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
    await writeFile(join(cwd, sourcePath), "debugger;\nexport const value=1;\n");
    const before = await f.bytes();
    const checks = await javascriptAdapter.check(ctx);
    expect(checks.map((c) => c.status)).toEqual(["failed", "failed"]);
    expect(checks[0]).toMatchObject({ tool: "biome", version: BIOME_VERSION });
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
      await unlink(foreignBinary);
      expect(await javascriptAdapter.verify(ctx)).toBe(true);
      expect((await javascriptAdapter.check(ctx))[0]?.status).toBe("failed");
    }
  }, 180000);
}
