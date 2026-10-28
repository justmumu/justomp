import type {
  AdapterContext,
  Dependency,
  Inventory,
} from "../../../../src/dependencies/model";
export function context(manager: "npm" | "pnpm"): AdapterContext {
  const project = {
    project_id: "javascript:packages/a/package.json",
    path: "packages/a",
    ecosystem: "javascript" as const,
    manifest: "packages/a/package.json",
    manager,
    managerRoot: ".",
    workspace: `${manager}:.`,
    managerCandidates: [manager],
    frameworks: [],
    status: "detected" as const,
    evidence: [],
  };
  return {
    root: "/fixture",
    cwd: "/fixture/packages/a",
    owner: "/fixture",
    manager,
    version: manager === "npm" ? "11.12.1" : "10.20.0",
    project,
    structure: {
      schemaVersion: 2,
      scanId: "fixture",
      root: "/fixture",
      startedAt: "",
      completedAt: "",
      projects: [
        project,
        {
          ...project,
          project_id: "javascript:packages/b/package.json",
          path: "packages/b",
          manifest: "packages/b/package.json",
        },
      ],
      workspaces: [],
      localDependencies: [],
      diagnostics: [],
      excluded: [],
      complete: true,
      metrics: {
        durationMs: 0,
        directoryEntries: 0,
        directories: 0,
        manifestReads: 0,
        manifestBytes: 0,
        parseMs: 0,
        relationshipMs: 0,
        maxConcurrentIO: 0,
      },
    },
    run: async () => {
      throw new Error("Planning must not spawn");
    },
  };
}
export function inventory(
  ...groups: ("runtime" | "dev" | "peer")[]
): Inventory {
  return {
    dependencies: groups.map(
      (group) =>
        ({
          name: "fixture-dep",
          group: { kind: group },
          source: { kind: "registry" },
          declared_specifier: "^1.0.0",
          direct: true,
          evidence: {
            file: "packages/a/package.json",
            field: "dependencies.fixture-dep",
          },
        }) satisfies Dependency,
    ),
    complete: true,
    diagnostics: [],
  };
}
