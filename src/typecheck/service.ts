import { loadConfig } from "../config/load";
import { typecheckPolicyKey } from "../config/typecheck/resolve";
import { getPackagingStructure } from "../packaging/get-structure";
import { goAdapter } from "./adapters/go";
import { javascriptAdapter } from "./adapters/javascript";
import { pythonAdapter } from "./adapters/python";
import { type TypecheckCheckContext } from "./adapters/types";
import { withReadyTypecheckTarget } from "./coordinator";
import { fingerprintTypecheckSources } from "./freshness";
import { withJavascriptTypes } from "./javascript/prepare-types";
import { type TypecheckCheck, TypecheckError, type TypecheckPreparation, type TypecheckResult } from "./model";
import { type PreparationReport, preparationFailure, prepareTypecheck } from "./prepare";
import { mergePreparation, publicPreparation, typecheckResult } from "./result";
import { TypecheckStateStore } from "./state";
import { resolveTypecheckTarget, type TypecheckTarget } from "./targets";

export const typecheckAdapters = {
  python: pythonAdapter,
  javascript: javascriptAdapter,
  go: goAdapter,
};
/** Fresh identity validation precedes configuration publication or any native setup. */
export async function inspectTypecheckProject(
  root: string,
  projectId: string,
  signal?: AbortSignal,
): Promise<TypecheckTarget> {
  if (typeof projectId !== "string" || !projectId.trim()) {
    throw new TypecheckError("invalid-input", "project_id is required");
  }
  return resolveTypecheckTarget(
    (
      await getPackagingStructure(root, {
        signal,
        refresh: true,
        publish: false,
      })
    ).structure,
    projectId,
  );
}
export function typecheckFailure(error: unknown, signal?: AbortSignal) {
  return {
    success: false,
    complete: false,
    cancelled: signal?.aborted ?? false,
    error: preparationFailure(error),
  };
}
/** Source closure is freshness evidence only; dependencies are never extra check targets. */
async function sourceTargets(target: TypecheckTarget): Promise<TypecheckTarget[]> {
  const ids = new Set([target.project.project_id]);
  if (target.project.ecosystem !== "javascript") {
    for (const project of target.structure.projects) {
      if (
        project.ecosystem !== target.project.ecosystem ||
        project.manager !== target.project.manager ||
        project.managerRoot !== target.project.managerRoot
      ) {
        continue;
      }
      const member = await resolveTypecheckTarget(target.structure, project.project_id);
      if (member.scope.owner === target.scope.owner) {
        ids.add(project.project_id);
      }
    }
  }
  for (const id of ids) {
    for (const edge of target.structure.localDependencies) {
      if (edge.from === id) {
        ids.add(edge.to);
      }
    }
  }
  return Promise.all([...ids].map((id) => resolveTypecheckTarget(target.structure, id)));
}
async function runTarget(
  target: TypecheckTarget,
  signal: AbortSignal,
  report: PreparationReport | undefined,
  mode: "prepare" | "check-only",
  check: boolean,
) {
  const id = target.project.project_id;
  let preparation = publicPreparation(target.project.project_id, report),
    checks: TypecheckCheck[] = [],
    policyHash = "",
    ready = false,
    failure: string | undefined;
  try {
    signal.throwIfAborted();
    const config = await loadConfig(target.root, { signal, flush: false });
    policyHash = typecheckPolicyKey(config.typecheck[target.project.ecosystem]);
    if (!report) {
      preparation.tools = {
        ...(await TypecheckStateStore.load(target.root)).state.projects[id]?.tools,
      };
    }
    const operation = async (context: TypecheckCheckContext) => {
      policyHash = typecheckPolicyKey(context.policy[context.target.project.ecosystem]);
      preparation.tools = { ...context.versions };
      if (!check) {
        return;
      }
      const sources = await sourceTargets(context.target);
      const before = await fingerprintTypecheckSources(sources);
      checks = await typecheckAdapters[context.target.project.ecosystem].check(context);
      signal.throwIfAborted();
      if (before !== (await fingerprintTypecheckSources(sources))) {
        throw new TypecheckError(
          "sources-changed",
          "Project or required dependency sources/metadata changed during the check; rerun typecheck",
        );
      }
    };
    if (target.project.ecosystem === "javascript") {
      const generated = await withJavascriptTypes(target.root, id, typecheckAdapters, mode, operation, signal);
      preparation = mergePreparation(preparation, generated.preparation, !!report);
      ready = generated.ready;
      if (!ready) {
        failure =
          generated.preparation.errors.map((e) => e.message).join("; ") || "Required generated types are not ready";
      }
    } else {
      await withReadyTypecheckTarget(target.root, id, typecheckAdapters, operation, signal);
      ready = true;
      if (!report) {
        preparation = {
          ...preparation,
          status: "ready",
          action: "already-ready",
          complete: true,
        };
      }
    }
  } catch (error) {
    const issue = preparationFailure(error, id);
    preparation.errors.push(issue);
    failure = issue.message;
    if (!report) {
      preparation = {
        ...preparation,
        status: "failed",
        complete: false,
        cancelled: signal.aborted,
      };
    }
  }
  return { preparation, checks, policyHash, ready, failure };
}
/** Internal host entry: retain selected identity and known setup effects after cancellation. */
export async function checkTypecheckTarget(
  target: TypecheckTarget,
  signal: AbortSignal,
  report?: PreparationReport,
  mode: "prepare" | "check-only" = "check-only",
): Promise<TypecheckResult> {
  const result = await runTarget(target, signal, report, mode, true);
  return typecheckResult(target.project, result, signal.aborted);
}

async function setup(target: TypecheckTarget, signal: AbortSignal) {
  await loadConfig(target.root, { flush: true, signal });
  return prepareTypecheck(target.root, typecheckAdapters, signal);
}
/** Selected readiness includes its required generated closure. Errors/effects still include
 * other ecosystems; unlike this selected result, embedded check preparation.complete
 * describes the aggregate setup wave. Top-level check complete describes the selected check. */
export async function prepareProjectTypecheck(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<TypecheckPreparation> {
  const target = await inspectTypecheckProject(root, projectId, signal);
  const report = await setup(target, signal);
  const result = await runTarget(target, signal, report, "prepare", false);
  return {
    ...result.preparation,
    complete: result.ready,
    status: result.ready ? "ready" : "failed",
  };
}
/** Read-only: no installation, defaults flush, generation, state save or snapshot publication. */
export async function checkProjectTypecheck(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<TypecheckResult> {
  return checkTypecheckTarget(await inspectTypecheckProject(root, projectId, signal), signal);
}
/** Full selected-project operation: prepare tools, policy and required types, then check. */
export async function typecheckProject(
  root: string,
  projectId: string,
  signal = new AbortController().signal,
): Promise<TypecheckResult> {
  const target = await inspectTypecheckProject(root, projectId, signal);
  return checkTypecheckTarget(target, signal, await setup(target, signal), "prepare");
}
