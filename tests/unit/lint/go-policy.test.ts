import { expect, test } from "bun:test";
import { parse } from "yaml";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { projectGo } from "../../../src/lint/projections/go";

for (const override of [
  { run: [] },
  { run: null },
  { issues: [] },
  { issues: "invalid" },
  { issues: { fix: true } },
  { output: { formats: { json: { path: "source.go" } } } },
  { run: { "allow-parallel-runners": true } },
]) {
  test(`Go policy rejects unsafe operational override ${JSON.stringify(override)}`, () => {
    const policy = resolveLintConfig().policy.go;
    Object.assign(policy.golangci, override);
    const before = structuredClone(policy);
    expect(() => projectGo(policy)).toThrow();
    expect(policy).toEqual(before);
  });
}
test("Go projection owns readonly execution, full diagnostics and stdout output", () => {
  const projected = parse(projectGo(resolveLintConfig().policy.go));
  expect(projected.run).toMatchObject({
    "modules-download-mode": "readonly",
    "allow-parallel-runners": false,
    "issues-exit-code": 1,
  });
  expect(projected.issues).toMatchObject({
    fix: false,
    "max-issues-per-linter": 0,
    "max-same-issues": 0,
  });
  expect(projected.output.formats).toEqual({ json: { path: "stdout" } });
});
