import { expect, test } from "bun:test";
import { type ProcessResult } from "../../../src/dependencies/model";
import { projectJavascriptRelease } from "../../../src/release/adapters/javascript";
import { pythonVersionStep, releaseLockStep } from "../../../src/release/adapters/lock-refresh";
import { projectPythonReferences } from "../../../src/release/adapters/python";
import { executeReleaseSteps } from "../../../src/release/adapters/service";
import { type NativeReleasePlan } from "../../../src/release/adapters/types";
import { type ReleaseStep } from "../../../src/release/model";

test("release lock plans preserve owner and disable lifecycle scripts without upgrades", () => {
  expect(releaseLockStep("npm", "11.0.0", "/repo").args).toEqual([
    "install",
    "--package-lock-only",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
  ]);
  expect(releaseLockStep("pnpm", "10.0.0", "/repo", "/repo/locks").args).toContain("/repo/locks");
  expect(releaseLockStep("bun", "1.4.2", "/repo").args).toEqual(["install", "--lockfile-only", "--ignore-scripts"]);
  expect(releaseLockStep("yarn", "4.12.0", "/repo").env).toEqual({
    YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
    YARN_ENABLE_SCRIPTS: "false",
  });
  expect(releaseLockStep("yarn", "1.22.22", "/repo").args).toContain("--non-interactive");
  expect(pythonVersionStep("2.0.0", "/repo/packages/api").args).toEqual(["version", "2.0.0", "--frozen"]);
});
test("JavaScript release edits preserve unrelated fields and validate expected old values", () => {
  const before =
    '{\n  "name": "app",\n  "version": "1.0.0",\n  "description": "keep",\n  "dependencies": { "local": "^1.0.0" }\n}\n';
  const edit = {
    manifest: "package.json",
    field: ["dependencies", "local"],
    before: "^1.0.0",
    after: "^2.0.0",
    target_project_id: "local",
  };
  const after = projectJavascriptRelease(before, "2.0.0", [edit]);
  expect(JSON.parse(after)).toEqual({
    name: "app",
    version: "2.0.0",
    description: "keep",
    dependencies: { local: "^2.0.0" },
  });
  expect(() => projectJavascriptRelease(before, "2.0.0", [{ ...edit, before: "stale" }])).toThrow();
});
test("Python release reference projection preserves comments and unrelated strings", () => {
  const before =
    '[project]\nname="app"\nversion="1.0.0"\n# keep\ndependencies = [\n  "local==1.0.0", # dependency\n]\ndescription="local==1.0.0"\n';
  const after = projectPythonReferences(before, [
    {
      manifest: "pyproject.toml",
      field: ["project", "dependencies", "0"],
      before: "local==1.0.0",
      after: "local==2.0.0",
      target_project_id: "local",
    },
  ]);
  expect(after).toContain('"local==2.0.0", # dependency');
  expect(after).toContain('description="local==1.0.0"');
  expect(after).toContain("# keep");
  expect(after).toContain('version="1.0.0"');
});

for (const failure of [
  { exit_code: 1, cancelled: false, truncated: false },
  { exit_code: null, cancelled: true, truncated: false },
  { exit_code: 0, cancelled: false, truncated: true },
]) {
  test(`native release stops subsequent owners after ${JSON.stringify(failure)}`, async () => {
    const native: ProcessResult = { ...failure, stdout: "", stderr: "incomplete", signal: null };
    const calls: string[] = [],
      observed: ReleaseStep[] = [];
    const plan = {
      repo: { git: { root: "/repo" } },
      owners: ["first", "second"].map((name) => ({
        command: "npm",
        steps: [{ args: ["install"], label: "Refresh release lock" }],
        context: {
          owner: `/repo/${name}`,
          run: () => {
            calls.push(name);
            return Promise.resolve(native);
          },
        },
      })),
    } as unknown as NativeReleasePlan;
    await expect(executeReleaseSteps(plan, (step) => observed.push(step))).rejects.toMatchObject({
      code: failure.cancelled ? "native-cancelled" : "native-release-failed",
    });
    expect(calls).toEqual(["first"]);
    expect(observed).toEqual([{ owner: "first", executable: "npm", args: ["install"], result: native }]);
  });
}
