import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLintConfig } from "../../../../src/config/lint/resolve";
import { type PackagingStructure, type Project } from "../../../../src/inspect/model";
import { pythonAdapter } from "../../../../src/lint/adapters/python";
import { type LintOperationContext } from "../../../../src/lint/adapters/types";
import { applyProjection, planProjection } from "../../../../src/lint/projection";
import { resolveLintTarget } from "../../../../src/lint/targets";
import { suppliedResponse } from "../../../response";

export const VERSION = "0.17.3";
export async function pythonFixture(workspace = false, declaration = "") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lint-python-")));
  const paths = workspace ? [".", "packages/a", "packages/b"] : ["."];
  const projects: Project[] = [];
  for (const [index, path] of paths.entries()) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, path, "pyproject.toml"),
      `[project]\nname="lint-example-${index}"\nversion="0.1.0"\nrequires-python=">=3.11"\n${declaration}\n[tool.uv]\npackage=false\n${workspace && index === 0 ? '[tool.uv.workspace]\nmembers=["packages/*"]\n' : ""}`,
    );
    projects.push({
      project_id: `python:${path}`,
      path,
      manifest: join(path, "pyproject.toml"),
      ecosystem: "python",
      name: `lint-example-${index}`,
      manager: "uv",
      managerRoot: ".",
      managerCandidates: ["uv"],
      frameworks: [],
      status: "detected",
      evidence: [],
    });
  }
  const structure = { root, complete: true, projects } as PackagingStructure;
  const targets = await Promise.all(projects.map((p) => resolveLintTarget(structure, p.project_id)));
  const policy = resolveLintConfig().policy;
  const signal = new AbortController().signal;
  const context: LintOperationContext = {
    targets,
    policy,
    signal,
    versions: Object.fromEntries(projects.map((p) => [p.project_id, { ruff: VERSION }])),
    changes: [],
  };
  const checkContext = async (index = 0) => {
    const target = targets[index];
    if (!target) {
      throw new Error("Missing fixture target");
    }
    const versions = context.versions[target.project.project_id];
    if (!versions) {
      throw new Error("Missing fixture versions");
    }
    return {
      target,
      policy,
      signal,
      versions,
      projection: await planProjection(target, policy),
    };
  };
  return {
    root,
    targets,
    context,
    async prepare() {
      await pythonAdapter.preflight(context);
      await pythonAdapter.prepareBatch(context);
      for (const target of targets) {
        await applyProjection(await planProjection(target, policy), context.changes);
      }
    },
    checkContext,
    bytes() {
      return suppliedResponse(() => {
        return Promise.all(
          ["pyproject.toml", "uv.lock", "module.py", ".venv/pyvenv.cfg"].map((p) => readFile(join(root, p), "utf8")),
        );
      });
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
