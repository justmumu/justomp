import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  adapters,
  executeDependency,
  listProjects,
  type Operation,
  schemas,
} from "../dependencies";

export type WithSessionRoot = <T>(
  root: string,
  signal: AbortSignal | undefined,
  work: (root: string, signal: AbortSignal) => Promise<T>,
) => Promise<T>;

function failure(error: unknown, signal?: AbortSignal) {
  return {
    outcome: signal?.aborted ? "cancelled" : "rejected",
    diagnostics: [
      {
        code:
          error instanceof Error && "code" in error
            ? String(error.code)
            : "dependency-error",
        message: error instanceof Error ? error.message : String(error),
      },
    ],
  };
}
function response(result: object & { outcome?: string }) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    ...(result.outcome && result.outcome !== "success"
      ? { isError: true }
      : {}),
  };
}
const descriptions: Record<Operation, string> = {
  list: "Read dependency inventory and supported groups/capabilities. First call list_projects to choose project_id. Direct declarations are the default; include_transitive requests the native graph and reports incomplete evidence. May execute the installed manager.",
  add: "Add explicit packages using the installed native manager. First use list_projects and dependency_list to choose project_id and a supported explicit group. Registry, Git, root-relative path and workspace sources preserve native meaning. May run native lifecycle scripts and change shared lock/environment metadata.",
  remove:
    "Remove named packages from an explicit group using the installed native manager. First use list_projects and dependency_list. Other groups are preserved or an unsupported capability is reported. May run lifecycle scripts and change shared lock/environment metadata.",
  update:
    "Update a nonempty explicit package list from dependency_list for a project_id from list_projects. Default within_constraints preserves current constraints; latest may rewrite target constraints. Exact version allows downgrade; explicit mode cannot coexist with any version. Optional group disambiguates declarations. Shared-lock resolutions may affect sibling projects.",
  sync: "Synchronize the selected project's native dependency environment without intentional upgrades. First use list_projects and dependency_list. Requires a compatible lock where the manager uses a lock; Go sums are integrity metadata. Preserves native default group selection. May execute lifecycle scripts.",
};
export function registerDependencyTools(
  pi: ExtensionAPI,
  withRoot: WithSessionRoot,
): void {
  pi.registerTool({
    name: "list_projects",
    label: "List projects",
    description:
      "Discover project_id and relative_path pairs in the current session root before using dependency tools. Takes no parameters. Writes the derived packaging snapshot.",
    parameters: schemas.projects,
    approval: "write",
    async execute(_callId, input, signal, _onUpdate, ctx) {
      try {
        return response(
          await withRoot(ctx.cwd, signal, (root, activeSignal) =>
            listProjects(root, input, activeSignal),
          ),
        );
      } catch (error) {
        return response(failure(error, signal));
      }
    },
  });
  for (const operation of [
    "list",
    "add",
    "remove",
    "update",
    "sync",
  ] as const) {
    pi.registerTool({
      name: `dependency_${operation}`,
      label: `Dependency ${operation}`,
      description: descriptions[operation],
      parameters: schemas[operation],
      approval: "exec",
      async execute(_callId, input, signal, _onUpdate, ctx) {
        try {
          return response(
            await withRoot(ctx.cwd, signal, (root, activeSignal) =>
              executeDependency(root, operation, input, adapters, activeSignal),
            ),
          );
        } catch (error) {
          return response(failure(error, signal));
        }
      },
    });
  }
}
