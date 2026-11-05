import { expect, spyOn, test } from "bun:test";
import { parse } from "smol-toml";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import { type LoadedConfig } from "../../../src/config/load";
import { resolveTestConfig } from "../../../src/config/test/resolve";
import * as files from "../../../src/lint/files";
import { planTestProjection } from "../../../src/testing/projection";
import { coveragePolicy, editCoverageIni } from "../../../src/testing/python/native-config";
import * as targets from "../../../src/testing/targets";
import { target } from "../checks/fixture";

const config = {
  test: resolveTestConfig().policy,
  integrationTest: resolveIntegrationTestConfig().policy,
} as LoadedConfig;

test("Bun policy adopts native files once and preserves project setup", async () => {
  const selected: targets.TestTarget = { ...target("javascript"), runner: "bun" };
  const snapshots = new Map([
    ["/repo/apps/app/bunfig.toml", '[install]\nexact=true\n[test]\npreload=["./setup.ts"]\nrerunEach=3\n'],
    ["/repo/apps/app/integration.toml", '[test]\npreload=["./integration-setup.ts"]\ncoverage=true\n'],
  ]);
  const mocks = [
    spyOn(files, "readProjectionFile").mockImplementation(async (_root, path) => ({
      text: snapshots.get(path) ?? null,
      identity: "1",
      mode: 420,
    })),
    spyOn(targets, "resolveTestTarget").mockResolvedValue({
      ...selected,
      configFile: "/repo/apps/app/integration.toml",
    }),
  ];
  try {
    const plan = await planTestProjection(selected, config);
    expect(plan.files).toHaveLength(2);
    expect(plan.current).toBe(false);
    expect(parse(plan.files[0]?.content ?? "")).toMatchObject({
      install: { exact: true },
      test: { preload: ["./setup.ts"], retry: 0 },
    });
    expect(parse(plan.files[0]?.content ?? "").test).not.toHaveProperty("rerunEach");
    expect(parse(plan.files[0]?.content ?? "").test).not.toHaveProperty("coverage");
    for (const file of plan.files) {
      snapshots.set(file.path, file.content);
    }
    const repeated = await planTestProjection(selected, config, plan.ownership);
    expect(repeated.current).toBe(true);
    expect(repeated.files.map((file) => file.content)).toEqual(plan.files.map((file) => file.content));
    expect(JSON.stringify(plan)).not.toContain("test_runs/");
  } finally {
    for (const mock of mocks.reverse()) {
      mock.mockRestore();
    }
  }
});

test("coverage sections preserve unrelated INI settings and retire only owned keys", () => {
  const before =
    "[metadata]\nname=example\n[coverage:run] # keep header\nSOURCE =\n    old\n[coverage:report]\nprecision=3\nold_setting=true\n";
  const policy = coveragePolicy(config.test.python);
  const first = editCoverageIni(before, policy, "coverage:", [["coverage:report", "old_setting"]]);
  expect(first.content).toContain("[metadata]\nname=example");
  expect(first.content).toContain("precision=3");
  expect(first.content).toContain("[coverage:run] # keep header");
  expect(first.content).not.toContain("old_setting");
  expect(first.content).not.toContain("    old");
  expect(editCoverageIni(first.content, policy, "coverage:", first.fields).content).toBe(first.content);
});

test("coverage INI adoption rejects duplicate or malformed native settings", () => {
  const policy = coveragePolicy(config.test.python);
  for (const before of [
    "[run]\nsource=.\nSOURCE=src\n",
    "[run]\n[run]\n",
    "source=.\n",
    "[run]\ninvalid statement\n",
  ]) {
    expect(() => editCoverageIni(before, policy, "", [], "/project/.coveragerc")).toThrow("/project/.coveragerc");
  }
});
