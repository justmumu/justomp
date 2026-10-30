import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import {
  type TypecheckCoordinator,
  waitForTypecheckPreparation,
} from "../typecheck/coordinator";
import type { PreparationReport } from "../typecheck/prepare";
import {
  checkTypecheckTarget,
  inspectTypecheckProject,
  typecheckFailure,
} from "../typecheck/service";
import type { WithSessionRoot } from "./dependency-tools";

function response<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    ...("success" in result && result.success === false
      ? { isError: true }
      : {}),
  };
}
export function registerTypecheckTools(
  pi: ExtensionAPI,
  withRoot: WithSessionRoot,
  coordinatorFor: (
    root: string,
    ctx: ExtensionContext,
  ) => Promise<TypecheckCoordinator>,
): void {
  const parameters = pi.zod
    .object({
      project_id: pi.zod
        .string()
        .min(1)
        .describe("Stable project_id from list_projects."),
    })
    .strict();
  pi.registerTool({
    name: "project_typecheck",
    label: "Check project types",
    description:
      "Run native typechecking for one project_id, including source and tests. Prepares shared policy, common latest Pyright/TypeScript tools and required Next/local declarations. Go packages and tests are compiled without execution. Reports setup effects and diagnostics; does not fix application source. No ecosystem, manager or command input.",
    parameters,
    approval: "exec",
    async execute(_callId, input, signal, onUpdate, ctx) {
      try {
        const { project_id } = parameters.parse(input);
        return await withRoot(ctx.cwd, signal, async (root, activeSignal) => {
          const target = await inspectTypecheckProject(
            root,
            project_id,
            activeSignal,
          );
          const coordinator = await coordinatorFor(root, ctx);
          let observed: PreparationReport | undefined;
          // subscribe replays the last completed job; it is not evidence for this wait.
          let replay = true;
          const stopReport = coordinator.subscribe((report) => {
            if (!replay) observed = report;
          });
          replay = false;
          const stopProgress = coordinator.subscribeProgress((progress) => {
            onUpdate?.(response({ preparation: progress }));
          });
          const waited = coordinator.preparing;
          let report: PreparationReport;
          try {
            onUpdate?.(
              response({
                preparation: {
                  status: "preparing",
                  message:
                    "Waiting for verified typecheck tools and shared policy. Setup may affect other projects; discovery aligns Pyright/TypeScript within each ecosystem.",
                },
              }),
            );
            report = await waitForTypecheckPreparation(
              coordinator,
              activeSignal,
            );
            if (waited) report = { ...report, action: "waited" };
          } catch (error) {
            if (!activeSignal.aborted) throw error;
            report = {
              ...(observed ?? {
                tools: {},
                affected_projects: target.structure.projects.map(
                  (p) => p.project_id,
                ),
                changes: [],
                diagnostics: [],
                projects: {},
                errors: [],
              }),
              status: "preparing",
              action: "waited",
              complete: false,
              cancelled: true,
              errors: [
                ...(observed?.errors ?? []),
                {
                  code: "cancelled",
                  message:
                    "Preparation wait cancelled. Shared background setup may continue for another active session; consult its setup report for final effects.",
                },
              ],
            };
          } finally {
            stopReport();
            stopProgress();
          }
          return response(
            await checkTypecheckTarget(target, activeSignal, report, "prepare"),
          );
        });
      } catch (error) {
        return response(typecheckFailure(error, signal));
      }
    },
  });
}
