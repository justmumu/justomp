import { afterEach, expect, test } from "bun:test";
import { link, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Project } from "../../../src/inspect/model";
import { closePackagingStructure, getPackagingStructure } from "../../../src/packaging/get-structure";
import { canonicalProtectionPath, findProtectedPath, resolveProtectedPaths } from "../../../src/protection/paths";

const roots: string[] = [];
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "justomp-protected-paths-")));
  roots.push(root);
  return root;
}
function structure(root: string, ecosystem: Project["ecosystem"] = "javascript") {
  const manifest = ecosystem === "javascript" ? "package.json" : "pyproject.toml";
  const manager = ecosystem === "javascript" ? "npm" : "uv";
  return {
    root,
    complete: true,
    workspaces: [],
    projects: [
      {
        project_id: `${ecosystem}:${manifest}`,
        path: ".",
        ecosystem,
        manifest,
        manager,
        managerRoot: ".",
        managerCandidates: [manager],
        frameworks: [],
        status: "detected" as const,
        evidence: [],
      },
    ],
  };
}
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => {
      await closePackagingStructure(root);
      await rm(root, { recursive: true, force: true });
    }),
  );
});

test("resolves root aliases, missing paths, dynamic and receipt-owned projections", async () => {
  const root = await fixture();
  await mkdir(join(root, "actual/.justomp"), { recursive: true });
  await mkdir(join(root, "actual/config"));
  await symlink(join(root, "actual"), join(root, "alias"));
  await writeFile(join(root, "actual/package.json"), "{}");
  await writeFile(join(root, "actual/tsconfig.justomp.2.json"), "{}");
  await writeFile(join(root, "actual/tsconfig.json"), "{}");
  await writeFile(
    join(root, "actual/.justomp/typecheck_state.json"),
    JSON.stringify({
      schema: 1,
      projects: {},
      waves: {},
      generated: {
        build: {
          ready: true,
          project_ids: [],
          input_hash: "x",
          outputs: {},
          next: {},
          declarations: {
            "config/tsconfig.json": "config/tsconfig.justomp.declarations.abc.json",
          },
        },
      },
    }),
  );
  const paths = await resolveProtectedPaths(structure(join(root, "alias")));
  expect(paths).toContain(join(root, "alias/package.json"));
  expect(paths).toContain(join(root, "actual/package.json"));
  expect(paths).toContain(join(root, "actual/package-lock.json"));
  expect(paths).toContain(join(root, "actual/tsconfig.justomp.2.json"));
  expect(paths).toContain(join(root, "actual/config/tsconfig.justomp.declarations.abc.json"));
  expect(paths).not.toContain(join(root, "actual/tsconfig.json"));
  expect(findProtectedPath(await canonicalProtectionPath(join(root, "alias/package.json")), paths)).toBeDefined();
});

test("follows dangling symlink targets and rejects hardlinked protected inodes", async () => {
  const root = await fixture();
  await symlink("future/manifest.json", join(root, "package.json"));
  expect(await canonicalProtectionPath(join(root, "package.json"))).toBe(join(root, "future/manifest.json"));
  expect(await resolveProtectedPaths(structure(root))).toContain(join(root, "future/manifest.json"));
  await rm(join(root, "package.json"));
  await writeFile(join(root, "package.json"), "{}");
  await link(join(root, "package.json"), join(root, "alias.json"));
  await expect(resolveProtectedPaths(structure(root))).rejects.toThrow("hardlink");
});

test("a symlink loop refuses resolution instead of losing the protected target", async () => {
  const root = await fixture();
  await symlink("other", join(root, "package.json"));
  await symlink("package.json", join(root, "other"));
  await expect(resolveProtectedPaths(structure(root))).rejects.toThrow();
});

test("next resolution consumes newly inspected project metadata", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), '{"name":"app","packageManager":"npm@11.0.0"}');
  const before = await getPackagingStructure(root);
  expect(await resolveProtectedPaths(before.structure)).not.toContain(join(root, "api/pyproject.toml"));
  await mkdir(join(root, "api"));
  await writeFile(join(root, "api/pyproject.toml"), '[project]\nname="api"\nversion="1.0.0"\n[tool.uv]\n');
  const after = await getPackagingStructure(root, { refresh: true });
  expect(await resolveProtectedPaths(after.structure)).toContain(join(root, "api/pyproject.toml"));
});

test("pnpm redirected locks follow the same effective config as dependency operations", async () => {
  const root = await fixture();
  await writeFile(join(root, "package.json"), "{}");
  await writeFile(join(root, ".npmrc"), "lockfile-dir=locks\n");
  const snapshot = structure(root);
  const project = snapshot.projects[0];
  if (!project) {
    throw new Error("Missing fixture project");
  }
  project.manager = "pnpm";
  project.managerCandidates = ["pnpm"];
  expect(await resolveProtectedPaths(snapshot)).toContain(join(root, "locks/pnpm-lock.yaml"));
  await writeFile(join(root, "pnpm-workspace.yaml"), "lockfileDir: shared\n");
  const paths = await resolveProtectedPaths(snapshot);
  expect(paths).toContain(join(root, "shared/pnpm-lock.yaml"));
  expect(paths).not.toContain(join(root, "locks/pnpm-lock.yaml"));
});
