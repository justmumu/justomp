import { afterEach, expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { javascriptAdapter } from "../../../src/lint/adapters/javascript";
import { resolveLintTarget } from "../../../src/lint/targets";
import { javascriptFixture } from "../../fixtures/lint/javascript/fixture";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});
test("bundled Biome respects custom pnpm dependency roots without installing tools or changing the lock", async () => {
  const f = await javascriptFixture("pnpm");
  cleanups.push(f.dispose);
  await writeFile(
    join(f.root, "pnpm-workspace.yaml"),
    "packages: []\nmodulesDir: .deps\nvirtualStoreDir: .store\nlockfileDir: .locks\n",
  );
  await mkdir(join(f.root, ".deps/package"), { recursive: true });
  await mkdir(join(f.root, ".locks/.store/package"), { recursive: true });
  await mkdir(join(f.root, ".locks"), { recursive: true });
  await writeFile(join(f.root, ".deps/package/index.js"), "debugger;\n");
  await writeFile(join(f.root, ".locks/.store/package/index.js"), "debugger;\n");
  const lockPath = join(f.root, ".locks/pnpm-lock.yaml");
  const lock = "lockfileVersion: '9.0'\nsettings:\n  autoInstallPeers: true\n";
  await writeFile(lockPath, lock);
  const manifest = await readFile(join(f.root, "package.json"), "utf8");
  const previous = f.targets[0];
  if (!previous) {
    throw new Error("missing target");
  }
  f.targets[0] = await resolveLintTarget(previous.structure, previous.project.project_id);
  f.targets[0].scope.env.PATH = "";
  await f.prepare();
  const ctx = await f.checkContext();
  expect(await javascriptAdapter.verify(ctx)).toBe(true);
  expect((await javascriptAdapter.check(ctx)).map((c) => c.status)).toEqual(["passed", "passed"]);
  expect(await readFile(lockPath, "utf8")).toBe(lock);
  expect(await readFile(join(f.root, "package.json"), "utf8")).toBe(manifest);
}, 90000);
