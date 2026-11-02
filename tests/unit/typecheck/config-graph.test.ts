import { expect, test } from "bun:test";
import { typescriptDiagnostics } from "../../../src/typecheck/adapters/javascript";
import { type TypecheckCheckContext } from "../../../src/typecheck/adapters/types";
import { parseJavascriptConfig } from "../../../src/typecheck/javascript/config-graph";
import { TypecheckError } from "../../../src/typecheck/model";
import { suppliedResponse } from "../../response";

test("JSONC config preserves comments, trailing commas, extends arrays and references", () => {
  expect(
    parseJavascriptConfig(
      '{/* base */ "extends":["./a.json","./b.json",], "references":[{"path":"../lib",},],}',
      "tsconfig.json",
    ),
  ).toEqual({
    extends: ["./a.json", "./b.json"],
    references: [{ path: "../lib" }],
  });
  expect(() => parseJavascriptConfig("[]", "tsconfig.json")).toThrow(TypecheckError);
  expect(() => parseJavascriptConfig('{"bad":', "tsconfig.json")).toThrow(TypecheckError);
});
const context = {
  target: {
    root: "/repo",
    scope: { cwd: "/repo/app" },
    project: { project_id: "javascript:app", path: "app" },
    structure: {
      projects: [
        { project_id: "javascript:root", ecosystem: "javascript", path: "." },
        { project_id: "javascript:app", ecosystem: "javascript", path: "app" },
        { project_id: "python:lib", ecosystem: "python", path: "lib" },
        { project_id: "javascript:lib", ecosystem: "javascript", path: "lib" },
      ],
    },
  },
} as TypecheckCheckContext;
test("native non-pretty multiline diagnostics preserve imported paths and global config errors", () => {
  const result = typescriptDiagnostics(
    context,
    "../lib/index.ts(2,7): error TS2322: Type '{ value: string; }' is not assignable to type 'Expected'.\n  Types of property 'value' are incompatible.\n    Type 'string' is not assignable to type 'number'.\nerror TS6305: Output file '/repo/lib/dist/index.d.ts' has not been built from source file '/repo/lib/index.ts'.\n",
  );
  expect(result).toHaveLength(2);
  expect(result[0]).toMatchObject({
    project_id: "javascript:lib",
    path: "lib/index.ts",
    project_path: "index.ts",
    line: 2,
    column: 7,
    rule: "TS2322",
  });
  expect(result[0]?.message).toContain("\n    Type 'string'");
  expect(result[1]).toMatchObject({
    rule: "TS6305",
    project_id: "javascript:app",
  });
  expect(typescriptDiagnostics(context, "../../outside/file.ts(1,1): error TS2322: bad")[0]).toMatchObject({
    project_id: "javascript:app",
    project_path: "../../outside/file.ts",
  });
  expect(() => typescriptDiagnostics(context, "panic: compiler crashed")).toThrow("Unrecognized");
  expect(() => typescriptDiagnostics(context, "file.ts(1,1): error TS2322: bad\nUnexpected tail")).toThrow(
    "Unrecognized",
  );
});

import { spyOn } from "bun:test";
import { resolveTypecheckConfig } from "../../../src/config/typecheck/resolve";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import { type TypecheckTarget } from "../../../src/typecheck/targets";

test("one bounded dist-tag query selects the common exact stable TypeScript release", async () => {
  const urls: string[] = [];
  const original = globalThis.fetch;
  const fetcher = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        return suppliedResponse(() => {
          expect(new Headers(init?.headers).get("accept")).toBe("application/json");
          urls.push(String(url));
          return Response.json({ latest: "7.0.2", next: "8.0.0-dev.1" });
        });
      },
      { preconnect: original.preconnect },
    ),
  );
  try {
    const targets = ["javascript:.", "javascript:packages/ui"].map((project_id) => ({
      project: { project_id },
    })) as TypecheckTarget[];
    const versions = await javascriptAdapter.resolve(
      targets,
      resolveTypecheckConfig().policy,
      new AbortController().signal,
    );
    expect(versions).toEqual({
      "javascript:.": { typescript: "7.0.2" },
      "javascript:packages/ui": { typescript: "7.0.2" },
    });
    expect(urls).toEqual(["https://registry.npmjs.org/-/package/typescript/dist-tags"]);
  } finally {
    fetcher.mockRestore();
  }
});

test("checkout directory names do not select an uncovered test's compiler context", async () => {
  const { javascriptCheckContexts } = await import("../../../src/typecheck/javascript/config-graph");
  const cwd = "/checkouts/specimen/app";
  const target = {
    scope: { cwd },
    project: { project_id: "javascript:app" },
  } as TypecheckTarget;
  const node = (name: string, files: string[]) => ({
    path: `${cwd}/${name}`,
    project_id: "javascript:app",
    raw: {},
    compilerOptions: {},
    files,
    references: [],
    inherited: [],
  });
  const app = node("tsconfig.app.json", [`${cwd}/src/main.ts`]);
  const tests = node("tsconfig.test.json", []);
  const contexts = javascriptCheckContexts(target, {
    nodes: [app, tests],
    roots: [app.path, tests.path],
    scope: {
      files: ["src/main.ts", "tests/extra.ts"],
      packages: [],
      childRoots: [],
      ignores: [],
      hasTypescript: true,
      empty: false,
    },
  });
  expect(contexts.find((context) => context.node?.path === tests.path)?.files).toEqual([`${cwd}/tests/extra.ts`]);
  expect(contexts.find((context) => context.node?.path === app.path)?.files).toEqual([`${cwd}/src/main.ts`]);
});
