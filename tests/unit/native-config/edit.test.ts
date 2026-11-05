import { expect, test } from "bun:test";
import { parse } from "smol-toml";
import { configObject, editNativeConfig } from "../../../src/native-config/edit";

test("native script edits preserve imports, plugins, callbacks and unmanaged comments", () => {
  const before =
    'import { defineConfig } from "vitest/config";\nimport plugin from "custom";\n// keep project context\nexport default defineConfig({ plugins:[plugin()], test: { setupFiles:["setup.ts"], watch:true } });\n';
  const changed = editNativeConfig(before, "vitest.config.ts", { test: { watch: false, retry: 0 } });
  expect(changed.content).toContain('import plugin from "custom"');
  expect(changed.content).toContain("plugins:[plugin()]");
  expect(changed.content).toContain("// keep project context");
  expect(changed.content).toContain('setupFiles:["setup.ts"]');
  expect(changed.fields).toEqual([
    ["test", "watch"],
    ["test", "retry"],
  ]);
  expect(
    editNativeConfig(changed.content, "vitest.config.ts", { test: { watch: false, retry: 0 } }, changed.fields).content,
  ).toBe(changed.content);
  const removed = editNativeConfig(changed.content, "vitest.config.ts", { test: { watch: false } }, changed.fields);
  expect(removed.content).not.toContain('"retry"');
});
test("native script adoption refuses factories and spreads without executing them", () => {
  for (const text of ["export default dangerous();", "export default { ...unknown, semi: false };"]) {
    expect(() => editNativeConfig(text, "prettier.config.js", { semi: true })).toThrow("statically edit");
  }
});
test("native TOML edits keep unrelated tables, inline data and comments", () => {
  const before =
    '# retain metadata\n[project]\nname="app"\n[tool.pyright]\nextraPaths=["stubs"]\ntypeCheckingMode="off"\n[tool.other]\nvalue={x=1}\n';
  const updated = editNativeConfig(
    before,
    "pyproject.toml",
    { typeCheckingMode: "strict", include: ["src"] },
    [],
    ["tool", "pyright"],
  );
  expect(updated.content).toContain("# retain metadata");
  expect(updated.content).toContain('extraPaths=["stubs"]');
  expect(updated.content).toContain("value={x=1}");
  expect(parse(updated.content)).toMatchObject({
    project: { name: "app" },
    tool: { pyright: { extraPaths: ["stubs"], typeCheckingMode: "strict", include: ["src"] } },
  });
  const removed = editNativeConfig(updated.content, "pyproject.toml", { typeCheckingMode: "strict" }, updated.fields, [
    "tool",
    "pyright",
  ]);
  expect(parse(removed.content)).toMatchObject({
    tool: { pyright: { typeCheckingMode: "strict", extraPaths: ["stubs"] } },
  });
  expect(removed.content).not.toContain('"include"');
});
test("native JSONC updates preserve comments and remove only formerly managed leaves", () => {
  const before = '{// keep\n"compilerOptions":{"strict":false,"module":"NodeNext","old":true}}';
  const edited = editNativeConfig(before, "tsconfig.json", { compilerOptions: { strict: true } }, [
    ["compilerOptions", "old"],
  ]);
  expect(edited.content).toContain("// keep");
  expect(Bun.JSONC.parse(edited.content)).toEqual({ compilerOptions: { strict: true, module: "NodeNext" } });
});

test("native field retirement prunes empty owned containers without removing unmanaged siblings", () => {
  const desired = { output: { formats: { json: { path: "stdout" } } } };
  for (const [path, before] of [
    ["biome.jsonc", '{// preserve\n"output":{"formats":{"html":{"path":"report.html"}}},"run":{"timeout":"3m"}}'],
    [".golangci.yml", "# preserve\noutput:\n  formats:\n    html:\n      path: report.html\nrun:\n  timeout: 3m\n"],
  ]) {
    if (!path || !before) {
      throw new Error("missing fixture");
    }
    const edited = editNativeConfig(before, path, desired, [["output", "formats", "html", "path"]]);
    expect(configObject(edited.content, path)).toEqual({ ...desired, run: { timeout: "3m" } });
    expect(edited.content).toContain("preserve");
  }
});

test("static config adoption rejects later exported-object mutation without running it", () => {
  for (const suffix of [
    "module.exports.test.exclude = ['**'];",
    "Object.assign(module.exports.test, {exclude:['**']});",
    "const alias = module.exports; alias.test.exclude = ['**'];",
    "exports.test.exclude = ['**'];",
  ]) {
    const before = "module.exports = {test:{exclude:[]}};\n" + suffix;
    expect(() => editNativeConfig(before, "vitest.config.cjs", { test: { exclude: [] } })).toThrow("another statement");
  }
  const safe = 'module.exports = {semi:false};\nfunction helper() { return {exports: "unrelated"}; }';
  expect(editNativeConfig(safe, "prettier.config.cjs", { semi: true }).content).toContain(
    'function helper() { return {exports: "unrelated"}; }',
  );
});

test("static config adoption rejects a helper declared before the export that later mutates policy", () => {
  const before = "function tune(){module.exports.test.retry=9;} module.exports={test:{retry:0}}; tune();";
  expect(() => editNativeConfig(before, "vitest.config.cjs", { test: { retry: 0 } })).toThrow("vitest.config.cjs");
});
