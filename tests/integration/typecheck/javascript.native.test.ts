import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { object } from "../../../src/dependencies/inventory";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import { typescriptRun } from "../../../src/typecheck/javascript/native";
import { javascriptFixture, type Manager, TYPESCRIPT } from "../../fixtures/typecheck/javascript/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) {
    await clean();
  }
});
async function fixture(manager: Manager = "npm") {
  const f = await javascriptFixture(manager);
  cleanups.push(f.dispose);
  return f;
}
test("native TypeScript exact upgrade consumes managed source/test policy and preserves build configuration", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "tests"));
  await mkdir(join(f.root, "src"));
  await writeFile(join(f.root, "src/index.ts"), 'export const production: string = "ready";\n');
  await mkdir(join(f.root, ".private"));
  await writeFile(join(f.root, ".private/archive.ts"), 'export const archived: number = "wrong";\n');
  f.context.policy.javascript.exclude = [".private/**"];
  const base =
    '{ // JSONC base\n "compilerOptions": {"module":"ESNext", "moduleResolution":"Bundler", "strict":false, "noImplicitAny":false, "declaration":true, "composite":true, "rootDir":"src", "outDir":"dist",},}';
  const config = '{"extends":"./base.json", "include":["src"], "exclude":["tests"]}';
  await writeFile(join(f.root, "base.json"), base);
  await writeFile(join(f.root, "tsconfig.app.json"), config);
  await writeFile(join(f.root, "tsconfig.json"), '{"files":[],"references":[{"path":"./tsconfig.app.json"}]}');
  const manifestPath = join(f.root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.scripts = { build: "tsc -b" };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(join(f.root, "tests/cases.ts"), "export const value: number = 1;\n");
  for (const version of ["5.9.3", TYPESCRIPT]) {
    f.context.versions["javascript:."] = { typescript: version };
    await f.prepare();
    expect(JSON.parse(await readFile(join(f.root, "package.json"), "utf8")).devDependencies.typescript).toBe(version);
  }
  const ctx = await f.checkContext();
  expect(await javascriptAdapter.verifyTools(ctx)).toBe(true);
  expect((await javascriptAdapter.check(ctx))[0]?.status).toBe("passed");
  const build = await typescriptRun(
    ctx.target,
    ["--build", join(f.root, "tsconfig.build.json"), "--pretty", "false"],
    ctx.signal,
  );
  expect(build.exit_code, build.stdout + build.stderr).toBe(0);
  expect(await Bun.file(join(f.root, "dist/index.js")).exists()).toBe(true);
  expect(await Bun.file(join(f.root, "dist/index.d.ts")).exists()).toBe(true);
  expect(await Bun.file(join(f.root, "dist/tests/cases.js")).exists()).toBe(false);
  await writeFile(join(f.root, "tests/cases.ts"), "export function implicit(value) { return value; }\n");
  await writeFile(
    join(f.root, "index.js"),
    "/** @param {string} value */\nexport function greet(value) { return value; }\ngreet(42);\n",
  );
  const before = await f.bytes();
  const check = (await javascriptAdapter.check(await f.checkContext()))[0];
  expect(check?.status).toBe("failed");
  expect(check?.diagnostics.some((diagnostic) => diagnostic.project_path === ".private/archive.ts")).toBe(false);
  expect(check?.diagnostics).toContainEqual(
    expect.objectContaining({ project_path: "tests/cases.ts", rule: "TS7006" }),
  );
  expect(check?.diagnostics).toContainEqual(expect.objectContaining({ project_path: "index.js", rule: "TS2345" }));
  expect(await f.bytes()).toEqual(before);
  const nativeCheck = object(Bun.JSONC.parse(await readFile(join(f.root, "tsconfig.app.json"), "utf8")));
  expect(nativeCheck.extends).toBe("./tsconfig.app.build.json");
  expect(nativeCheck.files).toContain("./tests/cases.ts");
  const nativeBuild = object(Bun.JSONC.parse(await readFile(join(f.root, "tsconfig.app.build.json"), "utf8")));
  expect(nativeBuild.extends).toBe("./base.json");
  expect(nativeBuild.include).toEqual(["src"]);
  expect(nativeBuild.exclude).toEqual(["tests"]);
  const solutionBuild = object(Bun.JSONC.parse(await readFile(join(f.root, "tsconfig.build.json"), "utf8")));
  expect(solutionBuild.references).toEqual([{ path: "./tsconfig.app.build.json" }]);
  expect(JSON.parse(await readFile(manifestPath, "utf8")).scripts.build).toBe("tsc -b tsconfig.build.json");
  expect(await Bun.file(join(f.root, "tsconfig.justomp.0.json")).exists()).toBe(false);
  expect(await readFile(join(f.root, "base.json"), "utf8")).toBe(base);
}, 90000);
test("modern Yarn PnP resolves package configs and imports through the managed checker", async () => {
  const f = await fixture("yarn-modern");
  const manifestPath = join(f.root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.devDependencies = {
    "@tsconfig/node22": "22.0.6",
    csstype: "3.1.3",
    "@types/node": "22.15.30",
  };
  await writeFile(manifestPath, JSON.stringify(manifest));
  await writeFile(
    join(f.root, "index.ts"),
    'import type { Properties } from "csstype";\nexport const style: Properties = {color:"red"};\n',
  );
  await writeFile(
    join(f.root, "tsconfig.json"),
    '{"extends":"@tsconfig/node22/tsconfig.json","include":["*.ts","*.js"]}',
  );
  f.context.versions["javascript:."] = { typescript: "5.9.3" };
  await f.prepare();
  expect((await javascriptAdapter.check(await f.checkContext()))[0]).toMatchObject({
    status: "passed",
    diagnostics: [],
  });
}, 90000);
