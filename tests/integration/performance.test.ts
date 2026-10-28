import { afterEach, expect, test } from "bun:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectProject } from "../../src/inspect/scan";
import {
  closePackagingStructure,
  getPackagingStatus,
  getPackagingStructure,
} from "../../src/packaging/get-structure";
import { createLargeTree } from "../fixtures/generate-large-tree";

const fixtures: Awaited<ReturnType<typeof createLargeTree>>[] = [];
afterEach(async () => {
  await closePackagingStructure();
  for (const fixture of fixtures.splice(0)) await fixture.cleanup();
});
test("generated fixture has real counts and scanner reads only manifests with bounded IO", async () => {
  const fixture = await createLargeTree({
    projects: 5,
    entries: 100,
    excludedEntries: 200,
  });
  fixtures.push(fixture);
  await chmod(join(fixture.root, "project-00000/source-00000.ts"), 0);
  const result = await inspectProject({ root: fixture.root });
  expect(result.complete).toBe(true);
  expect(result.projects).toHaveLength(5);
  expect(result.metrics.manifestReads).toBe(5);
  expect(result.metrics.manifestBytes).toBe(fixture.manifestBytes);
  expect(result.metrics.maxConcurrentIO).toBe(1);
  expect(result.metrics.directoryEntries).toBe(101);
  expect(result.metrics.directories).toBe(6);
  expect(fixture.generatedEntries).toBe(300);
});
test("growing root and nested dependencies changes neither scan IO nor watcher scope", async () => {
  const fixture = await createLargeTree({ projects: 2, entries: 40 });
  fixtures.push(fixture);
  const excluded = [
    "node_modules",
    "venv",
    ".venv",
    "project-00000/node_modules",
    "project-00000/venv",
    "project-00000/.venv",
  ];
  for (const path of excluded)
    await mkdir(join(fixture.root, path), { recursive: true });
  await mkdir(join(fixture.root, ".justomp"));
  const initial = await getPackagingStructure(fixture.root);
  const status = getPackagingStatus(fixture.root);
  expect(status?.healthy).toBe(true);
  for (const path of excluded) {
    await mkdir(join(fixture.root, path, "nested"));
    for (let i = 0; i < 25; i++)
      await writeFile(
        join(fixture.root, path, "nested", `${i}.json`),
        "not a manifest",
      );
    await writeFile(join(fixture.root, path, "nested/package.json"), "{bad");
  }
  await Bun.sleep(100);
  const cached = await getPackagingStructure(fixture.root);
  expect(cached.cacheHit).toBe(true);
  expect(cached.structure.scanId).toBe(initial.structure.scanId);
  const current = getPackagingStatus(fixture.root);
  expect(current?.revision).toBe(status?.revision);
  expect(
    current?.watchedPaths.some((p) =>
      p.split("/").some((s) => ["node_modules", "venv", ".venv"].includes(s)),
    ),
  ).toBe(false);
  const refreshed = await getPackagingStructure(fixture.root, {
    refresh: true,
  });
  expect(refreshed.structure.metrics.directoryEntries).toBe(
    initial.structure.metrics.directoryEntries,
  );
  expect(refreshed.structure.metrics.manifestReads).toBe(2);
  expect(refreshed.structure.metrics.directories).toBe(
    initial.structure.metrics.directories,
  );
});
test("new nested project invalidates the report and closing releases its root registry", async () => {
  const fixture = await createLargeTree({ projects: 10, entries: 200 });
  fixtures.push(fixture);
  const first = await getPackagingStructure(fixture.root);
  const rev = getPackagingStatus(fixture.root)?.revision ?? 0;
  await mkdir(join(fixture.root, "new/nested"), { recursive: true });
  await writeFile(
    join(fixture.root, "new/nested/package.json"),
    '{"name":"new"}',
  );
  for (
    let i = 0;
    i < 200 && (getPackagingStatus(fixture.root)?.revision ?? 0) <= rev;
    i++
  )
    await Bun.sleep(5);
  expect((getPackagingStatus(fixture.root)?.revision ?? 0) > rev).toBe(true);
  const next = await getPackagingStructure(fixture.root);
  expect(next.structure.projects).toHaveLength(11);
  expect(next.structure.scanId).not.toBe(first.structure.scanId);
  expect(
    JSON.parse(
      await readFile(
        join(fixture.root, ".justomp/packaging_structure.json"),
        "utf8",
      ),
    ).scanId,
  ).toBe(next.structure.scanId);
  await closePackagingStructure(fixture.root);
  expect(getPackagingStatus(fixture.root)).toBeUndefined();
});
