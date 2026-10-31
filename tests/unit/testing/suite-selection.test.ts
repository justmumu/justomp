import { expect, test } from "bun:test";
import { resolveIntegrationTestConfig } from "../../../src/config/integration-test/resolve";
import { resolveTestConfig } from "../../../src/config/test/resolve";
import { integrationRunnerEvidence } from "../../../src/testing/detect";
import { partitionSuites } from "../../../src/testing/selection";

test("both suite sets detect overlap before hidden directory filters and exclude their union from sources", () => {
  const unit = resolveTestConfig().policy.python;
  const integration = resolveIntegrationTestConfig().policy.python;
  unit.include = ["**/test_*.py"];
  unit.exclude = [];
  const files = [
    "tests/integration/test_api.py",
    "checks/test_unit.py",
    "app.py",
  ] as const;
  expect(() =>
    partitionSuites(files, unit, integration, "python", "unit"),
  ).toThrow("test-scope-conflict");
  expect(() =>
    partitionSuites(files, unit, integration, "python", "integration"),
  ).toThrow("tests/integration/test_api.py");
  unit.exclude = ["tests/integration/**"];
  unit.source.exclude = [];
  integration.source.exclude = [];
  expect(
    partitionSuites(files, unit, integration, "python", "integration"),
  ).toMatchObject({
    tests: [files[0]],
    sources: ["app.py"],
    integration: [files[0]],
  });
  expect(
    partitionSuites(files, unit, integration, "python", "unit").tests,
  ).toEqual([files[1]]);
});
test("integration script evidence accepts literal configs and rejects wrappers or conflicting runners", () => {
  expect(
    integrationRunnerEvidence(
      {
        scripts: {
          "test:integration": "vitest run --config 'vitest.integration.ts'",
        },
      },
      "vitest",
    ),
  ).toBe("vitest.integration.ts");
  expect(integrationRunnerEvidence({}, "vitest")).toBeUndefined();
  expect(() =>
    integrationRunnerEvidence(
      { scripts: { "test:integration": "bun test" } },
      "vitest",
    ),
  ).toThrow("Conflicting");
  for (const script of [
    "jest",
    "node --test",
    "node scripts/test.js",
    "vitest && migrate",
    "vitest --config $CONFIG",
  ])
    expect(() =>
      integrationRunnerEvidence(
        { scripts: { "test:integration": script } },
        "vitest",
      ),
    ).toThrow();
});

test("literal config words join quoted fragments without evaluating shell syntax", () => {
  for (const [script, runner, config] of [
    [
      'vitest run --config="path with spaces.ts"',
      "vitest",
      "path with spaces.ts",
    ],
    ["bun test -c='integration.toml'", "bun", "integration.toml"],
    [
      "vitest run --config=vitest.'integration'.ts",
      "vitest",
      "vitest.integration.ts",
    ],
  ] as const) {
    expect(
      integrationRunnerEvidence(
        { scripts: { "test:integration": script } },
        runner,
      ),
    ).toBe(config);
  }
  for (const script of [
    'vitest --config="unterminated',
    "vitest --config=",
    'vitest --config ""',
  ]) {
    expect(() =>
      integrationRunnerEvidence(
        { scripts: { "test:integration": script } },
        "vitest",
      ),
    ).toThrow();
  }
});

test("integration script options cannot silently discard native setup or environment", () => {
  for (const [script, runner] of [
    ["bun test --preload ./setup.ts", "bun"],
    ["bun test --env-file=.env.test", "bun"],
    ["vitest run --environment jsdom", "vitest"],
    ["vitest run --mode integration", "vitest"],
    ["vitest run --unknown", "vitest"],
  ] as const) {
    expect(() =>
      integrationRunnerEvidence(
        { scripts: { "test:integration": script } },
        runner,
      ),
    ).toThrow("Unsupported integration script option");
  }
  expect(
    integrationRunnerEvidence(
      { scripts: { "test:integration": "vitest run tests/integration" } },
      "vitest",
    ),
  ).toBeUndefined();
});
