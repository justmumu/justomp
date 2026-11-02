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
export function vitestConfig(context: TestRunContext, userConfig?: string): string {
  const options = JSON.stringify(vitestOptions(context));
  return `import {createRequire} from 'node:module';\nimport {pathToFileURL} from 'node:url';\nconst req=createRequire(${JSON.stringify(join(context.target.scope.cwd, "package.json"))});\nconst vitestReq=createRequire(req.resolve('vitest/package.json'));\nconst {loadConfigFromFile}=await import(pathToFileURL(vitestReq.resolve('vite')).href);\nconst loaded=${userConfig ? `await loadConfigFromFile({command:'serve',mode:'test'},${JSON.stringify(userConfig)},${JSON.stringify(context.target.scope.cwd)})` : "undefined"};\nconst base=loaded?.config??{}; if(base.test) {base.test={...base.test};delete base.test.workspace;delete base.test.projects;}\nexport default {...base,root:${JSON.stringify(context.target.scope.cwd)},test:{...base.test,...${options},testNamePattern:undefined,changed:undefined,related:undefined,shard:undefined}};\n`;
}
export function bunConfig(context: TestRunContext, existing: Record<string, unknown>, preload?: string) {
  const nativeTest = { ...object(existing.test) };
  delete nativeTest.rerunEach;
  const test = {
    ...nativeTest,
    root: context.target.scope.cwd,
    coverage: coverageEnabled(context),
    coverageThreshold: 0,
    coverageReporter: ["lcov"],
    coverageDir: join(context.artifacts, "coverage"),
    coverageSkipTestFiles: true,
    coveragePathIgnorePatterns: [],
    retry: 0,
    bail: 0,
    reporter: { junit: join(context.artifacts, "junit.xml") },
  };
  const preloads = object(existing.test).preload;
  return {
    ...existing,
    test: {
      ...test,
      preload: [
        ...(Array.isArray(preloads) ? preloads : typeof preloads === "string" ? [preloads] : []),
        ...(preload ? [preload] : []),
      ],
    },
  };
}
export function bunPreload(context: TestRunContext): string {
  return `import {afterAll} from 'bun:test';\nimport {importAllSources} from ${JSON.stringify(new URL("./bun-import-all.ts", import.meta.url).href)};\nimport {writeFile} from 'node:fs/promises';\nafterAll(async()=>{const failures=await importAllSources(${JSON.stringify(context.target.scope.cwd)},${JSON.stringify(context.scope.sources)});await writeFile(${JSON.stringify(join(context.artifacts, "imports.json"))},JSON.stringify(failures));if(failures.length)throw new Error(failures.map(f=>f.file+': '+f.message).join('\\n'));},${Math.max(1, context.remainingMs())});\n`;
}
