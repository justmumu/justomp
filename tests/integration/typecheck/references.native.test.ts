import { afterEach, expect, test } from "bun:test";
import { readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import { resolveJavascriptTypes, withJavascriptTypes } from "../../../src/typecheck/javascript/prepare-types";
import { measureFixture } from "../../fixtures/cost-timing";
import { generatedFixture } from "../../fixtures/typecheck/generated/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});
async function fixture() {
  const f = await generatedFixture();
  cleanups.push(f.dispose);
  for (const [name, dependency] of [
    ["core", null],
    ["ui", "core"],
    ["unrelated", null],
  ] as const) {
    await f.write(`packages/${name}/package.json`, {
      name: `@fixture/${name}`,
      version: "1.0.0",
      type: "module",
      types: "types/index.d.ts",
      ...(dependency ? { dependencies: { [`@fixture/${dependency}`]: "*" } } : {}),
    });
    await f.write(`packages/${name}/tsconfig.json`, {
      compilerOptions: {
        composite: true,
        declaration: true,
        rootDir: "src",
        outDir: "lib",
        declarationDir: "types",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src"],
      ...(dependency ? { references: [{ path: `../${dependency}` }] } : {}),
    });
    await f.write(
      `packages/${name}/src/index.ts`,
      dependency ? `export { value } from "@fixture/${dependency}";\n` : 'export const value: string = "ok";\n',
    );
  }
  await f.write("apps/web/package.json", {
    name: "@fixture/web",
    private: true,
    type: "module",
    dependencies: { "@fixture/ui": "*" },
  });
  await f.write("apps/web/tsconfig.json", {
    compilerOptions: { module: "NodeNext", moduleResolution: "NodeNext" },
    include: ["src"],
    references: [{ path: "../../packages/ui" }],
  });
  await f.write(
    "apps/web/src/index.ts",
    'import { value } from "@fixture/ui";\nexport const result: string = value;\n',
  );
  await f.write(".justomp/config.json", {
    typecheck: {
      javascript: {
        exclude: ["src/extra.js", "src/archive/**"],
        compilerOptions: {
          noCheck: true,
          noEmit: false,
          emitDeclarationOnly: false,
        },
      },
    },
  });
  const config = JSON.parse(await readFile(join(f.root, "packages/core/tsconfig.json"), "utf8"));
  Object.assign(config.compilerOptions, { allowJs: false, checkJs: false });
  await f.write("packages/core/tsconfig.json", config);
  await f.write("packages/core/src/extra.js", "/** @type {number} */\nexport const extra = 42;\n");
  await f.write(
    "packages/core/src/index.ts",
    'export const value: string = "ok";\nexport {extra} from "./extra.js";\n',
  );
  await f.write("packages/core/src/archive/unused.ts", "export const unused: string = 42;\n");
  await f.install();
  const context = await f.ready("javascript:apps/web/package.json");
  return {
    ...f,
    context,
    run: async () => {
      await f.project();
      return withJavascriptTypes(
        f.root,
        "javascript:apps/web/package.json",
        { javascript: javascriptAdapter },
        "prepare",
        (ctx) => measureFixture("typecheck.native-check", () => javascriptAdapter.check(ctx)),
        f.signal,
      );
    },
  };
}
test("native declaration chain emits only required types and preserves earlier effects when its middle fails", async () => {
  const f = await fixture();
  const plan = await resolveJavascriptTypes(f.context.target, f.signal);
  expect(plan.project_ids).toEqual([
    "javascript:apps/web/package.json",
    "javascript:packages/core/package.json",
    "javascript:packages/ui/package.json",
  ]);
  expect(
    plan.declarations.find((step) => step.target.project.project_id === "javascript:packages/core/package.json")
      ?.outputs,
  ).toContain(join(f.root, "packages/core/types/extra.d.ts"));
  const first = await f.run();
  expect(first.preparation.errors).toEqual([]);
  expect(first.ready).toBe(true);
  expect(first.value?.[0]?.status).toBe("passed");
  expect(first.preparation.affected_projects).toEqual([
    "javascript:packages/core/package.json",
    "javascript:packages/ui/package.json",
    "javascript:apps/web/package.json",
  ]);
  expect(first.preparation.changes.every((change) => !change.path.includes("tsconfig.justomp"))).toBe(true);
  expect(await Bun.file(join(f.root, "packages/core/tsconfig.types.json")).exists()).toBe(true);
  const packageMetadata = JSON.parse(await readFile(join(f.root, "packages/core/package.json"), "utf8"));
  expect(packageMetadata.scripts["build:types"]).toBe("tsc --project tsconfig.types.json");
  expect(first.preparation.changes.some((c) => c.path === "packages/core/types/index.d.ts")).toBe(true);
  expect(await Bun.file(join(f.root, "packages/unrelated/types/index.d.ts")).exists()).toBe(false);
  expect(await Bun.file(join(f.root, "packages/core/lib/index.js")).exists()).toBe(false);
  expect(first.preparation.changes).toContainEqual({
    project_id: "javascript:packages/core/package.json",
    path: "packages/core/types/extra.d.ts",
    kind: "created",
  });
  expect(await Bun.file(join(f.root, "packages/core/lib/extra.js")).exists()).toBe(false);
  expect(await Bun.file(join(f.root, "packages/core/types/archive/unused.d.ts")).exists()).toBe(false);
  await unlink(join(f.root, "packages/core/types/index.d.ts"));
  await f.write("packages/ui/src/index.ts", "export const broken: string = 42;\n");
  const failed = await f.run();
  expect(failed.ready).toBe(false);
  expect(failed.value).toBeUndefined();
  expect(failed.preparation.diagnostics).toContainEqual(
    expect.objectContaining({
      project_id: "javascript:packages/ui/package.json",
      rule: "TS2322",
    }),
  );
  expect(failed.preparation.changes).toContainEqual({
    project_id: "javascript:packages/core/package.json",
    path: "packages/core/types/index.d.ts",
    kind: "created",
  });
  expect(await readFile(join(f.root, "packages/core/types/index.d.ts"), "utf8")).toContain("value");
}, 90000);
