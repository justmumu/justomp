import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";

const roots: string[] = [];
afterEach(async () => {
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const p = await mkdtemp(join(tmpdir(), "justomp-meta-"));
  roots.push(p);
  return p;
}
test("config equal-size and preserved mtime edit changes scope on next getter", async () => {
  const root = await fixture();
  for (const dir of ["a", "b"]) {
    await mkdir(join(root, dir));
    await writeFile(
      join(root, dir, "package.json"),
      JSON.stringify({ name: dir }),
    );
  }
  await mkdir(join(root, ".justomp"));
  const path = join(root, ".justomp/config.json");
  await writeFile(path, '{"inspection_rules":{"include":["a"]}}');
  const before = await stat(path);
  expect(
    (await getPackagingStructure(root)).structure.projects.map((p) => p.name),
  ).toEqual(["a"]);
  await writeFile(path, '{"inspection_rules":{"include":["b"]}}');
  await utimes(path, before.atime, before.mtime);
  expect((await stat(path)).size).toBe(before.size);
  expect(
    (await getPackagingStructure(root)).structure.projects.map((p) => p.name),
  ).toEqual(["b"]);
});
