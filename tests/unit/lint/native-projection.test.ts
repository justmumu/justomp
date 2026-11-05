import { afterEach, expect, spyOn, test } from "bun:test";
import { parse as toml } from "smol-toml";
import { parse as yaml } from "yaml";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { object } from "../../../src/dependencies/inventory";
import * as files from "../../../src/lint/files";
import { planProjection } from "../../../src/lint/projection";
import * as scopes from "../../../src/lint/scope";
import { scope, target } from "../checks/fixture";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) {
    restore();
  }
});
function fixture(ecosystem: "javascript" | "python" | "go" = "javascript") {
  const selected = target(ecosystem);
  selected.project.manifest = "apps/app/package.json";
  const docs = new Map<string, string>([["/repo/apps/app/package.json", '{"name":"app"}']]);
  const read = spyOn(files, "readProjectionFile").mockImplementation(async (_root, path) => ({
    text: docs.get(path) ?? null,
    identity: docs.has(path) ? path : null,
    mode: 420,
  }));
  const collect = spyOn(scopes, "collectLintScope").mockResolvedValue(scope("index.ts"));
  restores.push(
    () => read.mockRestore(),
    () => collect.mockRestore(),
  );
  return {
    docs,
    collect,
    plan: () => planProjection(selected, resolveLintConfig().policy, { "@biomejs/biome": "2.6.3" }),
  };
}
test("native lint adoption updates central policy and preserves JSONC project context", async () => {
  const f = fixture();
  f.docs.set(
    "/repo/apps/app/biome.jsonc",
    '{\n// project context\n"javascript":{"jsxRuntime":"classic"},"linter":{"enabled":false}\n}',
  );
  f.docs.set("/repo/apps/app/package.json", '{"name":"app","prettier":{"semi":false,"plugins":["custom-plugin"]}}');
  const plan = await f.plan();
  expect(plan.configs).toEqual({ lint: "/repo/apps/app/biome.jsonc", format: "/repo/apps/app/package.json" });
  const biome = plan.files.find((file) => file.path === plan.configs.lint)?.content ?? "";
  expect(biome).toContain("// project context");
  expect(Bun.JSONC.parse(biome)).toMatchObject({ javascript: { jsxRuntime: "classic" }, linter: { enabled: true } });
  const manifest = JSON.parse(plan.files.find((file) => file.path === plan.configs.format)?.content ?? "{}");
  expect(manifest).toMatchObject({ name: "app", prettier: { semi: true, plugins: ["custom-plugin"] } });
  for (const file of plan.files) {
    f.docs.set(file.path, file.content);
  }
  expect((await f.plan()).current).toBe(true);
});
test("native lint defaults use standard filenames and reject ambiguous Biome configs", async () => {
  const f = fixture();
  expect((await f.plan()).configs).toEqual({
    lint: "/repo/apps/app/biome.json",
    format: "/repo/apps/app/.prettierrc.json",
  });
  f.docs.set("/repo/apps/app/biome.json", "{}");
  f.docs.set("/repo/apps/app/biome.jsonc", "{}");
  await expect(f.plan()).rejects.toThrow("biome");
});

test("nested Biome leaves share policy while inherited native snapshots remain observable", async () => {
  const f = fixture();
  f.collect.mockResolvedValue({ ...scope("src/index.ts"), childRoots: ["apps/child"], ignores: ["apps/child/**"] });
  f.docs.set("/repo/apps/app/biome.json", '{"extends":["./biome.base.json"]}');
  f.docs.set("/repo/apps/app/biome.base.json", '{"javascript":{"jsxRuntime":"classic"}}');
  f.docs.set("/repo/apps/app/src/biome.jsonc", '{"extends":"//","javascript":{"globals":["local"]}}');
  f.docs.set("/repo/apps/app/apps/child/biome.json", '{"linter":{"enabled":false}}');
  const plan = await f.plan();
  const nested = plan.files.find((file) => file.path === "/repo/apps/app/src/biome.jsonc");
  expect(Bun.JSONC.parse(nested?.content ?? "{}")).toMatchObject({
    root: false,
    extends: "//",
    linter: { enabled: true },
  });
  expect(plan.files.some((file) => file.path.includes("apps/child"))).toBe(false);
  expect(plan.inputs?.some((input) => input.path === "/repo/apps/app/biome.base.json")).toBe(true);
  for (const file of plan.files) {
    f.docs.set(file.path, file.content);
  }
  const repeated = await f.plan();
  expect(repeated.current).toBe(true);
  expect(repeated.files.some((file) => file.changed)).toBe(false);
  f.docs.set("/repo/apps/app/biome.base.json", '{"linter":{"rules":{"suspicious":{"unknownRule":"error"}}}}');
  await expect(f.plan()).rejects.toThrow("unknownRule");
});

test("standalone Ruff policy cannot retain local rule opt-outs absent the shared policy", async () => {
  const f = fixture("python");
  f.docs.set(
    "/repo/apps/app/.ruff.toml",
    'src=["source"]\n[lint]\nselect=["F"]\n[lint.per-file-ignores]\n"source/*"=["ALL"]\n',
  );
  const plan = await f.plan();
  expect(plan.configs.lint).toBe("/repo/apps/app/.ruff.toml");
  const config = toml(plan.files[0]?.content ?? "");
  expect(config.src).toEqual(["source"]);
  expect(object(config.lint)).toEqual(object(resolveLintConfig().policy.python.ruff.lint));
});
test("native Go context survives while local diagnostic filters and extra output sinks are removed", async () => {
  const f = fixture("go");
  f.docs.set(
    "/repo/apps/app/.golangci.yaml",
    'version: "2"\nrun:\n  timeout: 3m\nlinters:\n  disable: [govet]\nissues:\n  new: true\noutput:\n  formats:\n    html:\n      path: report.html\n',
  );
  const plan = await f.plan();
  const config = yaml(plan.files[0]?.content ?? "");
  expect(config.run.timeout).toBe("3m");
  expect(config.linters.disable).toBeUndefined();
  expect(config.issues.new).toBe(false);
  expect(config.output.formats).toEqual({ json: { path: "stdout" } });
});
