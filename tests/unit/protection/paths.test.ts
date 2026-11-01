import { expect, test } from "bun:test";
import type { Project, Workspace } from "../../../src/inspect/model";
import {
  collectProtectedPaths,
  findProtectedPath,
} from "../../../src/protection/paths";

function project(
  ecosystem: Project["ecosystem"],
  path: string,
  manager: string,
  owner = path,
): Project {
  const name = {
    python: "pyproject.toml",
    javascript: "package.json",
    go: "go.mod",
  }[ecosystem];
  return {
    project_id: `${ecosystem}:${path}/${name}`,
    path,
    ecosystem,
    manifest: path === "." ? name : `${path}/${name}`,
    manager,
    managerRoot: owner,
    managerCandidates: [manager],
    frameworks: [],
    status: "detected",
    evidence: [],
  };
}
function structure(projects: Project[], workspaces: Workspace[] = []) {
  return { root: "/repo", complete: true, projects, workspaces };
}

test("protects manifests, shared owner locks and owned projections in mixed repositories", () => {
  const paths = collectProtectedPaths(
    structure(
      [
        project("python", "apps/api", "uv", "."),
        project("javascript", "apps/web", "pnpm", "."),
        project("go", "services/api", "go", "services"),
      ],
      [
        {
          id: "go:services",
          kind: "go",
          path: "services",
          declaration: "services/go.work",
          members: [],
          evidence: [],
          status: "resolved",
        },
        {
          id: "uv:.",
          kind: "uv",
          path: ".",
          declaration: "pyproject.toml",
          members: [],
          evidence: [],
          status: "resolved",
        },
      ],
    ),
  );
  for (const path of [
    "apps/api/pyproject.toml",
    "pyproject.toml",
    "uv.lock",
    "apps/api/pyright.justomp.json",
    "apps/web/package.json",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "apps/web/eslint.justomp.config.mjs",
    "apps/web/biome.justomp.jsonc",
    "apps/web/prettier.justomp.json",
    "services/api/go.mod",
    "services/api/go.sum",
    "services/go.work",
    "services/go.work.sum",
    "services/api/golangci.justomp.yml",
    ".justomp/config.json",
    ".justomp/typecheck_state.json",
  ])
    expect(paths).toContain(`/repo/${path}`);
  expect(paths).not.toContain("/repo/apps/web/pnpm-lock.yaml");
  expect(paths).not.toContain("/repo/services/go.mod");
  expect(paths).not.toContain("/repo/apps/api/pyrightconfig.json");
  expect(paths).not.toContain("/repo/apps/web/tsconfig.json");
  expect(paths).toEqual([...new Set(paths)].sort());
});

test("ambiguous managers protect each known candidate lock without choosing a manager", () => {
  const app = project("javascript", ".", "npm");
  delete app.manager;
  app.status = "ambiguous";
  app.managerCandidates = ["npm", "bun", "yarn", "pnpm"];
  const paths = collectProtectedPaths(structure([app]));
  for (const name of [
    "package-lock.json",
    "npm-shrinkwrap.json",
    "bun.lock",
    "bun.lockb",
    "yarn.lock",
    "pnpm-lock.yaml",
  ])
    expect(paths).toContain(`/repo/${name}`);
});

test("virtual workspace roots have their own protected declaration and lock", () => {
  const paths = collectProtectedPaths(
    structure(
      [],
      [
        {
          id: "uv:.",
          kind: "uv",
          path: ".",
          declaration: "pyproject.toml",
          members: [],
          evidence: [],
          status: "resolved",
        },
        {
          id: "pnpm:js",
          kind: "pnpm",
          path: "js",
          declaration: "js/pnpm-workspace.yaml",
          members: [],
          evidence: [],
          status: "resolved",
        },
      ],
    ),
  );
  expect(paths).toContain("/repo/uv.lock");
  expect(paths).toContain("/repo/js/pnpm-workspace.yaml");
  expect(paths).toContain("/repo/js/pnpm-lock.yaml");
  expect(paths).toContain("/repo/js/package.json");
});

test("rejects incomplete inspection and metadata paths outside the root", () => {
  expect(() =>
    collectProtectedPaths({ ...structure([]), complete: false }),
  ).toThrow("incomplete");
  const app = project("python", "../outside", "uv");
  expect(() => collectProtectedPaths(structure([app]))).toThrow("outside");
});

test("matches protected files and affected ancestors without prefix collisions", () => {
  const protectedPaths = [
    "/repo/apps/api/pyproject.toml",
    "/repo/.justomp/config.json",
  ];
  expect(
    findProtectedPath("/repo/apps/api/pyproject.toml", protectedPaths),
  ).toBe(protectedPaths[0]);
  expect(findProtectedPath("/repo/apps", protectedPaths)).toBe(
    protectedPaths[0],
  );
  expect(
    findProtectedPath("/repo/apps/api/main.py", protectedPaths),
  ).toBeUndefined();
  expect(
    findProtectedPath("/repo/apps/api/pyproject.toml.backup", protectedPaths),
  ).toBeUndefined();
  expect(
    findProtectedPath("/repo/apps/api-other", protectedPaths),
  ).toBeUndefined();
});
