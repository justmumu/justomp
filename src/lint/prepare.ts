import { lintPolicyKey } from "../config/lint/resolve";
import { loadConfig } from "../config/load";
import { DependencyError, redact } from "../dependencies/model";
import { withDomains } from "../dependencies/queue";
import type { PackagingStructure } from "../inspect/model";
import { getPackagingStructure } from "../packaging/get-structure";
import type {
  LintAdapter,
  LintAdapterRegistry,
  LintCheckContext,
  LintOperationContext,
  ToolVersions,
} from "./adapters/types";
import { LintError, type LintPreparation } from "./model";
import { applyProjection, planProjection } from "./projection";
import { LintStateStore } from "./state";
import { type LintTarget, resolveLintTarget } from "./targets";
import { sameVersions, validateToolVersions } from "./versions";

export interface PreparationProgress {
  ecosystem: "python" | "javascript" | "go";
  affected_projects: string[];
  message: string;
}
export interface PreparationReport extends LintPreparation {
  projects: Record<string, LintPreparation>;
  recovery?: string;
}
function initial(): LintPreparation {
  return {
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
}
export function preparationFailure(error: unknown, project_id?: string) {
  return {
    code:
      error instanceof LintError || error instanceof DependencyError
        ? error.code
        : "preparation-failed",
    message: redact(error instanceof Error ? error.message : String(error)),
    ...(project_id ? { project_id } : {}),
  };
}
async function targets(
  structure: PackagingStructure,
  errors: LintPreparation["errors"],
): Promise<LintTarget[]> {
  const result: LintTarget[] = [];
  for (const project of structure.projects) {
    try {
      result.push(await resolveLintTarget(structure, project.project_id));
    } catch (error) {
      errors.push(preparationFailure(error, project.project_id));
    }
  }
  return result;
}
export function lintDomains(root: string, selected: LintTarget[]): string[] {
  return [
    ...new Set([
      `lint-state:${root}`,
      ...selected.flatMap((target) => target.scope.domains),
      ...(selected.some((t) => t.project.ecosystem === "go")
        ? ["native:golangci-lint"]
        : []),
    ]),
  ].sort();
}
function batches(selected: LintTarget[]): LintTarget[][] {
  const groups = new Map<string, LintTarget[]>();
  for (const target of selected) {
    const key = `${target.project.manager}:${target.scope.owner}`;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  return [...groups.values()];
}
async function checkContext(
  target: LintTarget,
  versions: ToolVersions,
  context: LintOperationContext,
): Promise<LintCheckContext> {
  return {
    target,
    versions,
    policy: context.policy,
    projection: await planProjection(target, context.policy),
    signal: context.signal,
  };
}
async function prepareEcosystem(
  selected: LintTarget[],
  adapter: LintAdapter,
  store: LintStateStore,
  policy: Awaited<ReturnType<typeof loadConfig>>,
  report: PreparationReport,
  signal: AbortSignal,
) {
  const ecosystem = selected[0]?.project.ecosystem;
  if (!ecosystem) return;
  const policyHash = lintPolicyKey(policy.lint[ecosystem]);
  const errorStart = report.errors.length;
  const ids = selected.map((t) => t.project.project_id).sort();
  const state = store.state;
  const python = ecosystem === "python";
  let versions: Record<string, ToolVersions> = {};
  if (python) {
    const wave = state.python;
    const discovered = !wave || ids.some((id) => !wave.projects.includes(id));
    if (discovered) {
      versions = await adapter.resolve(selected, policy.lint, signal);
      const common = validateToolVersions(versions[ids[0] ?? ""]);
      for (const id of ids)
        if (!sameVersions(validateToolVersions(versions[id]), common))
          throw new LintError(
            "version-mismatch",
            "Python discovery must resolve one shared exact toolset",
          );
      state.python = { projects: ids, tools: common, complete: false };
    } else {
      if (!wave) throw new LintError("state-invalid", "Python wave is missing");
      wave.projects = ids;
      versions = Object.fromEntries(ids.map((id) => [id, wave.tools]));
    }
  } else {
    const existing = Object.fromEntries(
      ids
        .filter((id) => state.projects[id])
        .map((id) => [id, state.projects[id]?.tools ?? {}]),
    );
    const needsResolution =
      ecosystem === "javascript"
        ? selected
        : selected.filter((t) => !state.projects[t.project.project_id]);
    const resolved = needsResolution.length
      ? await adapter.resolve(needsResolution, policy.lint, signal, existing)
      : {};
    versions = Object.fromEntries(
      ids.map((id) => [id, validateToolVersions(resolved[id] ?? existing[id])]),
    );
    for (const [id, tools] of Object.entries(existing))
      for (const [name, version] of Object.entries(tools)) {
        if (versions[id]?.[name] !== version)
          throw new LintError(
            "version-mismatch",
            "Policy or environment repair must preserve resolved tool versions",
          );
      }
  }
  signal.throwIfAborted();
  for (const target of selected) {
    const id = target.project.project_id;
    const tools = validateToolVersions(versions[id]);
    const previous = state.projects[id];
    state.projects[id] = {
      ecosystem,
      tools,
      policy_hash: policyHash,
      ready:
        previous?.ready === true &&
        previous.policy_hash === policyHash &&
        sameVersions(previous.tools, tools),
    };
    report.projects[id] = { ...initial(), tools, affected_projects: [id] };
  }
  // Resolved targets survive partial native failures and process restarts.
  await store.save();
  const context: LintOperationContext = {
    targets: selected,
    versions,
    policy: policy.lint,
    signal,
    changes: report.changes,
  };
  let preflightFailed = false;
  try {
    await adapter.preflight(context);
  } catch (error) {
    preflightFailed = true;
    report.errors.push(preparationFailure(error));
    for (const id of ids)
      report.projects[id]?.errors.push(preparationFailure(error, id));
  }
  if (!preflightFailed)
    for (const batch of batches(selected)) {
      try {
        signal.throwIfAborted();
        const stale: LintTarget[] = [];
        let nativeStale = false;
        for (const target of batch) {
          const check = await checkContext(
            target,
            versions[target.project.project_id] ?? {},
            context,
          );
          const ready = await adapter.verify(check);
          nativeStale ||= !ready;
          if (!check.projection.current || !ready) stale.push(target);
        }
        if (!stale.length) continue;
        // Workspace adapters must see every member before resolving shared pins/locks.
        for (const target of batch) {
          const receipt = state.projects[target.project.project_id];
          if (receipt) receipt.ready = false;
          const result = report.projects[target.project.project_id];
          if (result) result.action = "prepared";
        }
        if (python && state.python) state.python.complete = false;
        await store.save();
        if (nativeStale)
          await adapter.prepareBatch({ ...context, targets: batch });
        for (const target of batch) {
          signal.throwIfAborted();
          await applyProjection(
            await planProjection(target, policy.lint),
            report.changes,
          );
        }
      } catch (error) {
        report.errors.push(preparationFailure(error));
        for (const target of batch)
          report.projects[target.project.project_id]?.errors.push(
            preparationFailure(error, target.project.project_id),
          );
      }
    }
  // Verify every member, including effects completed before a later native failure.
  let verified = true;
  for (const target of selected) {
    const id = target.project.project_id;
    const receipt = state.projects[id];
    const result = report.projects[id];
    if (!receipt || !result) continue;
    try {
      signal.throwIfAborted();
      const currentPolicy = await loadConfig(target.root, { signal });
      if (lintPolicyKey(currentPolicy.lint[ecosystem]) !== policyHash)
        throw new LintError(
          "policy-changed",
          "Lint policy changed during preparation; reconcile again",
        );
      const check = await checkContext(target, receipt.tools, context);
      receipt.ready =
        !preflightFailed &&
        check.projection.current &&
        (await adapter.verify(check));
      if (!receipt.ready)
        throw new LintError(
          "not-ready",
          `Native lint environment is not ready: ${id}`,
        );
    } catch (error) {
      receipt.ready = false;
      verified = false;
      result.errors.push(preparationFailure(error, id));
      result.cancelled = signal.aborted;
      result.complete = false;
      result.status = "failed";
    }
    if (result.errors.length) {
      result.complete = false;
      result.status = "failed";
    }
  }
  if (python && state.python) {
    // A previous partial wave is complete only after all current members verify.
    state.python.complete =
      verified &&
      !signal.aborted &&
      report.errors.length === errorStart &&
      !report.errors.some((error) => error.project_id?.startsWith("python:"));
    if (!state.python.complete)
      for (const id of ids) {
        const result = report.projects[id];
        if (result) {
          result.complete = false;
          result.status = "failed";
          result.errors.push({
            code: "incomplete-python-wave",
            message: "Python version alignment wave is incomplete",
            project_id: id,
          });
        }
      }
  }
  await store.save();
}
/** Owns the union lease once; native adapters must not call executeDependency. */
export async function prepareLint(
  root: string,
  adapters: LintAdapterRegistry,
  signal: AbortSignal,
  onProgress?: (progress: PreparationProgress) => void,
): Promise<PreparationReport> {
  for (;;) {
    signal.throwIfAborted();
    const before = await getPackagingStructure(root, { signal });
    const domains = lintDomains(
      before.structure.root,
      await targets(before.structure, []),
    );
    const result = await withDomains(domains, signal, async () => {
      const report: PreparationReport = { ...initial(), projects: {} };
      const { structure } = await getPackagingStructure(root, {
        refresh: true,
        signal,
      });
      const selected = await targets(structure, report.errors);
      if (
        JSON.stringify(lintDomains(structure.root, selected)) !==
        JSON.stringify(domains)
      )
        return undefined;
      const policy = await loadConfig(structure.root, { signal });
      const store = await LintStateStore.load(structure.root);
      if (store.recovery) report.recovery = store.recovery;
      const live = new Set(structure.projects.map((p) => p.project_id));
      for (const id of Object.keys(store.state.projects))
        if (!live.has(id)) delete store.state.projects[id];
      if (store.state.python) {
        store.state.python.projects = store.state.python.projects.filter((id) =>
          live.has(id),
        );
        if (!store.state.python.projects.length) delete store.state.python;
      }
      for (const ecosystem of ["python", "javascript", "go"] as const) {
        const group = selected.filter((t) => t.project.ecosystem === ecosystem);
        if (!group.length) continue;
        try {
          signal.throwIfAborted();
          const adapter = adapters[ecosystem];
          if (!adapter)
            throw new LintError(
              "unsupported-ecosystem",
              `No lint adapter registered for ${ecosystem}`,
            );
          try {
            onProgress?.({
              ecosystem,
              affected_projects: group.map((t) => t.project.project_id),
              message:
                ecosystem === "python"
                  ? "Checking Python lint preparation. New Python projects align Ruff across every Python project before checks."
                  : `Checking ${ecosystem} lint preparation; required tools and shared configuration may be installed or repaired.`,
            });
          } catch {
            /* Reporting cannot cancel preparation. */
          }
          await prepareEcosystem(group, adapter, store, policy, report, signal);
        } catch (error) {
          for (const target of group) {
            const id = target.project.project_id;
            const receipt = store.state.projects[id];
            if (receipt) receipt.ready = false;
            report.projects[id] = {
              ...initial(),
              status: "failed",
              complete: false,
              errors: [preparationFailure(error, id)],
            };
          }
          if (ecosystem === "python" && store.state.python)
            store.state.python.complete = false;
          report.errors.push(preparationFailure(error));
        }
      }
      try {
        await store.save();
      } catch (error) {
        report.errors.push(preparationFailure(error));
      }
      for (const [id, project] of Object.entries(report.projects)) {
        project.changes = report.changes.filter(
          (change) => change.project_id === id,
        );
        report.errors.push(...project.errors);
        Object.assign(report.tools, project.tools);
      }
      report.affected_projects = selected.map((t) => t.project.project_id);
      report.cancelled = signal.aborted;
      report.complete =
        !report.cancelled &&
        !report.errors.length &&
        Object.values(report.projects).every((p) => p.complete);
      report.status = report.complete ? "ready" : "failed";
      report.action = Object.values(report.projects).some(
        (p) => p.action === "prepared",
      )
        ? "prepared"
        : "already-ready";
      return report;
    });
    if (result) return result;
  }
}
