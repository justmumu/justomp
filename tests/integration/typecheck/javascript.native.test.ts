import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { javascriptAdapter } from "../../../src/typecheck/adapters/javascript";
import {
  javascriptFixture,
  type Manager,
  TYPESCRIPT,
} from "../../fixtures/typecheck/javascript/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const clean of cleanups.splice(0).reverse()) await clean();
});
async function fixture(manager: Manager = "npm") {
  const f = await javascriptFixture(manager);
  cleanups.push(f.dispose);
  return f;
}
test("native TypeScript exact upgrade consumes managed source/test policy and preserves build configuration", async () => {
  const f = await fixture();
  await mkdir(join(f.root, "tests"));
  const base =
    '{ // JSONC base\n "compilerOptions": {"module":"ESNext", "moduleResolution":"Bundler", "strict":false, "noImplicitAny":false, "declaration":true, "rootDir":"src", "outDir":"dist",},}';
  const config =
    '{"extends":"./base.json", "include":["index.js"], "exclude":["tests"]}';
  await writeFile(join(f.root, "base.json"), base);
  await writeFile(join(f.root, "tsconfig.json"), config);
  await writeFile(
    join(f.root, "tests/cases.ts"),
    "export const value: number = 1;\n",
  );
  for (const version of ["5.9.3", TYPESCRIPT]) {
    f.context.versions["javascript:."] = { typescript: version };
    await f.prepare();
    expect(
      JSON.parse(await readFile(join(f.root, "package.json"), "utf8"))
        .devDependencies.typescript,
    ).toBe(version);
  }
  const ctx = await f.checkContext();
  expect(await javascriptAdapter.verifyTools(ctx)).toBe(true);
  expect((await javascriptAdapter.check(ctx))[0]?.status).toBe("passed");
  await writeFile(
    join(f.root, "tests/cases.ts"),
    "export function implicit(value) { return value; }\n",
  );
  await writeFile(
    join(f.root, "index.js"),
    "/** @param {string} value */\nexport function greet(value) { return value; }\ngreet(42);\n",
  );
  const before = await f.bytes();
  const check = (await javascriptAdapter.check(await f.checkContext()))[0];
  expect(check?.status).toBe("failed");
  expect(check?.diagnostics).toContainEqual(
    expect.objectContaining({ project_path: "tests/cases.ts", rule: "TS7006" }),
  );
  expect(check?.diagnostics).toContainEqual(
    expect.objectContaining({ project_path: "index.js", rule: "TS2345" }),
  );
  expect(await f.bytes()).toEqual(before);
  expect(await readFile(join(f.root, "tsconfig.json"), "utf8")).toBe(config);
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
  expect(
    (await javascriptAdapter.check(await f.checkContext()))[0],
  ).toMatchObject({ status: "passed", diagnostics: [] });
}, 90000);
