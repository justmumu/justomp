import { expect, spyOn, test } from "bun:test";
import { type ExtensionAPI, type ExtensionContext, zod } from "@oh-my-pi/pi-coding-agent";
import * as service from "../../../src/lint/service";
import { registerLintTools } from "../../../src/omp/lint-tools";
import { target } from "../checks/fixture";

for (const phase of ["inspection", "coordinator"] as const) {
  test(`session cancellation during ${phase} preserves the fix cancellation result`, async () => {
    const session = new AbortController();
    const caller = new AbortController();
    const selected = target("python");
    const abort = () => {
      session.abort(new Error("Session closed"));
      throw session.signal.reason;
    };
    const inspect = spyOn(service, "inspectLintProject").mockImplementation(async () => {
      if (phase === "inspection") {
        abort();
      }
      return selected;
    });
    let definition: Parameters<ExtensionAPI["registerTool"]>[0] | undefined;
    const api = {
      zod,
      registerTool(tool: Parameters<ExtensionAPI["registerTool"]>[0]) {
        definition = tool;
      },
    } as ExtensionAPI;
    try {
      registerLintTools(
        api,
        async (root, signal, operation) =>
          operation(root, AbortSignal.any([session.signal, ...(signal ? [signal] : [])])),
        async () => abort(),
      );
      if (!definition) {
        throw new Error("Missing registered lint tool");
      }
      const result = await definition.execute(
        "cancel",
        { project_id: selected.project.project_id, fix: true },
        caller.signal,
        undefined,
        { cwd: selected.root } as ExtensionContext,
      );
      expect(caller.signal.aborted).toBe(false);
      expect(result.details).toMatchObject({
        success: false,
        complete: false,
        cancelled: true,
        fix: { requested: true, status: "cancelled", changed_files: [] },
      });
    } finally {
      inspect.mockRestore();
    }
  });
}
