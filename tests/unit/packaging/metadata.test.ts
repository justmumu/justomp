import { expect, spyOn, test } from "bun:test";
import type { Stats, StatsFs } from "node:fs";
import * as fs from "node:fs/promises";
import { FSWatcher } from "chokidar";
import { INSPECTION_DEFAULTS } from "../../../src/config/inspection/defaults";
import { StructureWatcher } from "../../../src/packaging/watcher";

test("atime-only events do not invalidate while content metadata events do", async () => {
  const probe = spyOn(fs, "statfs").mockResolvedValue({
    type: process.platform === "darwin" ? 0x1a : 0xef53,
  } as StatsFs);
  let native: FSWatcher | undefined;
  const add = spyOn(FSWatcher.prototype, "add").mockImplementation(function (
    this: FSWatcher,
  ) {
    native = this;
    queueMicrotask(() => this.emit("ready"));
    return this;
  });
  const watcher = new StructureWatcher("/supplied", INSPECTION_DEFAULTS);
  const base = {
    dev: 1,
    ino: 2,
    size: 20,
    mtimeMs: 100,
    ctimeMs: 100,
    mode: 0o100644,
    atimeMs: 100,
    isFile: () => true,
  } as Stats;
  try {
    await watcher.start(new AbortController().signal);
    if (!native) throw new Error("missing supplied watcher");
    native.emit("all", "add", "/supplied/package.json", base);
    const revision = watcher.revision;
    native.emit("all", "change", "/supplied/package.json", {
      ...base,
      atimeMs: 200,
    });
    expect(watcher.revision).toBe(revision);
    native.emit("all", "change", "/supplied/package.json", {
      ...base,
      mtimeMs: 200,
    });
    expect(watcher.revision).toBe(revision + 1);
  } finally {
    await watcher.close();
    add.mockRestore();
    probe.mockRestore();
  }
});
