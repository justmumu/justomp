import type { PrepushResult, PushCheckStage, PushStage } from "./model";
export interface PushPorts {
  dependencyKey(id: string): string;
  prepare(): Promise<PushStage>;
  run(stage: PushCheckStage, id: string): Promise<PushStage>;
}
export function emptyPushResult(): PrepushResult {
  return {
    success: false,
    complete: false,
    cancelled: false,
    summary: "incomplete",
    selected_projects: [],
    stages: [],
    changed_files: [],
    errors: [],
  };
}
/** All dependency checks precede preparation, which can update sibling locks. */
export async function runPushGate(
  ids: string[],
  ports: PushPorts,
  signal: AbortSignal,
  result = emptyPushResult(),
): Promise<PrepushResult> {
  result.selected_projects = [...ids];
  const accept = (outcome: PushStage) => {
    result.stages.push(outcome);
    result.changed_files = [
      ...new Set([...result.changed_files, ...outcome.effects]),
    ];
    signal.throwIfAborted();
    if (!outcome.complete || !outcome.success) {
      result.complete = outcome.complete;
      result.summary = outcome.complete ? "failed" : "incomplete";
      result.errors.push(
        `${outcome.project_id ?? "repository"}: ${outcome.stage} ${outcome.complete ? "failed" : "incomplete"}; inspect stage details`,
      );
      return false;
    }
    return true;
  };
  try {
    signal.throwIfAborted();
    const checked = new Set<string>();
    for (const id of ids) {
      const key = ports.dependencyKey(id);
      if (checked.has(key)) continue;
      signal.throwIfAborted();
      if (!accept(await ports.run("dependency", id))) return result;
      checked.add(key);
    }
    if (ids.length && !accept(await ports.prepare())) return result;
    for (const id of ids) {
      for (const stage of ["format", "lint", "typecheck", "unit"] as const) {
        signal.throwIfAborted();
        if (!accept(await ports.run(stage, id))) return result;
      }
    }
    result.complete = true;
    result.success = true;
    result.summary = ids.length ? "passed" : "no-projects";
  } catch (error) {
    result.success = false;
    result.complete = false;
    result.summary = "incomplete";
    result.errors.push(error instanceof Error ? error.message : String(error));
  } finally {
    result.cancelled = signal.aborted;
  }
  return result;
}
