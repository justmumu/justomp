import { expect, test } from "bun:test";
import { createMatcher } from "../../../src/inspect/exclusions";
import type { Project } from "../../../src/inspect/model";
import { scopeIgnores } from "../../../src/lint/scope";

const project = (path: string, ecosystem: Project["ecosystem"]): Project => ({
  project_id: `${ecosystem}:${path}`,
  path,
  ecosystem,
  manifest: `${path}/package.json`,
  manager: "npm",
  managerRoot: ".",
  managerCandidates: ["npm"],
  frameworks: [],
  status: "detected",
  evidence: [],
});
test("scope excludes nested projects across ecosystems, but not co-located projects", () => {
  const root = project(".", "javascript");
  const ignores = scopeIgnores(root, [
    root,
    project(".", "python"),
    project("apps/api", "python"),
    project("../other", "go"),
  ]);
  expect(ignores).toContain("apps/api/**");
  expect(ignores).not.toContain("./**");
  expect(ignores).not.toContain("../other/**");
  expect(ignores).toContain("**/node_modules/**");
});
test("internal state, tools and generated configs never enter inspection with empty excludes", () => {
  const matcher = createMatcher({ include: ["**/*"], exclude: [] });
  for (const path of [
    ".justomp/lint_state.json",
    ".justomp/tools/package.json",
    "apps/web/eslint.justomp.config.mjs",
    "apps/web/prettier.justomp.json",
    "golangci.justomp.yml",
  ]) {
    expect(matcher.includes(path)).toBe(false);
  }
  expect(matcher.includes(".config/tool.py")).toBe(true);
});

test("literal child project paths are escaped instead of hiding a similarly named sibling", () => {
  const root = project(".", "javascript");
  const ignores = scopeIgnores(root, [root, project("apps/[a]", "javascript")]);
  expect(ignores).toContain("apps/\\[a\\]/**");
  expect(ignores).not.toContain("apps/[a]/**");
  expect(ignores).not.toContain("apps/a/**");
});
