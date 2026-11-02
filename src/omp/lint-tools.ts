import { type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type LintCoordinator } from "../lint/coordinator";
import { pendingLintFix } from "../lint/fix";
import { type PreparationReport } from "../lint/prepare";
import { checkLintTarget, fixLintTarget, inspectLintProject, lintFailure } from "../lint/service";
import { type WithSessionRoot } from "./dependency-tools";

function response<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    ...("success" in result && result.success === false ? { isError: true } : {}),
  };
}
async function waitForPreparation(job: Promise<PreparationReport>, signal: AbortSignal): Promise<PreparationReport> {
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
  coordinatorFor: (root: string, ctx: ExtensionContext) => Promise<LintCoordinator>,
): void {
  const parameters = pi.zod
    .object({
      project_id: pi.zod.string().min(1).describe("Stable project_id from list_projects."),
      fix: pi.zod
        .boolean()
        .optional()
        .describe("Apply supported lint fixes before checking; defaults to false. Formatting remains check-only."),
    })
    .strict();
  pi.registerTool({
    name: "project_lint",
    label: "Check or fix project lint",
    description:
      "Run lint and format checks for one project_id from list_projects. May prepare or repair native dev tools and distribute shared .justomp/config.json policy first. A newly discovered project selects latest lint tools and aligns existing consumers in its ecosystem; unchanged membership retains exact targets. Latest incompatibility fails without older fallback. Pass fix:true for Ruff or Biome safe-only fixes (including configured import organization; no unsafe fixes). Go reports autofix unsupported and still checks. Formatting is checked, never written; use project_format to format. Reports source changes separately from setup effects, including partial edits on failure. Without fix, checks do not fix source files. No ecosystem, manager or command input.",
    parameters,
    approval: "exec",
    async execute(_callId, input, signal, onUpdate, ctx) {
      let requestedFix = false;
      let effectiveSignal = signal;
      try {
        const { project_id, fix = false } = parameters.parse(input);
        requestedFix = fix;
        return await withRoot(ctx.cwd, signal, async (root, activeSignal) => {
          effectiveSignal = activeSignal;
          const target = await inspectLintProject(root, project_id, activeSignal);
          const coordinator = await coordinatorFor(root, ctx);
          let observed: PreparationReport | undefined;
          // subscribe replays the last completed job; it is not evidence for this wait.
          let replay = true;
          const stopReport = coordinator.subscribe((report) => {
            if (!replay) {
              observed = report;
            }
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
                    "Waiting for verified lint tools and shared policy. Setup may affect other projects; new projects align latest tools across their ecosystem.",
                },
              }),
            );
            report = await waitForPreparation(coordinator.reconcile(), activeSignal);
            if (waited) {
              report = { ...report, action: "waited" };
            }
          } catch (error) {
            if (!activeSignal.aborted) {
              throw error;
            }
            report = {
              ...(observed ?? {
                tools: {},
                affected_projects: target.structure.projects.map((p) => p.project_id),
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
          return response(await (fix ? fixLintTarget : checkLintTarget)(target, activeSignal, report));
        });
      } catch (error) {
        const failure = lintFailure(error, effectiveSignal);
        if (!requestedFix) {
          return response(failure);
        }
        const fix = pendingLintFix();
        fix.errors.push(failure.error);
        if (failure.cancelled) {
          fix.status = "cancelled";
          fix.cancelled = true;
        }
        return response({ ...failure, fix });
      }
    },
  });
}
