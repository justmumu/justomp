import { expect, test } from "bun:test";
import { planEnvironment, typecheckYarnVersion, verifyVersion } from "../../../scripts/ci/environment";
import { type ProcessResult } from "../../../src/dependencies/model";
import { output } from "../checks/fixture";

const success = (stdout: string): ProcessResult => output({ stdout });

test("CI keeps installed launchers separate from reusable downloads and fixture caches", () => {
  const plan = planEnvironment("/runner/temp", "4.18.1");
  expect(plan.downloads).toBe("/runner/temp/justomp-downloads");
  expect(plan.diagnostics).toBe("/runner/temp/justomp-ci");
  expect(plan.env.JUSTOMP_YARN_MODERN_BINARY).not.toBe(plan.env.JUSTOMP_TYPECHECK_YARN_MODERN_BINARY);
  expect(plan.probes.find((probe) => probe.name === "yarn-modern")?.expected).toBe("4.12.0");
  expect(plan.probes.find((probe) => probe.name === "yarn-typecheck")?.expected).toBe("4.18.1");
  expect(plan.installs.flatMap((install) => install.packages)).toContain("npm@11.12.1");
  expect(plan.env).not.toHaveProperty("npm_config_cache");
  expect(plan.env).not.toHaveProperty("npm_config_store_dir");
  expect(plan.npmrc).toContain("cache=/runner/temp/justomp-downloads/npm");
  expect(plan.env.GOCACHE).toBe("/runner/temp/justomp-tools/go-build");
  expect(plan.env.GOMODCACHE).toBe("/runner/temp/justomp-tools/go-mod");
});

test("CI reads the distinct typecheck Yarn pin from its fixture owner", () => {
  expect(typecheckYarnVersion('manifest.packageManager = "yarn@4.18.1";')).toBe("4.18.1");
  expect(() => typecheckYarnVersion('manifest.packageManager = "npm@11.12.1";')).toThrow("typecheck Yarn");
});

test("CI rejects unsuccessful or wrong runtime version probes", () => {
  const probe = { name: "npm", expected: "11.12.1" };
  expect(verifyVersion(probe, success("11.12.1\n"))).toBe("11.12.1");
  for (const result of [
    success("11.12.0"),
    success(""),
    success("11.12.1-beta"),
    { ...success("11.12.1"), exit_code: 1 },
    { ...success("11.12.1"), cancelled: true },
    { ...success("11.12.1"), truncated: true },
  ]) {
    expect(() => verifyVersion(probe, result)).toThrow("npm requires 11.12.1");
  }
});

test("CI compares versions using the native runtime output formats", () => {
  for (const [name, expected, output] of [
    ["node", "26.0.0", "v26.0.0"],
    ["python", "3.13.13", "Python 3.13.13"],
    ["uv", "0.11.6", "uv 0.11.6 (build 2026-01-01)"],
    ["go", "1.25.6", "go version go1.25.6 darwin/arm64"],
  ]) {
    if (!name || !expected || !output) {
      throw new Error("Missing version witness");
    }
    expect(verifyVersion({ name, expected }, success(output))).toBe(expected);
  }
});
