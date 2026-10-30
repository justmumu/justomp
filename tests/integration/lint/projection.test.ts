import { afterEach, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as yaml } from "yaml";
import { resolveLintConfig } from "../../../src/config/lint/resolve";
import type { PackagingStructure, Project } from "../../../src/inspect/model";
import { applyProjection, planProjection } from "../../../src/lint/projection";
import { collectLintScope } from "../../../src/lint/scope";
import { resolveLintTarget } from "../../../src/lint/targets";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});
async function fixture(ecosystem: Project["ecosystem"] = "javascript") {
  const root = await mkdtemp(join(tmpdir(), "lint-projection-"));
  roots.push(root);
  const project: Project = {
    project_id: `${ecosystem}:.`,
    path: ".",
    ecosystem,
    manifest:
      ecosystem === "python"
        ? "pyproject.toml"
        : ecosystem === "go"
          ? "go.mod"
          : "package.json",
    manager: ecosystem === "python" ? "uv" : ecosystem === "go" ? "go" : "npm",
    managerRoot: ".",
    managerCandidates: [],
    frameworks: [],
    status: "detected",
    evidence: [],
  };
  const structure = {
    root,
    complete: true,
    projects: [project],
  } as PackagingStructure;
  await writeFile(
    join(root, project.manifest),
    ecosystem === "python"
      ? '[project]\nname="example"\nversion="0.1.0"\n'
      : ecosystem === "go"
        ? "module example.com/test\n\ngo 1.24\n"
        : '{"name":"example"}',
  );
  return {
    root,
    project,
    structure,
    target: await resolveLintTarget(structure, project.project_id),
  };
}
test("owned source files include hidden source, exclude children, generated files and symlinks", async () => {
  const { root, structure, project } = await fixture();
  for (const path of [
    "src/index.ts",
    ".config/task.js",
    "apps/api/server.js",
    "node_modules/pkg/index.js",
    "dist/out.js",
    ".justomp/tools/main.js",
    "eslint.justomp.config.mjs",
    "other.py",
  ]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }
  await symlink("src/index.ts", join(root, "alias.ts"));
  structure.projects.push({
    ...project,
    project_id: "javascript:apps/api",
    path: "apps/api",
    manifest: "apps/api/package.json",
  });
  const scope = await collectLintScope(
    await resolveLintTarget(structure, project.project_id),
  );
  expect(scope.files).toEqual([".config/task.js", "src/index.ts"]);
  expect(scope.hasTypescript).toBe(true);
});

test("generated projection conflicts, freshness and policy reconciliation are explicit", async () => {
  const { root, target } = await fixture("go");
  const policy = resolveLintConfig().policy;
  await writeFile(
    join(root, "golangci.justomp.yml"),
    "version: '2'\n# not owned\n",
  );
  await expect(planProjection(target, policy)).rejects.toThrow("owned");
  await rm(join(root, "golangci.justomp.yml"));
  const plan = await planProjection(target, policy);
  expect(plan.current).toBe(false);
  expect(yaml(plan.files[0]?.content ?? "")).toEqual({
    version: "2",
    ...policy.go.golangci,
    run: {
      "modules-download-mode": "readonly",
      "allow-parallel-runners": false,
      "allow-serial-runners": false,
      "issues-exit-code": 1,
      "relative-path-mode": "cfg",
    },
    issues: {
      fix: false,
      "max-issues-per-linter": 0,
      "max-same-issues": 0,
      "uniq-by-line": false,
    },
    output: {
      formats: { json: { path: "stdout" } },
      "show-stats": false,
      "path-mode": "abs",
    },
  });
  expect(await applyProjection(plan)).toHaveLength(1);
  expect((await planProjection(target, policy)).current).toBe(true);
  policy.go.golangci.linters.enable = [];
  const changed = await planProjection(target, policy);
  expect(changed.current).toBe(false);
  await writeFile(join(root, "golangci.justomp.yml"), "foreign replacement\n");
  await expect(applyProjection(changed)).rejects.toThrow("changed");
  expect(await readFile(join(root, "golangci.justomp.yml"), "utf8")).toBe(
    "foreign replacement\n",
  );
});

test("JavaScript projection executes as data and preserves explicit empty rules", async () => {
  const { root, target } = await fixture();
  await writeFile(join(root, "index.js"), "const x = 1;");
  const policy = resolveLintConfig({
    javascript: {
      eslint: {
        rules: {},
        typed_rules: {},
        test_rules: {},
        react_rules: {},
        next_rules: {},
      },
    },
  }).policy;
  policy.javascript.eslint.test_rules = {
    "no-console": [
      "warn",
      { allow: ["'); globalThis.projectionInjected = true; //"] },
    ],
  };
  const plan = await planProjection(target, policy);
  await applyProjection(plan);
  const config = (await import(plan.configs.lint)).default;
  expect(config[1].rules).toEqual({});
  expect(config.at(-1).rules).toEqual(policy.javascript.eslint.test_rules);
  expect(Reflect.has(globalThis, "projectionInjected")).toBe(false);
  expect((await planProjection(target, policy)).current).toBe(true);
  expect(JSON.parse(await readFile(plan.configs.format, "utf8"))).toMatchObject(
    policy.javascript.prettier,
  );
});
test("projection refuses symlinked config filenames", async () => {
  const { root, target } = await fixture("go");
  await writeFile(join(root, "other.yml"), "foreign config");
  await symlink("other.yml", join(root, "golangci.justomp.yml"));
  await expect(
    planProjection(target, resolveLintConfig().policy),
  ).rejects.toThrow();
  expect(await readFile(join(root, "other.yml"), "utf8")).toBe(
    "foreign config",
  );
});
test("Go scope excludes generated sources and returns exact owned packages", async () => {
  const { root, target } = await fixture("go");
  await writeFile(
    join(root, "generated.go"),
    "// Code generated by tool. DO NOT EDIT.\npackage main\n",
  );
  await mkdir(join(root, "pkg"));
  await writeFile(join(root, "pkg", "example_test.go"), "package pkg\n");
  expect((await collectLintScope(target)).packages).toEqual(["./pkg"]);
});

test("custom canonical Python and pnpm dependency directories stay outside owned source scope", async () => {
  const f = await fixture("python");
  for (const path of [
    ".env-store/foreign.py",
    ".config/owned.py",
    "module.py",
  ]) {
    await mkdir(join(f.root, path, ".."), { recursive: true });
    await writeFile(join(f.root, path), "");
  }
  await symlink(".env-store", join(f.root, "env-alias"));
  f.target.scope.env.UV_PROJECT_ENVIRONMENT = "env-alias";
  expect((await collectLintScope(f.target)).files).toEqual([
    ".config/owned.py",
    "module.py",
  ]);
  const js = await fixture("javascript");
  for (const path of [
    ".deps/foreign.js",
    ".virtual/foreign.js",
    ".config/owned.js",
    "module.js",
  ]) {
    await mkdir(join(js.root, path, ".."), { recursive: true });
    await writeFile(join(js.root, path), "");
  }
  js.target.scope.manager = "pnpm";
  js.target.scope.pnpm = {
    lockDirectory: js.target.scope.cwd,
    modulesDirectory: ".deps",
    virtualStoreDirectory: join(js.target.scope.cwd, ".virtual"),
    virtualStoreDirectories: [join(js.target.scope.cwd, ".virtual")],
    memberDirectories: [js.target.scope.cwd],
  };
  const scope = await collectLintScope(js.target);
  expect(scope.files).toEqual([".config/owned.js", "module.js"]);
  expect(scope.ignores).toContain(".deps/**");
  expect(scope.ignores).toContain(".virtual/**");
});

test("a dependency directory cannot hide the selected project root", async () => {
  const f = await fixture("python");
  f.target.scope.env.UV_PROJECT_ENVIRONMENT = ".";
  await expect(collectLintScope(f.target)).rejects.toThrow(
    "overlaps the selected project root",
  );
});
