import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveTypecheckConfig } from "../../../../src/config/typecheck/resolve";
import type {
  PackagingStructure,
  Project,
} from "../../../../src/inspect/model";
import { pythonAdapter } from "../../../../src/typecheck/adapters/python";
import type { TypecheckOperationContext } from "../../../../src/typecheck/adapters/types";
import { applyProjection } from "../../../../src/typecheck/projection";
import { resolveTypecheckTarget } from "../../../../src/typecheck/targets";

export const VERSION = "1.1.414";
export async function pythonFixture(workspace = false, declaration = "") {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "typecheck-python-")),
  );
  const paths = workspace ? [".", "packages/a", "packages/b"] : ["."];
  const projects: Project[] = [];
  for (const [index, path] of paths.entries()) {
    await mkdir(join(root, path), { recursive: true });
    await writeFile(
      join(root, path, "pyproject.toml"),
      `[project]\nname="typecheck-example-${index}"\nversion="0.1.0"\nrequires-python=">=3.11"\n${declaration}\n[tool.uv]\npackage=false\n${workspace && index === 0 ? '[tool.uv.workspace]\nmembers=["packages/*"]\n' : ""}`,
    );
    await writeFile(join(root, path, "module.py"), "answer: int = 1\n");
    projects.push({
      project_id: `python:${path}`,
      path,
      manifest: join(path, "pyproject.toml"),
      ecosystem: "python",
      name: `typecheck-example-${index}`,
      manager: "uv",
      managerRoot: ".",
      managerCandidates: ["uv"],
      frameworks: [],
      status: "detected",
      evidence: [],
    });
  }
  const structure = { root, complete: true, projects } as PackagingStructure;
  const targets = await Promise.all(
    projects.map((p) => resolveTypecheckTarget(structure, p.project_id)),
  );
  const policy = resolveTypecheckConfig().policy;
  const signal = new AbortController().signal;
  const context: TypecheckOperationContext = {
    targets,
    policy,
    signal,
    versions: Object.fromEntries(
      projects.map((p) => [p.project_id, { pyright: VERSION }]),
    ),
    changes: [],
  };
  const checkContext = async (index = 0) => {
    const target = targets[index];
    if (!target) throw new Error("Missing fixture target");
    const versions = context.versions[target.project.project_id];
    if (!versions) throw new Error("Missing fixture versions");
    return {
      target,
      policy,
      signal,
      versions,
      projection: await pythonAdapter.plan(target, policy, signal),
    };
  };
  return {
    root,
    targets,
    context,
    async prepare() {
      await pythonAdapter.preflight(context);
      await pythonAdapter.prepareBatch(context);
      for (const target of targets)
        await applyProjection(
          await pythonAdapter.plan(target, policy, signal),
          context.changes,
        );
    },
    checkContext,
    async bytes() {
      return Promise.all(
        [
          "pyproject.toml",
          "uv.lock",
          "module.py",
          "pyright.justomp.json",
          ".venv/pyvenv.cfg",
        ].map((p) => readFile(join(root, p), "utf8")),
      );
    },
    dispose: () => rm(root, { recursive: true, force: true }),
  };
}
