import { expect, spyOn, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import { type LintCoordinator } from "../../../src/lint/coordinator";
import { type PreparationReport } from "../../../src/lint/prepare";
import * as service from "../../../src/lint/service";
import { registerLintTools } from "../../../src/omp/lint-tools";
import { target } from "../checks/fixture";

for (const publishCurrent of [false, true]) {
  test(`lint cancellation ignores replay and preserves current effects: ${publishCurrent}`, async () => {
    const selected = target("python");
    const controller = new AbortController();
    const stopped: string[] = [];
    const report: PreparationReport = {
      status: "ready",
      action: "already-ready",
      complete: true,
      cancelled: false,
      tools: {},
      affected_projects: [],
      changes: [],
      projects: {},
      errors: [{ code: "old-report", message: "Previous job" }],
    };
    let listener: ((value: PreparationReport) => void) | undefined;
    const coordinator = {
      preparing: true,
      subscribe(callback: (value: PreparationReport) => void) {
        callback(report);
        listener = callback;
        return () => {
          stopped.push("report");
        };
      },
      subscribeProgress() {
        return () => {
          stopped.push("progress");
        };
      },
      reconcile() {
        if (publishCurrent) {
          listener?.({ ...report, errors: [{ code: "current-effect", message: "This job" }] });
        }
        return Promise.resolve().then(() => {
          controller.abort(new Error("Cancelled"));
          throw controller.signal.reason;
        });
      },
    } as unknown as LintCoordinator;
    const inspect = spyOn(service, "inspectLintProject").mockResolvedValue(selected);
    const check = spyOn(service, "checkLintTarget").mockImplementation((_target, _signal, preparation) =>
      Promise.resolve({ success: false, preparation } as unknown as Awaited<
        ReturnType<typeof service.checkLintTarget>
      >),
    );
    let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    try {
      registerLintTools(
        {
          zod,
          registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
            definition = tool;
          },
        } as ExtensionAPI,
        (root, _signal, work) => work(root, controller.signal),
        () => Promise.resolve(coordinator),
      );
      if (!definition) {
        throw new Error("Lint tool missing");
      }
      const result = await definition.execute(
        "cancel",
        { project_id: selected.project.project_id },
        undefined,
        undefined,
        { cwd: selected.root } as ExtensionContext,
      );
      expect(result.details).toMatchObject({
        preparation: {
          complete: false,
          cancelled: true,
          action: "waited",
          errors: [
            ...(publishCurrent ? [{ code: "current-effect", message: "This job" }] : []),
            {
              code: "cancelled",
              message: expect.any(String),
            },
          ],
        },
      });
      expect(stopped).toEqual(["report", "progress"]);
      expect(check).toHaveBeenCalledTimes(1);
    } finally {
      inspect.mockRestore();
      check.mockRestore();
    }
  });
}
