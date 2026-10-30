import { expect, test } from "bun:test";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import { projectJavascript } from "../../../src/lint/projections/javascript";
import { scope, target as selectedTarget } from "../checks/fixture";

test("typed and framework projections register only required fixed plugin imports", () => {
  const target = selectedTarget("javascript");
  const files = { ...scope("app.tsx"), hasTypescript: true };
  target.project.frameworks = ["next"];
  const code = projectJavascript(
    target,
    resolveLintConfig().policy.javascript,
    files,
  );
  const parser = new Bun.Transpiler({ loader: "js" });
  expect(
    parser
      .scanImports(code)
      .map((value) => value.path)
      .sort(),
  ).toEqual(
    [
      "@next/eslint-plugin-next",
      "eslint-plugin-jsx-a11y",
      "eslint-plugin-react-hooks",
      "eslint-plugin-simple-import-sort",
      "typescript-eslint",
      "node:module",
      "node:url",
    ].sort(),
  );
  expect(() => parser.transformSync(code)).not.toThrow();
  expect(code).not.toContain(target.scope.cwd);
  expect(code).toContain('fileURLToPath(new URL(".", import.meta.url))');
  expect(code).toContain('files: ["**/*.{ts,cts,mts,tsx}"]');
  expect(code).toContain("projectService: true, tsconfigRootDir: cwd");
  target.project.frameworks = [];
  const js = projectJavascript(target, resolveLintConfig().policy.javascript, {
    ...files,
    hasTypescript: false,
  });
  expect(parser.scanImports(js).map((value) => value.path)).toEqual([
    "node:url",
    "node:module",
    "eslint-plugin-simple-import-sort",
  ]);
});
