import type { GateCheckStage, GateStage, PrecommitResult } from "./model";

export interface GatePorts {
  run(stage: GateCheckStage, id: string): Promise<GateStage>;
  observe(paths: string[]): Promise<void>;
  verify(): Promise<void>;
  stage(): Promise<string[]>;
  whitespace(): Promise<boolean>;
  dependencyKey(id: string): string;
}
export function emptyResult(): PrecommitResult {
  return {
    success: false,
    complete: false,
    cancelled: false,
    selected_projects: [],
    preparation_projects: [],
    stages: [],
    changed_files: [],
    staged_files: [],
    errors: [],
  };
}
/** Service orchestration only: native tools, Git and effect observation are boundary ports. */
export async function runGate(
  ids: string[],
  ports: GatePorts,
  signal: AbortSignal,
  result = emptyResult(),
): Promise<PrecommitResult> {
  const checkedDependencies = new Set<string>();
  try {
    let failed = false;
    for (const stage of [
      "fix",
      "format",
      "lint",
      "typecheck",
      "dependency",
    ] as const) {
      for (const id of ids) {
        signal.throwIfAborted();
        await ports.verify();
        if (stage === "dependency") {
          const key = ports.dependencyKey(id);
          if (checkedDependencies.has(key)) continue;
          checkedDependencies.add(key);
        }
        const outcome = await ports.run(stage, id);
        result.stages.push(outcome);
        result.changed_files = [
          ...new Set([...result.changed_files, ...outcome.effects]),
        ];
        await ports.observe(outcome.effects);
        signal.throwIfAborted();
        if (!outcome.complete)
          throw new Error(
            `${id}: ${stage} did not complete; inspect stage details`,
          );
        if (
          outcome.affected_projects.some((affected) => !ids.includes(affected))
        )
          throw new Error(
            "Preparation changed another project after selection; retry commit",
          );
        if (!outcome.success) {
          failed = true;
          break;
        }
      }
      if (failed) break;
    }
    signal.throwIfAborted();
    await ports.verify();
    result.staged_files = await ports.stage();
    signal.throwIfAborted();
    const whitespace = await ports.whitespace();
    if (!whitespace) result.errors.push("git diff --cached --check failed");
    result.complete = true;
    result.success = !failed && whitespace;
  } catch (error) {
    result.errors.push(error instanceof Error ? error.message : String(error));
  }
  result.cancelled = signal.aborted;
  if (result.cancelled) {
    result.complete = false;
    result.success = false;
  }
  return result;
}
