import { join } from "node:path";
import { object } from "../../dependencies/inventory";
import { type TestRunContext } from "../adapters";
import { coverageEnabled } from "../native-tools";
/** Escape literal files for native glob includes; no substring selection. */
export function exactGlob(file: string): string {
  return file.replace(/([*?{}()[\]!+@])/g, "\\$1");
}
export function vitestOptions(context: TestRunContext) {
  return {
    root: context.target.scope.cwd,
    dir: context.target.scope.cwd,
    include: context.scope.selected.map(exactGlob),
    exclude: [],
    includeSource: [],
    watch: false,
    retry: 0,
    repeats: 0,
    bail: 0,
    reporters: ["json"],
    outputFile: join(context.artifacts, "vitest.json"),
    passWithNoTests: false,
    testNamePattern: undefined,
    changed: undefined,
    related: undefined,
    shard: undefined,
    coverage: {
      enabled: coverageEnabled(context),
      provider: "v8",
      include: context.scope.sources.map(exactGlob),
      exclude: [],
      reporter: ["json"],
      reportsDirectory: join(context.artifacts, "coverage"),
      reportOnFailure: true,
      thresholds: undefined,
      clean: true,
    },
    typecheck: { enabled: false },
  };
}
/** Stable native Bun policy. Per-run paths and coverage enablement belong to CLI flags. */
export function bunConfig(existing: Record<string, unknown>) {
  const { rerunEach: _rerunEach, coverage: _coverage, ...native } = object(existing.test);
  return {
    ...existing,
    test: {
      ...native,
      root: ".",
      coverageThreshold: 0,
      coverageReporter: ["lcov"],
      coverageSkipTestFiles: true,
      coveragePathIgnorePatterns: [],
      retry: 0,
      bail: 0,
    },
  };
}
export function bunPreload(context: TestRunContext): string {
  return `import {afterAll} from 'bun:test';\nimport {importAllSources} from ${JSON.stringify(new URL("./bun-import-all.ts", import.meta.url).href)};\nimport {writeFile} from 'node:fs/promises';\nafterAll(async()=>{const failures=await importAllSources(${JSON.stringify(context.target.scope.cwd)},${JSON.stringify(context.scope.sources)});await writeFile(${JSON.stringify(join(context.artifacts, "imports.json"))},JSON.stringify(failures));if(failures.length)throw new Error(failures.map(f=>f.file+': '+f.message).join('\\n'));},${Math.max(1, context.remainingMs())});\n`;
}
