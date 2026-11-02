import { expect, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { projectJavascript } from "../../../src/lint/projections/javascript";
import { scope, target as selectedTarget } from "../checks/fixture";

test("Biome projection isolates config discovery and applies explicit typed/framework/test layers", () => {
  const target = selectedTarget("javascript");
  target.project.frameworks = ["next"];
  const policy = resolveLintConfig().policy.javascript;
  const output = projectJavascript(target, policy, { ...scope("app.tsx"), hasTypescript: true }, "2.6.3");
  const data = Bun.JSONC.parse(output) as {
    $schema: string;
    root: boolean;
    formatter: { enabled: boolean };
    vcs: { enabled: boolean };
    files: { includes: string[] };
    linter: { rules: unknown };
    assist: { actions: unknown };
    overrides: { linter: { rules: unknown } }[];
  };
  expect(data.$schema).toBe("https://biomejs.dev/schemas/2.6.3/schema.json");
  expect(data.root).toBe(true);
  expect(data.formatter.enabled).toBe(false);
  expect(data.vcs.enabled).toBe(false);
  expect(data.files.includes).toContain("!!**/biome.json");
  expect(data.files.includes).toContain("!!**/biome.jsonc");
  expect(data.linter.rules).toEqual({ preset: "none", ...policy.biome.rules });
  expect(data.assist.actions).toEqual({
    preset: "none",
    source: { organizeImports: policy.biome.organize_imports },
  });
  expect(data.overrides.map((o: { linter: { rules: unknown } }) => o.linter.rules)).toEqual([
    policy.biome.typed_rules,
    policy.biome.react_rules,
    policy.biome.next_rules,
    policy.biome.test_rules,
  ]);
  target.project.frameworks = [];
  const js = Bun.JSONC.parse(projectJavascript(target, policy, scope("app.js"), "2.6.3")) as {
    overrides: unknown[];
    plugins?: unknown;
    extends?: unknown;
  };
  expect(js.overrides).toHaveLength(1);
  expect(js.plugins).toBeUndefined();
  expect(js.extends).toBeUndefined();
});
