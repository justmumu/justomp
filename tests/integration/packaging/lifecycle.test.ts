import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import {
  closePackagingStructure,
  getPackagingStatus,
  getPackagingStructure,
  retainPackagingStructure,
} from "../../../src/packaging/get-structure";
import * as snapshot from "../../../src/packaging/snapshot";
import { StructureWatcher } from "../../../src/packaging/watcher";

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "justomp-life-"));
  roots.push(root);
  await writeFile(join(root, "package.json"), '{"name":"one"}');
  return root;
}
afterEach(async () => {
  mock.restore();
  await closePackagingStructure();
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
test("known watcher failure disables cache on every subsequent call", async () => {
  const original = StructureWatcher.prototype.start;
  spyOn(StructureWatcher.prototype, "start").mockImplementation(async function (
    this: StructureWatcher,
    signal,
  ) {
    await original.call(this, signal);
    this.lose("injected overflow");
  });
  const root = await fixture();
  const a = await getPackagingStructure(root);
  const b = await getPackagingStructure(root);
  expect(a.fallbackReason).toContain("overflow");
  expect(b.cacheHit).toBe(false);
  expect(b.structure.scanId).not.toBe(a.structure.scanId);
});
test("polling environment override uses explicit full-inspect fallback without native subscriptions", async () => {
  const previous = process.env.CHOKIDAR_USEPOLLING;
  process.env.CHOKIDAR_USEPOLLING = "true";
  try {
    const root = await fixture();
    const a = await getPackagingStructure(root);
    expect(a.fallbackReason).toContain("polling");
    expect(a.watcher.watchedPaths).toEqual([]);
    expect((await getPackagingStructure(root)).cacheHit).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.CHOKIDAR_USEPOLLING;
    else process.env.CHOKIDAR_USEPOLLING = previous;
  }
});
test("event during publication triggers another scan before successful return", async () => {
  const root = await fixture();
  const original = snapshot.publishSnapshot;
  let changed = false;
  spyOn(snapshot, "publishSnapshot").mockImplementation(
    async (report, signal) => {
      if (!changed) {
        changed = true;
        const rev = getPackagingStatus(root)?.revision ?? 0;
        await writeFile(join(root, "package.json"), '{"name":"two"}');
        for (
          let n = 0;
          n < 200 && (getPackagingStatus(root)?.revision ?? 0) === rev;
          n++
        )
          await Bun.sleep(5);
      }
      return original(report, signal);
    },
  );
  const result = await getPackagingStructure(root);
  expect(result.structure.projects[0]?.name).toBe("two");
  expect(
    JSON.parse(
      await readFile(join(root, ".justomp/packaging_structure.json"), "utf8"),
    ).scanId,
  ).toBe(result.structure.scanId);
});
test("all callers cancel before publication; later request recovers", async () => {
  const root = await fixture();
  for (let i = 0; i < 50; i++) await mkdir(join(root, `dir-${i}`));
  const controller = new AbortController();
  const pending = getPackagingStructure(root, { signal: controller.signal });
  controller.abort(new Error("cancelled"));
  await expect(pending).rejects.toThrow("cancelled");
  await Bun.sleep(30);
  expect(
    await Bun.file(join(root, ".justomp/packaging_structure.json")).exists(),
  ).toBe(false);
  expect((await getPackagingStructure(root)).structure.complete).toBe(true);
});
test("shutdown joins pending work and releases subscriptions; last session owns closure", async () => {
  const root = await fixture();
  const releaseA = await retainPackagingStructure(root);
  const releaseB = await retainPackagingStructure(root);
  await getPackagingStructure(root);
  await releaseA();
  expect(getPackagingStatus(root)?.healthy).toBe(true);
  await releaseB();
  expect(getPackagingStatus(root)).toBeUndefined();
});

test("last waiter cancellation during publication waits for unwind and next call recovers", async () => {
  const root = await fixture();
  const entered = Promise.withResolvers<void>();
  const original = snapshot.publishSnapshot;
  const replacement = spyOn(snapshot, "publishSnapshot").mockImplementation(
    async (report, signal) => {
      entered.resolve();
      await Bun.sleep(30);
      return original(report, signal);
    },
  );
  const controller = new AbortController();
  const pending = getPackagingStructure(root, { signal: controller.signal });
  await entered.promise;
  controller.abort(new Error("stop publication"));
  await expect(pending).rejects.toThrow("stop publication");
  expect(
    await Bun.file(join(root, ".justomp/packaging_structure.json")).exists(),
  ).toBe(false);
  replacement.mockRestore();
  expect((await getPackagingStructure(root)).watcher.healthy).toBe(true);
});

test("shutdown during publication leaves no late snapshot", async () => {
  const root = await fixture();
  const entered = Promise.withResolvers<void>();
  const original = snapshot.publishSnapshot;
  spyOn(snapshot, "publishSnapshot").mockImplementation(
    async (report, signal) => {
      entered.resolve();
      await Bun.sleep(30);
      return original(report, signal);
    },
  );
  const pending = getPackagingStructure(root);
  const outcome = pending.catch((error: unknown) => error);
  await entered.promise;
  await closePackagingStructure(root);
  expect(await outcome).toBeInstanceOf(Error);
  expect(
    await Bun.file(join(root, ".justomp/packaging_structure.json")).exists(),
  ).toBe(false);
});

test("failed forced refresh invalidates old in-memory success even before watcher delivery", async () => {
  const root = await fixture();
  await getPackagingStructure(root);
  const emit = FSWatcher.prototype.emit;
  spyOn(FSWatcher.prototype, "emit").mockImplementation(function (
    this: FSWatcher,
    ...args: Parameters<typeof emit>
  ) {
    if (args[0] === "all") return false;
    return emit.apply(this, args);
  });
  await writeFile(join(root, "package.json"), "{");
  await expect(getPackagingStructure(root, { refresh: true })).rejects.toThrow(
    "incomplete",
  );
  await expect(getPackagingStructure(root)).rejects.toThrow("incomplete");
});

test("continuous revision changes exhaust the request budget and leave no late publication", async () => {
  const root = await fixture();
  const start = StructureWatcher.prototype.start;
  let active: StructureWatcher | undefined;
  spyOn(StructureWatcher.prototype, "start").mockImplementation(async function (
    this: StructureWatcher,
    signal,
  ) {
    await start.call(this, signal);
    active = this;
  });
  const publish = snapshot.publishSnapshot;
  spyOn(snapshot, "publishSnapshot").mockImplementation(
    async (report, signal) => {
      const elapsed = await publish(report, signal);
      if (active) active.revision++;
      return elapsed;
    },
  );
  const schedule = globalThis.setTimeout;
  spyOn(globalThis, "setTimeout").mockImplementation(((
    ...args: Parameters<typeof setTimeout>
  ) =>
    schedule(
      args[0],
      args[1] === 25_000 ? 25 : args[1],
      ...args.slice(2),
    )) as typeof setTimeout);
  await expect(getPackagingStructure(root)).rejects.toThrow(
    "structure-unstable",
  );
  const path = join(root, ".justomp/packaging_structure.json");
  const saved = (await Bun.file(path).exists())
    ? await readFile(path, "utf8")
    : null;
  await Bun.sleep(30);
  expect(
    (await Bun.file(path).exists()) ? await readFile(path, "utf8") : null,
  ).toBe(saved);
});
