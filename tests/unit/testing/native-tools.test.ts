import { expect, test } from "bun:test";
import { type Inventory, type ProcessResult } from "../../../src/dependencies/model";
import {
  batchJavascriptSteps,
  classifyResult,
  exactDeclarations,
  javascriptToolRequest,
  nativeResult,
  parseEvidence,
} from "../../../src/testing/native-tools";
import { suppliedResponse } from "./fixture";

test("exact readiness requires dev declaration, lock and version agreement", () => {
  const inventory: Inventory = {
    complete: true,
    diagnostics: [],
    dependencies: [
      {
        name: "pytest",
        direct: true,
        declared_specifier: "==9.0.0",
        group: { kind: "dev" },
        source: { kind: "registry" },
        resolutions: [{ version: "9.0.0" }],
        evidence: { file: "pyproject.toml", field: "dependency-groups.dev" },
      },
    ],
  };
  expect(exactDeclarations(inventory, { pytest: "9.0.0" }, true)).toBe(true);
  expect(exactDeclarations(inventory, { pytest: "9.0.1" }, true)).toBe(false);
  const first = inventory.dependencies[0];
  if (!first) {
    throw new Error("Missing fixture declaration");
  }
  first.resolutions = [];
  expect(exactDeclarations(inventory, { pytest: "9.0.0" }, true)).toBe(false);
});
test("native failure keeps process evidence and partial test results after coverage parser failure", async () => {
  const process: ProcessResult = {
      exit_code: 1,
      signal: null,
      stdout: "test logs",
      stderr: "native failure",
      truncated: true,
      cancelled: false,
    },
    result = nativeResult(process);
  expect(result.tests.total).toBeNull();
  result.tests = { total: 2, passed: 1, failed: 1, skipped: 0, cases: [] };
  classifyResult(result);
  await parseEvidence(result, () => {
    return suppliedResponse(() => {
      throw new Error("bad coverage");
    });
  });
  expect(result.tests.total).toBe(2);
  expect(result.errors.map((e) => e.code)).toEqual(["test-failed", "test-operation-failed"]);
  expect(result.stderr).toBe("native failure");
  expect(result.logs_truncated).toBe(true);
});

test("native preparation requests exact dev tools and coalesces matching native peer installs", () => {
  const empty: Inventory = {
    complete: false,
    diagnostics: [],
    dependencies: [],
  };
  expect(javascriptToolRequest("javascript:.", "vitest", "4.0.0", empty)).toEqual({
    operation: "add",
    project_id: "javascript:.",
    group: { kind: "dev" },
    packages: [{ name: "vitest", version: "4.0.0", source: { kind: "registry" } }],
  });
  const tools = { vitest: "4.0.0", "@vitest/coverage-v8": "4.0.0" };
  const steps = batchJavascriptSteps(
    Object.entries(tools).map(([n, v]) => ({
      args: ["install", `${n}@${v}`, "--save-dev", "--save-exact"],
      cwd: "/owner",
      label: n,
    })),
    tools,
  );
  expect(steps).toHaveLength(1);
  expect(steps[0]?.args).toEqual([
    "install",
    "vitest@4.0.0",
    "--save-dev",
    "--save-exact",
    "@vitest/coverage-v8@4.0.0",
  ]);
  const existing: Inventory = {
    ...empty,
    dependencies: [
      {
        name: "vitest",
        direct: true,
        declared_specifier: "^3.0.0",
        group: { kind: "dev" },
        source: { kind: "registry" },
        evidence: { file: "package.json", field: "devDependencies" },
      },
    ],
  };
  expect(javascriptToolRequest("javascript:.", "vitest", "4.0.0", existing)).toMatchObject({
    operation: "update",
    packages: [{ version: "4.0.0", group: { kind: "dev" } }],
  });
  const declaration = existing.dependencies[0];
  if (!declaration) {
    throw new Error("Missing fixture declaration");
  }
  declaration.group = { kind: "runtime" };
  expect(() => javascriptToolRequest("javascript:.", "vitest", "4.0.0", existing)).toThrow("registry dev");
});
