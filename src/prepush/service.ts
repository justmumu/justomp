import { getPackagingStructure } from "../packaging/get-structure";
import { packagingInvocation } from "../packaging/invocation";
import { gitContext, gitlinks } from "../precommit/git";
import { assertWorkspaceBoundary } from "../precommit/workspace";
import type { PrepushResult } from "./model";
import { createPushOperations, type PushOperations } from "./operations";
import { emptyPushResult, runPushGate } from "./pipeline";

export async function runPrepush(
  cwd: string,
  signal = new AbortController().signal,
  operations: PushOperations = createPushOperations(),
): Promise<PrepushResult> {
  const result = emptyPushResult();
  try {
    const context = await gitContext(cwd, signal);
    if (!context) throw new Error("Pre-push requires a Git working tree");
    const excluded = await gitlinks(context);
    return await packagingInvocation.run(
      { root: context.root, excluded },
      async () => {
        const { structure } = await getPackagingStructure(context.root, {
          signal,
          publish: false,
        });
        if (!structure.complete)
          throw new Error("Project inspection incomplete");
        await assertWorkspaceBoundary(context.root, structure, excluded);
        const projects = [...structure.projects].sort((a, b) =>
          a.path.localeCompare(b.path),
        );
        return runPushGate(
          projects.map((p) => p.project_id),
          {
            dependencyKey: (id) => {
              const project = projects.find((p) => p.project_id === id);
              return project &&
                ["uv", "npm", "yarn", "bun"].includes(project.manager ?? "")
                ? `${project.manager}:${project.managerRoot}`
                : id;
            },
            prepare: () => operations.prepare(context.root, signal),
            run: (stage, id) => operations.run(stage, context.root, id, signal),
          },
          signal,
          result,
        );
      },
    );
  } catch (error) {
    result.cancelled = signal.aborted;
    result.errors.push(error instanceof Error ? error.message : String(error));
    return result;
  }
}
