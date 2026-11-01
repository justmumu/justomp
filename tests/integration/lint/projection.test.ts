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
import { formatPrettier } from "../../../src/format/engines/prettier";
import { formatterFor } from "../../../src/format/selection";
import type { PackagingStructure, Project } from "../../../src/inspect/model";
import { applyProjection, planProjection } from "../../../src/lint/projection";
import { JS_MARKER } from "../../../src/lint/projections/javascript";
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
  await expect(
    planProjection(target, policy, { "@biomejs/biome": "2.6.3" }),
  ).rejects.toThrow("owned");
  await rm(join(root, "golangci.justomp.yml"));
  const plan = await planProjection(target, policy, {
    "@biomejs/biome": "2.6.3",
  });
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
  expect(
    (await planProjection(target, policy, { "@biomejs/biome": "2.6.3" }))
      .current,
  ).toBe(true);
  policy.go.golangci.linters.enable = [];
  const changed = await planProjection(target, policy, {
    "@biomejs/biome": "2.6.3",
  });
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
      biome: {
        rules: {},
        typed_rules: {},
        test_rules: {},
        react_rules: {},
        next_rules: {},
      },
    },
  }).policy;
  policy.javascript.biome.test_rules = {
    suspicious: {
      noConsole: {
        level: "warn",
        options: { allow: ["'); globalThis.projectionInjected = true; //"] },
      },
    },
  };
  const plan = await planProjection(target, policy, {
    "@biomejs/biome": "2.6.3",
  });
  await applyProjection(plan);
  const config = Bun.JSONC.parse(await readFile(plan.configs.lint, "utf8")) as {
    linter: { rules: unknown };
    overrides: { linter: { rules: unknown } }[];
  };
  expect(config.linter.rules).toEqual({ preset: "none" });
  expect(config.overrides.at(-1)?.linter.rules).toEqual(
    policy.javascript.biome.test_rules,
  );
  expect(Reflect.has(globalThis, "projectionInjected")).toBe(false);
  expect(
    (await planProjection(target, policy, { "@biomejs/biome": "2.6.3" }))
      .current,
  ).toBe(true);
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

// Existing projection boundary: formatting must not cause subsequent preparation writes.
// Three small filesystem fixtures, no native tool setup or installs.
test("formatting managed projections preserves readiness and subsequent bytes", async () => {
  const policy = resolveLintConfig().policy;
  for (const ecosystem of ["python", "javascript", "go"] as const) {
    const { target } = await fixture(ecosystem);
    const initial = await planProjection(target, policy, {
      "@biomejs/biome": "2.6.3",
    });
    await applyProjection(initial);
    const expected = new Map<string, string>();
    for (const file of initial.files) {
      const formatter = formatterFor(file.path, ecosystem);
      if (formatter?.engine !== "prettier")
        throw new Error("missing config formatter");
      const text = await formatPrettier(file.content, formatter.parser, {
        ...policy.javascript.prettier,
        tabWidth: 4,
        endOfLine: "crlf",
      });
      await writeFile(file.path, text);
      expected.set(file.path, text);
    }
    const next = await planProjection(target, policy, {
      "@biomejs/biome": "2.6.3",
    });
    expect(next.files.filter((f) => f.changed).map((f) => f.path)).toEqual([]);
    expect(next.current).toBe(true);
    expect(await applyProjection(next)).toEqual([]);
    for (const [path, text] of expected)
      expect(await readFile(path, "utf8")).toBe(text);
    if (ecosystem === "python") {
      const path = initial.configs.format;
      const formatted = await readFile(path, "utf8");
      const drift = formatted.replace(
        /("?line-length"?\s*=\s*)120\b/,
        "$1120.0",
      );
      expect(drift).not.toBe(formatted);
      await writeFile(path, drift);
      const repair = await planProjection(target, policy, {
        "@biomejs/biome": "2.6.3",
      });
      expect(repair.current).toBe(false);
      expect(await applyProjection(repair)).toEqual([
        {
          project_id: target.project.project_id,
          path: "pyproject.toml",
          kind: "updated",
        },
      ]);
      expect(
        (await planProjection(target, policy, { "@biomejs/biome": "2.6.3" }))
          .current,
      ).toBe(true);
      expect(await readFile(path, "utf8")).not.toContain("120.0");
    }
  }
});

test("Biome publication retires only unchanged owned legacy config after replacement", async () => {
  const { root, target } = await fixture();
  const legacy = join(root, "eslint.justomp.config.mjs");
  const managed = join(root, "biome.justomp.jsonc");
  const user = join(root, "biome.json");
  const policy = resolveLintConfig().policy;
  const versions = { "@biomejs/biome": "2.6.3" };
  await writeFile(legacy, `${JS_MARKER}export default [];\n`);
  await writeFile(user, '{"linter":{"enabled":false}}');
  await writeFile(managed, "unowned");
  await expect(planProjection(target, policy, versions)).rejects.toThrow(
    "owned",
  );
  expect(await Bun.file(legacy).exists()).toBe(true);
  await rm(managed);
  const plan = await planProjection(target, policy, versions);
  const changes = await applyProjection(plan);
  expect(changes).toContainEqual({
    project_id: target.project.project_id,
    path: "eslint.justomp.config.mjs",
    kind: "removed",
  });
  expect(await Bun.file(legacy).exists()).toBe(false);
  expect(await Bun.file(managed).exists()).toBe(true);
  expect(await readFile(user, "utf8")).toBe('{"linter":{"enabled":false}}');
  await writeFile(legacy, `${JS_MARKER}export default [];\n`);
  const pending = await planProjection(target, policy, versions);
  await writeFile(legacy, "user replacement");
  await expect(applyProjection(pending)).rejects.toThrow("changed");
  expect(await readFile(legacy, "utf8")).toBe("user replacement");
  expect((await planProjection(target, policy, versions)).current).toBe(true);
});
