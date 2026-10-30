import type { ProcessResult } from "../../../src/dependencies/model";
import type { Project } from "../../../src/inspect/model";
import type { LintScope } from "../../../src/lint/scope";
import type { LintTarget } from "../../../src/lint/targets";

/** In-memory adapter inputs. No inspection, files, installs or child processes. */
export function target(ecosystem: Project["ecosystem"]): LintTarget {
  const project: Project = {
    project_id: `${ecosystem}:apps/app`,
    path: "apps/app",
    ecosystem,
    manifest: "apps/app/manifest",
    managerRoot: "apps/app",
    managerCandidates: [],
    frameworks: [],
    status: "detected",
    evidence: [],
  };
  return {
    root: "/repo",
    project,
    structure: { projects: [project] },
    scope: {
      cwd: "/repo/apps/app",
      owner: "/repo/apps/app",
      manager: ecosystem === "python" ? "uv" : "npm",
      env: {},
    },
  } as LintTarget;
}
export function scope(file: string): LintScope {
  return {
    files: [file],
    packages: [],
    childRoots: [],
    ignores: [],
    hasTypescript: file.endsWith(".ts"),
    empty: false,
  };
}
export function output(overrides: Partial<ProcessResult> = {}): ProcessResult {
  return {
    exit_code: 0,
    signal: null,
    stdout: "",
    stderr: "",
    truncated: false,
    cancelled: false,
    ...overrides,
  };
}
