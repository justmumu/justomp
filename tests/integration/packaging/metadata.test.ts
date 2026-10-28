import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { DEFAULT_RULES } from "../../../src/config/defaults";
import {
  closePackagingStructure,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";
import { StructureWatcher } from "../../../src/packaging/watcher";

const roots: string[] = [];
afterEach(async () => {
  mock.restore();
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const p = await mkdtemp(join(tmpdir(), "justomp-meta-"));
  roots.push(p);
  return p;
}
test("atime-only native events do not invalidate, content metadata events do", async () => {
  const root = await fixture();
  const path = join(root, "package.json");
  await writeFile(path, "{}");
  const base = await stat(path);
  let native: FSWatcher | undefined;
  const add = FSWatcher.prototype.add;
  spyOn(FSWatcher.prototype, "add").mockImplementation(function (
    this: FSWatcher,
    paths,
  ) {
    native = this;
    return add.call(this, paths);
  });
  const watcher = new StructureWatcher(root, DEFAULT_RULES);
  try {
    await watcher.start(new AbortController().signal);
    const revision = watcher.revision;
    if (!native) throw new Error("native watcher absent");
    native.emit(
      "all",
      "change",
      path,
      Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
        atimeMs: base.atimeMs + 1000,
      }),
    );
    expect(watcher.revision).toBe(revision);
    native.emit(
      "all",
      "change",
      path,
      Object.assign(Object.create(Object.getPrototypeOf(base)), base, {
        mtimeMs: base.mtimeMs + 1000,
      }),
    );
    expect(watcher.revision).toBe(revision + 1);
  } finally {
    await watcher.close();
  }
});
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
