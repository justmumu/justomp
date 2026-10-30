import { afterEach, expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { resolveLintTarget } from "../../../src/lint/targets";
import { javascriptFixture } from "../../fixtures/lint/javascript/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
test("pnpm custom modules and lock directories resolve installed local tools without linting generated loaders", async () => {
  const f = await javascriptFixture("pnpm");
  cleanups.push(f.dispose);
  await writeFile(
    join(f.root, "pnpm-workspace.yaml"),
    "packages: []\nmodulesDir: .deps\nvirtualStoreDir: .store\nlockfileDir: .locks\n",
  );
  const previous = f.targets[0];
  if (!previous) throw new Error("missing target");
  f.targets[0] = await resolveLintTarget(
    previous.structure,
    previous.project.project_id,
  );
  await f.prepare();
  const ctx = await f.checkContext();
  expect(await javascriptAdapter.verify(ctx)).toBe(true);
  expect((await javascriptAdapter.check(ctx)).map((c) => c.status)).toEqual([
    "passed",
    "passed",
  ]);
  expect(
    await readFile(join(f.root, ".locks/pnpm-lock.yaml"), "utf8"),
  ).toContain("eslint");
}, 90000);
