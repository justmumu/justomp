import { type ExtensionAPI, type ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { type TestCoordinator, waitForTestPreparation } from "../testing/coordinator";
import { type TestPreparation } from "../testing/model";
import { preparationReport } from "../testing/prepare";
import { parseTestRequest } from "../testing/request";
import { inspectTestProject, runTestTarget, testFailure } from "../testing/service";
import { type WithSessionRoot } from "./dependency-tools";

function response<T extends object>(result: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    details: result,
    ...("success" in result && result.success === false ? { isError: true } : {}),
  };
}
export function registerTestTools(
  pi: ExtensionAPI,
  withRoot: WithSessionRoot,
  coordinatorFor: (root: string, ctx: ExtensionContext) => Promise<TestCoordinator>,
) {
  for (const suite of ["unit", "integration"] as const) {
    const parameters = pi.zod
      .object({
        project_id: pi.zod.string().min(1).describe("Stable project_id from list_projects."),
        test_files: pi.zod
          .array(pi.zod.string().min(1))
          .min(1)
          .optional()
          .describe(`Exact project-relative ${suite} test files; omission runs the full ${suite} suite.`),
        timeout_seconds: pi.zod
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .describe("Single execution budget after runner setup, default 300 seconds."),
      })
      .strict();
    pi.registerTool({
      name: suite === "unit" ? "project_test" : "project_integration_test",
      label: `Run project ${suite} tests`,
      description:
        suite === "integration"
          ? "Run the selected project’s integration tests with its shared pytest, Vitest, Bun or Go runner. Existing runner setup/teardown runs; services, containers, migrations and shell script wrappers remain the project’s responsibility. Coverage defaults off with minimum 0; full enabled Bun coverage imports owned sources. Exact test_files disables coverage. Unit/integration scope conflicts and missing Go integration tags are errors. Preparation may align shared tools; one timeout covers execution after setup. No retry or fail-fast."
          : "Run selected project's unit tests with pytest, Vitest, Bun or Go. First/new-project preparation aligns shared latest tools and may change other projects' manifests/locks. Full runs enforce configured coverage (default 70%); test_files disables project-wide coverage. Bun full coverage imports all owned sources after tests, executing their import side effects. timeout_seconds covers collection, tests and coverage after setup. No integration tests, source fixes, retry or fail-fast.",
      parameters,
      approval: "exec",
      async execute(_id, input, signal, onUpdate, ctx) {
        try {
          const request = parseTestRequest(parameters.parse(input));
          return await withRoot(ctx.cwd, signal, async (root, activeSignal) => {
            const target = await inspectTestProject(root, request, activeSignal, suite),
              coordinator = await coordinatorFor(root, ctx);
            const report = await preparationForCall(coordinator, activeSignal, onUpdate);
            return response(await runTestTarget(target, request, activeSignal, report, undefined, suite));
          });
        } catch (error) {
          return response(testFailure(error, signal, suite));
        }
      },
    });
  }
}

type ToolUpdate = Parameters<Parameters<ExtensionAPI["registerTool"]>[0]["execute"]>[3];
async function preparationForCall(
  coordinator: TestCoordinator,
  activeSignal: AbortSignal,
  onUpdate: ToolUpdate,
): Promise<TestPreparation> {
  let observed: TestPreparation | undefined;
  const stop = coordinator.subscribeProgress((report) => {
      observed = report;
      onUpdate?.(response({ preparation: report }));
    }),
    stopReport = coordinator.subscribe((report) => {
      observed = report;
    });
  let report: TestPreparation;
  const waited = coordinator.preparing;
  try {
    onUpdate?.(
      response({
        preparation: {
          status: "preparing",
          message: "Waiting for verified test runner tools and shared policy",
        },
      }),
    );
    report = await waitForTestPreparation(coordinator, activeSignal);
    if (waited) {
      report = { ...report, action: "waited" };
    }
  } catch (error) {
    if (!activeSignal.aborted) {
      throw error;
    }
    report = {
      ...(observed ?? preparationReport()),
      status: "preparing",
      action: "waited",
      complete: false,
      cancelled: true,
      errors: [
        ...(observed?.errors ?? []),
        {
          code: "cancelled",
          message:
            "Preparation wait cancelled. Shared setup may continue for another session; its report will contain final effects.",
        },
      ],
    };
  } finally {
    stop();
    stopReport();
  }
  return report;
}
