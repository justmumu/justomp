import { readdir, readFile, statfs, writeFile } from "node:fs/promises";
import { cpus, platform, release, totalmem } from "node:os";
import {
  closePackagingStructure,
  getPackagingStatus,
  getPackagingStructure,
  type PackagingResult,
} from "../../src/packaging/get-structure";
import { createLargeTree, type LargeTreeFixture, type LargeTreeOptions } from "../fixtures/generate-large-tree";

const SAMPLES = 20;
interface Sample {
  wallMs: number;
  requestWaitMs: number;
  parseMs: number;
  relationshipMs: number;
  publishMs: number;
  eventWaitMs: number;
  directories: number;
  directoryEntries: number;
  manifestReads: number;
  manifestBytes: number;
  maxConcurrentIO: number;
  cacheHit: boolean;
  watchedDirectories: number;
}
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percent: number) => sorted[Math.max(0, Math.ceil(sorted.length * percent) - 1)] ?? 0;
  return {
    samples: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: sorted.at(-1) ?? 0,
  };
}
function summarize(samples: Sample[]) {
  const fields = [
    "wallMs",
    "requestWaitMs",
    "parseMs",
    "relationshipMs",
    "publishMs",
    "eventWaitMs",
    "directories",
    "directoryEntries",
    "manifestReads",
    "manifestBytes",
    "maxConcurrentIO",
    "watchedDirectories",
  ] as const;
  return {
    cacheHits: samples.filter((s) => s.cacheHit).length,
    ...Object.fromEntries(fields.map((field) => [field, distribution(samples.map((s) => s[field]))])),
  };
}
function sample(result: PackagingResult, wallMs: number, eventWaitMs = 0): Sample {
  const metrics = result.structure.metrics;
  return {
    wallMs,
    requestWaitMs: result.waitMs,
    parseMs: result.cacheHit ? 0 : metrics.parseMs,
    relationshipMs: result.cacheHit ? 0 : metrics.relationshipMs,
    publishMs: result.publishMs,
    eventWaitMs,
    directories: result.cacheHit ? 0 : metrics.directories,
    directoryEntries: result.cacheHit ? 0 : metrics.directoryEntries,
    manifestReads: result.cacheHit ? 0 : metrics.manifestReads,
    manifestBytes: result.cacheHit ? 0 : metrics.manifestBytes,
    maxConcurrentIO: result.cacheHit ? 0 : metrics.maxConcurrentIO,
    cacheHit: result.cacheHit,
    watchedDirectories: result.watcher.watchedPaths.length,
  };
}
async function fileDescriptors(): Promise<number | null> {
  try {
    return (await readdir(process.platform === "linux" ? "/proc/self/fd" : "/dev/fd")).length;
  } catch {
    return null;
  }
}
async function resources() {
  return {
    reportedActiveResourceTypes:
      typeof process.getActiveResourcesInfo === "function" ? process.getActiveResourcesInfo() : null,
    observedFileDescriptors: await fileDescriptors(),
  };
}
async function waitForChange(root: string, previous: number): Promise<number> {
  const started = performance.now();
  for (;;) {
    const status = getPackagingStatus(root);
    if (!status?.healthy) {
      throw new Error(`Watcher lost coverage: ${status?.reason ?? "closed"}`);
    }
    if (status.revision > previous) {
      return performance.now() - started;
    }
    if (performance.now() - started > 5000) {
      throw new Error("Native notification did not arrive within5seconds");
    }
    await Bun.sleep(2);
  }
}
async function measure(fixture: LargeTreeFixture) {
  let sampledPeakRssBytes = process.memoryUsage().rss;
  const rssBefore = sampledPeakRssBytes;
  const capture = () => {
    sampledPeakRssBytes = Math.max(sampledPeakRssBytes, process.memoryUsage().rss);
  };
  const sampler = setInterval(capture, 20);
  const usageBefore = process.resourceUsage();
  const resourcesBefore = await resources();
  try {
    console.error(
      `[bench] initial watch+inspect: ${fixture.projects} projects, ${fixture.generatedEntries} generated entries`,
    );
    let started = performance.now();
    const initial = await getPackagingStructure(fixture.root);
    const initialSample = sample(initial, performance.now() - started);
    capture();
    if (!initial.watcher.healthy) {
      throw new Error(`Fixture requires proven local native notifications: ${initial.fallbackReason}`);
    }
    const resourcesWatching = await resources();
    const idleStart = performance.now();
    const idleBefore = process.cpuUsage();
    await Bun.sleep(350);
    const idleCpu = process.cpuUsage(idleBefore);
    const idleMs = performance.now() - idleStart;
    const idle = {
      elapsedMs: idleMs,
      userCpuMs: idleCpu.user / 1000,
      systemCpuMs: idleCpu.system / 1000,
      oneCorePercent: ((idleCpu.user + idleCpu.system) / 1000 / idleMs) * 100,
    };
    const clean: Sample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      started = performance.now();
      const result = await getPackagingStructure(fixture.root);
      if (!result.cacheHit) {
        throw new Error("Clean getter unexpectedly rescanned");
      }
      clean.push(sample(result, performance.now() - started));
      capture();
    }
    console.error(`[bench] ${SAMPLES} dirty refreshes`);
    const manifest = JSON.parse(await readFile(fixture.firstManifest, "utf8")) as Record<string, unknown>;
    const dirty: Sample[] = [];
    for (let i = 0; i < SAMPLES; i++) {
      const revision = getPackagingStatus(fixture.root)?.revision ?? 0;
      await writeFile(fixture.firstManifest, JSON.stringify({ ...manifest, description: `benchmark revision ${i}` }));
      const eventWait = await waitForChange(fixture.root, revision);
      started = performance.now();
      const result = await getPackagingStructure(fixture.root);
      if (result.cacheHit) {
        throw new Error("Dirty getter did not refresh");
      }
      dirty.push(sample(result, performance.now() - started, eventWait));
      capture();
    }
    const resourcesAfterRefreshes = await resources();
    await closePackagingStructure(fixture.root);
    console.error(`[bench] ${SAMPLES} explicit full-inspection fallbacks`);
    const fallback = await measureFallback(fixture, capture);
    const usageAfter = process.resourceUsage();
    const resourcesAfterClose = await resources();
    return {
      initial: summarize([initialSample]),
      clean: summarize(clean),
      dirty: summarize(dirty),
      fallback: summarize(fallback),
      idle,
      rssBeforeBytes: rssBefore,
      sampledPeakRssBytes,
      samplingIntervalMs: 20,
      processLifetimeMaxRssKiB: usageAfter.maxRSS,
      resourceUsageBlockIO: {
        reads: usageAfter.fsRead - usageBefore.fsRead,
        writes: usageAfter.fsWrite - usageBefore.fsWrite,
      },
      resourcesBefore,
      resourcesWatching,
      resourcesAfterRefreshes,
      resourcesAfterClose,
    };
  } finally {
    clearInterval(sampler);
    await closePackagingStructure(fixture.root);
  }
}
async function measureFallback(fixture: LargeTreeFixture, capture: () => void): Promise<Sample[]> {
  const oldPolling = process.env.CHOKIDAR_USEPOLLING;
  const fallback: Sample[] = [];
  try {
    process.env.CHOKIDAR_USEPOLLING = "true";
    for (let i = 0; i < SAMPLES; i++) {
      const started = performance.now();
      const result = await getPackagingStructure(fixture.root);
      if (result.cacheHit || !result.fallbackReason || result.watcher.watchedPaths.length) {
        throw new Error("Expected full inspection without polling or subscriptions");
      }
      fallback.push(sample(result, performance.now() - started));
      capture();
    }
  } finally {
    if (oldPolling === undefined) {
      delete process.env.CHOKIDAR_USEPOLLING;
    } else {
      process.env.CHOKIDAR_USEPOLLING = oldPolling;
    }
    await closePackagingStructure(fixture.root);
  }

  return fallback;
}

function argumentsForRun(): { excludedEntries: number; smoke: boolean } {
  const args = process.argv.slice(2);
  let excludedEntries = 1_000_000;
  let smoke = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--smoke") {
      smoke = true;
      continue;
    }
    if (arg === "--excluded-entries") {
      excludedEntries = Number(args[++i]);
      if (!Number.isSafeInteger(excludedEntries) || excludedEntries < 0) {
        throw new Error("--excluded-entries requires a nonnegative integer");
      }
      continue;
    }
    throw new Error(`Unknown benchmark argument: ${arg}`);
  }
  return { excludedEntries, smoke };
}
async function main() {
  const options = argumentsForRun();
  const matrix: LargeTreeOptions[] = options.smoke
    ? [
        {
          projects: 1,
          entries: 100,
          excludedEntries: Math.min(options.excludedEntries, 200),
        },
      ]
    : [
        { projects: 1, entries: 100 },
        { projects: 50, entries: 10_000 },
        { projects: 500, entries: 100_000 },
        {
          projects: 50,
          entries: 10_000,
          excludedEntries: options.excludedEntries,
        },
      ];
  const results = [];
  for (const definition of matrix) {
    console.error(`[bench] generating ${JSON.stringify(definition)}`);
    const generationStart = performance.now();
    const fixture = await createLargeTree(definition);
    const generationMs = performance.now() - generationStart;
    try {
      const fs = await statfs(fixture.root);
      const measurements = await measure(fixture);
      const { cleanup: _, ...description } = fixture;
      results.push({
        fixture: description,
        generationMs,
        filesystem: { type: Number(fs.type), blockSize: fs.bsize },
        ...measurements,
      });
      console.error(`[bench] measured ${fixture.generatedEntries} entries; cleaning temporary fixture`);
    } finally {
      await fixture.cleanup();
      console.error("[bench] fixture cleanup finished");
    }
  }
  process.stdout.write(
    JSON.stringify(
      {
        schemaVersion: 1,
        measuredAt: new Date().toISOString(),
        environment: {
          bun: Bun.version,
          node: process.version,
          platform: platform(),
          osRelease: release(),
          architecture: process.arch,
          cpu: cpus()[0]?.model,
          logicalCpus: cpus().length,
          totalMemoryBytes: totalmem(),
        },
        methodology: {
          samplesPerRepeatedMode: SAMPLES,
          initialSamples: 1,
          coldCacheClaim: false,
          networkFilesystemTested: false,
          watcherCount: "Chokidar watched directory paths, not raw kernel watches or file descriptors",
          entryLayout:
            "Flat JS projects with explicit local dependencies; source and excluded files use per-directory hardlinks. Excluded entries count directories and empty files exactly.",
          memory:
            "RSS sampled every20ms and at each completed call; fixture generation precedes measurement. Lifetime maxRSS also includes generation.",
          io: "Inspector counters measure discovery work, not kernel syscall traces. resourceUsageBlockIO is OS-reported block IO, not bytes. Clean cache hits report zero scan counters.",
          fallback:
            "CHOKIDAR_USEPOLLING=true deliberately selects the no-watcher full-inspect path; the adapter rejects polling.",
        },
        results,
      },
      null,
      2,
    ) + "\n",
  );
}
await main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
