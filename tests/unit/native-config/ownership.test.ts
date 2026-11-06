import { expect, spyOn, test } from "bun:test";
import * as files from "../../../src/lint/files";
import { LintStateStore } from "../../../src/lint/state";
import { lintToolchainId } from "../../../src/lint/toolchain";
import { parseNativeOwnership, reconcileFields } from "../../../src/native-config/ownership";
import { TestStateStore } from "../../../src/testing/state";
import { TypecheckStateStore } from "../../../src/typecheck/state";

test("native policy updates owned fields without dropping project context", () => {
  const before = {
    compilerOptions: { strict: false, module: "NodeNext", oldOption: true },
    references: [{ path: "../ui" }],
  };
  const result = reconcileFields(before, { compilerOptions: { strict: true } }, [
    ["compilerOptions", "strict"],
    ["compilerOptions", "oldOption"],
  ]);
  expect(result.value).toEqual({
    compilerOptions: { strict: true, module: "NodeNext" },
    references: [{ path: "../ui" }],
  });
  expect(result.fields).toEqual([["compilerOptions", "strict"]]);
  expect(before.compilerOptions.oldOption).toBe(true);
  expect(reconcileFields(result.value, { compilerOptions: { strict: true } }, result.fields)).toEqual(result);
});

test("native ownership rejects paths and keys that cannot identify local managed fields", () => {
  const config = { role: "typescript", path: "tsconfig.json", fields: [["compilerOptions", "strict"]] };
  expect(parseNativeOwnership({ version: 1, configs: [config] })).toEqual({ version: 1, configs: [config] });
  for (const path of ["../other.json", "/tmp/other.json", "a/../b.json", "a\\b.json"]) {
    expect(parseNativeOwnership({ version: 1, configs: [{ ...config, path }] })).toBeUndefined();
  }
  expect(
    parseNativeOwnership({ version: 1, configs: [{ ...config, fields: [["__proto__", "polluted"]] }] }),
  ).toBeUndefined();
  expect(parseNativeOwnership({ version: 2, configs: [config] })).toBeUndefined();
  expect(parseNativeOwnership(undefined)).toBeUndefined();
});

for (const family of ["lint", "typecheck", "testing"] as const) {
  test(`${family} invalid native ownership retains installed versions and waves`, async () => {
    const tools = family === "testing" ? { pytest: "8.0.0" } : { ruff: "0.14.0" };
    const receipt = {
      ...(family === "testing" ? { runner: "pytest" as const } : { ecosystem: "python" as const }),
      ...(family === "lint" ? { toolchain_id: lintToolchainId("python") } : {}),
      tools,
      policy_hash: "policy",
      ready: true,
    };
    const original = { schema: family === "lint" ? 3 : 1, projects: { "python:.": receipt }, waves: {} };
    const read = spyOn(files, "readProjectionFile").mockResolvedValue({
      text: JSON.stringify(original),
      identity: "1",
      mode: 420,
    });
    try {
      const load = () =>
        family === "lint"
          ? LintStateStore.load("/repo")
          : family === "typecheck"
            ? TypecheckStateStore.load("/repo")
            : TestStateStore.load("/repo");
      expect((await load()).state.projects["python:."]).toEqual(receipt);
      read.mockResolvedValue({
        text: JSON.stringify({
          ...original,
          projects: { "python:.": { ...receipt, native_configs: { version: 999 } } },
        }),
        identity: "1",
        mode: 420,
      });
      const loaded = await load();
      expect(loaded.recovery).toBeUndefined();
      expect(loaded.state.projects["python:."]).toEqual({ ...receipt, ready: false });
      expect(loaded.state.waves).toEqual({});
    } finally {
      read.mockRestore();
    }
  });
}
