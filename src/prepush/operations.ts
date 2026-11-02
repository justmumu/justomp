import { loadConfig } from "../config/load";
import { checkProjectFormat } from "../format/check";
import { prepareLint } from "../lint/prepare";
import { lintAdapters } from "../lint/service";
import { nativeOperations } from "../precommit/operations";
import { type TestPreparation } from "../testing/model";
import { prepareTests } from "../testing/prepare";
import { parseTestRequest } from "../testing/request";
import { inspectTestProject, runTestTarget, testAdapters } from "../testing/service";
import { prepareTypecheck } from "../typecheck/prepare";
import { typecheckAdapters } from "../typecheck/service";
import { type PushCheckStage, type PushStage } from "./model";

export interface PushOperations {
  prepare(root: string, signal: AbortSignal): Promise<PushStage>;
  run(stage: PushCheckStage, root: string, id: string, signal: AbortSignal): Promise<PushStage>;
}
/** A preparation report belongs to one invocation, never another concurrent push. */
export function createPushOperations(): PushOperations {
  let tests: TestPreparation | undefined;
  return {
    async prepare(root, signal) {
      const config = await loadConfig(root, { flush: true, signal });
      const lint = await prepareLint(root, lintAdapters, signal);
      const stage: PushStage = {
        stage: "preparation",
        success: false,
        complete: false,
        effects: [...(config.wrote ? [".justomp/config.json"] : []), ...lint.changes.map((c) => c.path)],
        details: { lint },
      };
      if (!lint.complete) {
        return stage;
      }
      const typecheck = await prepareTypecheck(root, typecheckAdapters, signal);
      stage.effects.push(...typecheck.changes.map((c) => c.path));
      stage.details = { lint, typecheck };
      if (!typecheck.complete) {
        return stage;
      }
      tests = await prepareTests(root, testAdapters, signal);
      stage.effects.push(...tests.changes.map((c) => c.path));
      stage.details = { lint, typecheck, tests };
      stage.success = tests.complete;
      stage.complete = tests.complete;
      return stage;
    },
    async run(stage, root, id, signal) {
      if (stage === "format") {
        const result = await checkProjectFormat(root, id, signal);
        return {
          stage,
          project_id: id,
          success: result.success,
          complete: result.complete,
          effects: [],
          details: result,
        };
      }
      if (stage !== "unit") {
        return nativeOperations.run(stage, root, id, signal);
      }
      if (!tests) {
        throw new Error("Unit test preparation has not completed");
      }
      const request = parseTestRequest({ project_id: id });
      const result = await runTestTarget(await inspectTestProject(root, request, signal), request, signal, tests);
      return {
        stage,
        project_id: id,
        success: result.success,
        complete: result.complete,
        effects: result.preparation?.changes.map((c) => c.path) ?? [],
        details: result,
      };
    },
  };
}
