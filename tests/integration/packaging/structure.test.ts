import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closePackagingStructure,
  getPackagingStatus,
  getPackagingStructure,
} from "../../../src/packaging/get-structure";

const roots: string[] = [];
async function fixture() {
  const p = await mkdtemp(join(tmpdir(), "justomp-get-"));
  roots.push(p);
  await writeFile(join(p, "package.json"), '{"name":"initial"}');
  return p;
}
async function changed(root: string, revision: number) {
  for (let i = 0; i < 200; i++) {
    if ((getPackagingStatus(root)?.revision ?? 0) > revision) {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error("watcher event was not delivered");
}
afterEach(async () => {
  for (const p of roots.splice(0)) {
    await closePackagingStructure(p);
    await rm(p, { recursive: true, force: true });
  }
});
test("clean getter reuses immutable report and never loads disk cache", async () => {
  const root = await fixture();
  await mkdir(join(root, ".justomp"));
  await writeFile(
    join(root, ".justomp/packaging_structure.json"),
    JSON.stringify({ schemaVersion: 1, projects: [{ id: ".:javascript" }] }),
  );
  const a = await getPackagingStructure(root);
  const file = join(root, ".justomp/packaging_structure.json");
  expect(a.structure.schemaVersion).toBe(2);
  expect(a.structure.projects[0]?.project_id).toBe("javascript:package.json");
  expect(JSON.parse(await readFile(file, "utf8"))).toEqual(a.structure);
  const stamp = (await stat(file)).mtimeMs;
  const b = await getPackagingStructure(root);
  expect(b.cacheHit).toBe(true);
  expect(b.structure).toBe(a.structure);
  expect(Object.isFrozen(b.structure.projects)).toBe(true);
  expect((await stat(file)).mtimeMs).toBe(stamp);
  expect(await Bun.file(join(root, ".justomp/config.json")).exists()).toBe(false);
});
test("manifest events, nested directory moves and explicit refresh produce new scans", async () => {
  const root = await fixture();
  const a = await getPackagingStructure(root);
  let rev = getPackagingStatus(root)?.revision ?? 0;
  await writeFile(join(root, "package.json"), '{"name":"changed"}');
  await changed(root, rev);
  const b = await getPackagingStructure(root);
  expect(b.structure.projects[0]?.name).toBe("changed");
  expect(b.structure.scanId).not.toBe(a.structure.scanId);
  rev = getPackagingStatus(root)?.revision ?? 0;
  await mkdir(join(root, "staging"));
  await writeFile(join(root, "staging/package.json"), '{"name":"nested"}');
  await rename(join(root, "staging"), join(root, "app"));
  await changed(root, rev);
  const c = await getPackagingStructure(root, { refresh: true });
  expect(c.structure.projects.some((p) => p.path === "app")).toBe(true);
  expect((await getPackagingStructure(root, { refresh: true })).structure.scanId).not.toBe(c.structure.scanId);
});
test("source edits and excluded trees do not dirty or subscribe beneath excluded directories", async () => {
  const root = await fixture();
  await mkdir(join(root, "node_modules/x"), { recursive: true });
  await writeFile(join(root, "node_modules/x/package.json"), "{bad");
  await writeFile(join(root, "index.ts"), "one");
  const a = await getPackagingStructure(root);
  await writeFile(join(root, "index.ts"), "two");
  await writeFile(join(root, "node_modules/x/package.json"), "still bad");
  await Bun.sleep(100);
  expect((await getPackagingStructure(root)).structure.scanId).toBe(a.structure.scanId);
  expect(getPackagingStatus(root)?.watchedPaths.some((p) => p.includes("node_modules"))).toBe(false);
});
test("each getter reads config contents and replaces the watcher when effective rules change", async () => {
  const root = await fixture();
  await mkdir(join(root, ".hidden"));
  await writeFile(join(root, ".hidden/package.json"), '{"name":"hidden"}');
  const a = await getPackagingStructure(root);
  const path = join(root, ".justomp/config.json");
  await writeFile(path, JSON.stringify({ inspection_rules: { exclude: [] } }));
  const b = await getPackagingStructure(root);
  expect(b.structure.projects).toHaveLength(2);
  expect(b.structure.scanId).not.toBe(a.structure.scanId);
  const stamp = await stat(path);
  const text = await readFile(path, "utf8");
  await writeFile(path, text.replace("[]", "[ ]"));
  await utimes(path, stamp.atime, stamp.mtime);
  expect((await getPackagingStructure(root)).cacheHit).toBe(true);
  await writeFile(path, "{");
  await expect(getPackagingStructure(root)).rejects.toThrow();
});
test("malformed manifests fail without returning or replacing the last successful snapshot", async () => {
  const root = await fixture();
  const a = await getPackagingStructure(root);
  const path = join(root, ".justomp/packaging_structure.json");
  const before = await readFile(path, "utf8");
  await writeFile(join(root, "package.json"), "{");
  await expect(getPackagingStructure(root, { refresh: true })).rejects.toThrow("incomplete");
  expect(await readFile(path, "utf8")).toBe(before);
  expect(a.structure.complete).toBe(true);
});
test("concurrent callers share a refresh; one cancellation does not cancel others", async () => {
  const root = await fixture();
  const controller = new AbortController();
  const cancelled = getPackagingStructure(root, { signal: controller.signal });
  const b = getPackagingStructure(root);
  const c = getPackagingStructure(root);
  controller.abort();
  await expect(cancelled).rejects.toThrow();
  const [left, right] = await Promise.all([b, c]);
  expect(left.structure.scanId).toBe(right.structure.scanId);
});
test("output symlink is rejected without overwriting its target", async () => {
  const root = await fixture();
  await mkdir(join(root, ".justomp"));
  await writeFile(join(root, "user.txt"), "keep");
  await symlink(join(root, "user.txt"), join(root, ".justomp/packaging_structure.json"));
  await expect(getPackagingStructure(root)).rejects.toThrow("symlink");
  expect(await readFile(join(root, "user.txt"), "utf8")).toBe("keep");
});
