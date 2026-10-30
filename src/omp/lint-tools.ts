import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import type { LintCoordinator } from "../lint/coordinator";
import type { PreparationReport } from "../lint/prepare";
import {
  checkLintTarget,
  inspectLintProject,
  lintFailure,
} from "../lint/service";
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
async function waitForPreparation(
  job: Promise<PreparationReport>,
  signal: AbortSignal,
): Promise<PreparationReport> {
  signal.throwIfAborted();
  let onAbort = () => {};
  const abort = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([job, abort]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}
export function registerLintTools(
  pi: ExtensionAPI,
  withRoot: WithSessionRoot,
  coordinatorFor: (
    root: string,
    ctx: ExtensionContext,
  ) => Promise<LintCoordinator>,
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
    name: "project_lint",
    label: "Check project lint and formatting",
    description:
      "Run lint and format checks for one project_id from list_projects. May prepare or repair native dev tools and distribute shared .justomp/config.json policy first. A newly discovered Python project aligns Ruff across all Python projects. Reports setup effects separately; checks do not fix source files. No ecosystem, manager or command input.",
    parameters,
    approval: "exec",
    async execute(_callId, input, signal, onUpdate, ctx) {
      try {
        const { project_id } = parameters.parse(input);
        return await withRoot(ctx.cwd, signal, async (root, activeSignal) => {
          const target = await inspectLintProject(
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
                    "Waiting for verified lint tools and shared policy. Setup may affect other projects; Python discovery aligns every Python project.",
                },
              }),
            );
            report = await waitForPreparation(
              coordinator.reconcile(),
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
          return response(await checkLintTarget(target, activeSignal, report));
        });
      } catch (error) {
        return response(lintFailure(error, signal));
      }
    },
  });
}
