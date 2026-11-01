import { join } from "node:path";
import { loadConfig } from "../config/load";
import { adapters, executeDependency } from "../dependencies/index";
import { formatProject } from "../format/service";
import { prepareLint } from "../lint/prepare";
import {
  checkProjectLint,
  fixProjectLintOnly,
  lintAdapters,
} from "../lint/service";
import { prepareTypecheck } from "../typecheck/prepare";
import {
  checkTypecheckTarget,
  inspectTypecheckProject,
  typecheckAdapters,
} from "../typecheck/service";
import type { GateCheckStage, GateStage } from "./model";

export interface GateOperations {
  prepare(root: string, signal: AbortSignal): Promise<GateStage>;
  run(
    stage: GateCheckStage,
    root: string,
    id: string,
    signal: AbortSignal,
  ): Promise<GateStage>;
}
export const nativeOperations: GateOperations = {
  async prepare(root, signal) {
    const config = await loadConfig(root, { flush: true, signal });
    const lint = await prepareLint(root, lintAdapters, signal);
    const types = await prepareTypecheck(root, typecheckAdapters, signal);
    return {
      stage: "preparation",
      success: lint.complete && types.complete,
      complete: lint.complete && types.complete,
      effects: [
        ...(config.wrote ? [".justomp/config.json"] : []),
        ...lint.changes.map((c) => c.path),
        ...types.changes.map((c) => c.path),
      ],
      affected_projects: [
        ...lint.changes.map((c) => c.project_id),
        ...types.changes.map((c) => c.project_id),
      ],
      details: { lint, typecheck: types },
    };
  },
  async run(stage, root, id, signal) {
    const base = {
      stage,
      project_id: id,
      effects: [] as string[],
      affected_projects: [] as string[],
    };
    if (stage === "fix") {
      const fix = await fixProjectLintOnly(root, id, signal);
      const complete =
        fix.observation_complete && !fix.errors.length && !fix.cancelled;
      return {
        ...base,
        success: complete,
        complete,
        effects: fix.changed_files,
        details: fix,
      };
    }
    if (stage === "format") {
      const result = await formatProject(root, id, { signal });
      return {
        ...base,
        success: result.success,
        complete: result.complete,
        effects: [
          ...result.preparation_changes.map((c) => c.path),
          ...result.files
            .filter((f) => f.status === "changed" || f.changed)
            .map((f) => join(result.relative_path ?? ".", f.path)),
        ],
        affected_projects: result.preparation_changes.map((c) => c.project_id),
        details: result,
      };
    }
    if (stage === "lint") {
      const result = await checkProjectLint(root, id, signal);
      return {
        ...base,
        success: result.success,
        complete: result.complete,
        details: result,
      };
    }
    if (stage === "typecheck") {
      const result = await checkTypecheckTarget(
        await inspectTypecheckProject(root, id, signal),
        signal,
        undefined,
        "prepare",
      );
      return {
        ...base,
        success: result.success,
        complete: result.complete,
        effects: result.preparation.changes.map((c) => c.path),
        affected_projects: result.preparation.changes.map((c) => c.project_id),
        details: result,
      };
    }
    const result = await executeDependency(
      root,
      "sync",
      { project_id: id, check: true },
      adapters,
      signal,
    );
    const steps = "native_steps" in result ? result.native_steps : undefined;
    const complete =
      result.outcome === "success" ||
      (!!steps?.length &&
        steps.every(
          (s) => !s.cancelled && !s.truncated && s.exit_code !== null,
        ) &&
        !("structure_refresh_error" in result));
    return {
      ...base,
      success: result.outcome === "success",
      complete,
      details: result,
    };
  },
};
