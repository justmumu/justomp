import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  evaluateCost,
  readGateReports,
  type readTestReport,
  WARM_BUDGET_SECONDS,
} from "./test-cost-report";
import { runCostStage } from "./test-cost-runner";

const args = process.argv.slice(2);
const cold = args.includes("--cold");
const baselineIndex = args.indexOf("--baseline");
const baselinePath = baselineIndex < 0 ? undefined : args[baselineIndex + 1];
const allowed = args.filter(
  (_, i) =>
    baselineIndex < 0 || (i !== baselineIndex && i !== baselineIndex + 1),
);
if (
  (baselineIndex >= 0 && !baselinePath) ||
  allowed.some((arg) => arg !== "--cold")
)
  throw new Error("Usage: bun run test:cost [--cold] [--baseline report.json]");
const root = resolve(import.meta.dir, "..");
const output = resolve(
  root,
  ".private/test-cost",
  new Date().toISOString().replaceAll(":", "-"),
);
await mkdir(output, { recursive: true });
const env: NodeJS.ProcessEnv = {
  ...process.env,
  JUSTOMP_TEST_TIMINGS: resolve(output, "fixture-timings.jsonl"),
};
if (cold) {
  // New private stores, never delete a contributor's global caches.
  for (const [key, folder] of Object.entries({
    npm_config_cache: "npm",
    npm_config_store_dir: "pnpm",
    YARN_CACHE_FOLDER: "yarn",
    BUN_INSTALL_CACHE_DIR: "bun",
    UV_CACHE_DIR: "uv",
    GOCACHE: "go-build",
    GOPATH: "go-path",
  }))
    env[key] = resolve(output, "cache", folder);
}
const environment = {
  platform: `${process.platform}-${process.arch}`,
  bun: Bun.version,
  node: (await Bun.$`node --version`.quiet()).stdout.toString().trim(),
  executables: Object.fromEntries(
    ["node", "npm", "pnpm", "yarn", "uv", "go"].map((name) => [
      name,
      Bun.which(name),
    ]),
  ),
  yarn_launchers: {
    classic: process.env.JUSTOMP_YARN_CLASSIC_BINARY ?? null,
    modern: process.env.JUSTOMP_YARN_MODERN_BINARY ?? null,
    typecheck: process.env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY ?? null,
  },
  fixture_tool_pins: Object.fromEntries(
    await Promise.all(
      [
        "tests/fixtures/lint/javascript/fixture.ts",
        "tests/fixtures/lint/python/fixture.ts",
        "tests/fixtures/typecheck/javascript/fixture.ts",
        "tests/fixtures/typecheck/python/fixture.ts",
        "tests/fixtures/typecheck/generated/fixture.ts",
      ].map(async (path) => [
        path,
        [
          ...new Set(
            (
              (await readFile(resolve(root, path), "utf8")) +
              (path === "tests/fixtures/lint/javascript/fixture.ts"
                ? await readFile(
                    resolve(root, "tests/fixtures/lint/javascript/versions.ts"),
                    "utf8",
                  )
                : "")
            ).match(/\b\d+\.\d+\.\d+\b/g) ?? [],
          ),
        ].sort(),
      ]),
    ),
  ),
  fixtures: await Bun.file(
    resolve(root, "tests/fixtures/dependencies/manager-versions.json"),
  ).json(),
};
let baselineSeconds: number | undefined;
if (baselinePath) {
  const baseline = JSON.parse(await readFile(resolve(baselinePath), "utf8"));
  if (
    !baseline.complete ||
    baseline.cache !== "warm" ||
    JSON.stringify(baseline.environment) !== JSON.stringify(environment)
  )
    throw new Error(
      "Baseline must be a complete warm run in the same environment",
    );
  if (
    typeof baseline.seconds !== "number" ||
    !Number.isFinite(baseline.seconds) ||
    baseline.seconds <= 0
  )
    throw new Error("Baseline must record a positive finite duration");
  baselineSeconds = baseline.seconds;
}
const start = performance.now();
const stages = [];
let counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
let cases: ReturnType<typeof readTestReport>["cases"] = [];
let unitCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
let integrationCounts = { ...unitCounts };
let unitSeconds = 0;
let error: string | undefined;
for (const [name, command] of [
  [
    "check",
    [
      process.execPath,
      "run",
      "check",
      "--reporter=junit",
      "--reporter-outfile",
      resolve(output, "unit.xml"),
    ],
  ],
  [
    "integration",
    [
      process.execPath,
      "test",
      "tests/integration",
      "--bail",
      "--reporter=junit",
      "--reporter-outfile",
      resolve(output, "integration.xml"),
    ],
  ],
] as const) {
  const stage = await runCostStage(
    command,
    root,
    env,
    resolve(output, `${name}.log`),
  );
  const { exit_code } = stage;
  stages.push({ name, ...stage });
  console.log(
    `${name}: exit ${exit_code}, ${stages.at(-1)?.seconds.toFixed(2)}s`,
  );
  if (exit_code !== 0) break;
}
try {
  const [unitXml, integrationXml] = await Promise.all([
    readFile(resolve(output, "unit.xml"), "utf8"),
    readFile(resolve(output, "integration.xml"), "utf8"),
  ]);
  const gate = readGateReports(unitXml, integrationXml);
  counts = gate.counts;
  unitCounts = gate.unit.counts;
  integrationCounts = gate.integration.counts;
  cases = [...gate.unit.cases, ...gate.integration.cases];
  unitSeconds = gate.unit.cases.reduce(
    (total, item) => total + item.seconds,
    0,
  );
} catch (failure) {
  error = String(failure);
}
const seconds = (performance.now() - start) / 1000;
const result = evaluateCost(
  seconds,
  counts,
  stages.map((stage) => stage.exit_code),
  baselineSeconds,
);
const files: Record<string, number> = {};
for (const test of cases)
  files[test.file] = (files[test.file] ?? 0) + test.seconds;
const groups = { unit: unitSeconds, local: 0, native: 0 };
for (const [file, duration] of Object.entries(files).filter(
  ([file]) => !file.replaceAll("\\", "/").includes("tests/unit/"),
))
  groups[file.endsWith(".native.test.ts") ? "native" : "local"] += duration;
const fixtureStages: Record<string, { calls: number; seconds: number }> = {};
try {
  const timing = await readFile(
    resolve(output, "fixture-timings.jsonl"),
    "utf8",
  );
  for (const line of timing.trim().split("\n")) {
    const item: { stage: string; seconds: number } = JSON.parse(line);
    const aggregate = fixtureStages[item.stage] ?? { calls: 0, seconds: 0 };
    fixtureStages[item.stage] = aggregate;
    aggregate.calls++;
    aggregate.seconds += item.seconds;
  }
} catch (failure) {
  if ((failure as NodeJS.ErrnoException).code !== "ENOENT") throw failure;
}
const report = {
  groups,
  fixtureStages,
  ...result,
  seconds,
  cache: cold ? "cold" : "warm",
  environment,
  stages,
  counts,
  unit_counts: unitCounts,
  integration_counts: integrationCounts,
  budget_seconds: WARM_BUDGET_SECONDS,
  files,
  error,
};
const path = resolve(output, "report.json");
await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
console.log(path);
console.log(
  `Total ${seconds.toFixed(2)}s; complete=${result.complete}; warm budget=${result.budget_met}; reduction=${result.reduction === null ? "unmeasured" : `${(result.reduction * 100).toFixed(1)}%`}`,
);
process.exitCode =
  result.complete &&
  (cold ||
    (result.budget_met &&
      (baselineSeconds === undefined || result.reduction_met)))
    ? 0
    : 1;
