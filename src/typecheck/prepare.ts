import { loadConfig } from "../config/load";
import { typecheckPolicyKey } from "../config/typecheck/resolve";
import { DependencyError, redact } from "../dependencies/model";
import { withDomains } from "../dependencies/queue";
import { type PackagingStructure } from "../inspect/model";
import { type LintState, LintStateStore } from "../lint/state";
import { getPackagingStructure } from "../packaging/get-structure";
import { toolMembership } from "../packaging/tool-membership";
import {
  type ToolVersions,
  type TypecheckAdapter,
  type TypecheckAdapterRegistry,
  type TypecheckOperationContext,
} from "./adapters/types";
import { TypecheckError, type TypecheckPreparation } from "./model";
import { applyProjection } from "./projection";
import { readyTypecheckProjection } from "./readiness";
import { TypecheckStateStore } from "./state";
import { resolveTypecheckTarget, type TypecheckTarget } from "./targets";
import { sameVersions, validateToolVersions } from "./versions";
export interface PreparationProgress {
  ecosystem: "python" | "javascript" | "go";
  affected_projects: string[];
  message: string;
}
export interface PreparationReport extends TypecheckPreparation {
  projects: Record<string, TypecheckPreparation>;
  recovery?: string;
}
function initial(): TypecheckPreparation {
  return {
    status: "ready",
    action: "already-ready",
    tools: {},
    affected_projects: [],
    changes: [],
    diagnostics: [],
    complete: true,
    cancelled: false,
    errors: [],
  };
}
export function preparationFailure(error: unknown, project_id?: string) {
  return {
    code: error instanceof TypecheckError || error instanceof DependencyError ? error.code : "preparation-failed",
    message: redact(error instanceof Error ? error.message : String(error)),
    ...(project_id ? { project_id } : {}),
  };
}
async function targets(
  structure: PackagingStructure,
  errors: TypecheckPreparation["errors"],
): Promise<TypecheckTarget[]> {
  if (!structure.complete) {
    throw new TypecheckError("incomplete-inspection", "Typecheck requires a complete project inspection");
  }
  const result: TypecheckTarget[] = [];
  for (const project of structure.projects) {
    try {
      result.push(await resolveTypecheckTarget(structure, project.project_id));
    } catch (error) {
      errors.push(preparationFailure(error, project.project_id));
    }
  }
  return result;
}
/** Include lint state before any native write: nested acquisition would deadlock. */
export function typecheckDomains(root: string, selected: TypecheckTarget[]): string[] {
  return [
    ...new Set([
      `typecheck-state:${root}`,
      ...selected.flatMap((t) => t.scope.domains),
      ...(selected.some((t) => t.project.ecosystem === "javascript") ? [`lint-state:${root}`] : []),
    ]),
  ].sort();
}
function batches(selected: TypecheckTarget[]): TypecheckTarget[][] {
  const groups = new Map<string, TypecheckTarget[]>();
  for (const target of selected) {
    const key = `${target.project.manager}:${target.scope.owner}`;
    const group = groups.get(key) ?? [];
    group.push(target);
    groups.set(key, group);
  }
  return [...groups.values()];
}
function releaseLintCompiler(state: LintState, id: string): void {
  const receipt = state.projects[id];
  if (receipt) {
    delete receipt.tools.typescript;
  }
  const wave = state.waves.javascript;
  if (wave) {
    wave.complete = false;
    const tools = wave.versions[id];
    if (tools) {
      delete tools.typescript;
    }
  }
}
async function prepareCohort(
  selected: TypecheckTarget[],
  versions: Record<string, ToolVersions>,
  adapter: TypecheckAdapter,
  store: TypecheckStateStore,
  policy: Awaited<ReturnType<typeof loadConfig>>,
  report: PreparationReport,
  signal: AbortSignal,
): Promise<boolean> {
  const ecosystem = selected[0]?.project.ecosystem;
  if (!ecosystem) {
    return true;
  }
  const policyHash = typecheckPolicyKey(policy.typecheck[ecosystem]);
  const context: TypecheckOperationContext = {
    targets: selected,
    versions,
    policy: policy.typecheck,
    signal,
    changes: report.changes,
  };
  for (const target of selected) {
    const id = target.project.project_id;
    const tools = validateToolVersions(versions[id]);
    const previous = store.state.projects[id];
    store.state.projects[id] = {
      ecosystem,
      tools,
      policy_hash: policyHash,
      ready: previous?.ready === true && previous.policy_hash === policyHash && sameVersions(previous.tools, tools),
    };
    report.projects[id] = {
      ...initial(),
      tools,
      affected_projects: [id],
      action: report.projects[id]?.action === "prepared" ? "prepared" : "already-ready",
    };
  }
  await store.save();
  let preflightFailed = false;
  try {
    await adapter.preflight(context);
  } catch (error) {
    preflightFailed = true;
    for (const target of selected) {
      report.projects[target.project.project_id]?.errors.push(preparationFailure(error, target.project.project_id));
    }
  }
  if (!preflightFailed) {
    for (const batch of batches(selected)) {
      let lint: LintStateStore | undefined;
      let nativeStale = false;
      try {
        signal.throwIfAborted();
        for (const target of batch) {
          if (
            !(await adapter.verifyTools({
              target,
              versions: versions[target.project.project_id] ?? {},
              policy: policy.typecheck,
              signal,
            }))
          ) {
            nativeStale = true;
          }
        }
        if (ecosystem === "javascript") {
          lint = await LintStateStore.load(batch[0]?.root ?? "");
          for (const target of batch) {
            const receipt = lint.state.projects[target.project.project_id];
            const desired = versions[target.project.project_id]?.typescript;
            const retained = lint.state.waves.javascript?.versions[target.project.project_id]?.typescript;
            if (
              (receipt?.tools.typescript && receipt.tools.typescript !== desired) ||
              (retained && retained !== desired)
            ) {
              if (receipt) {
                receipt.ready = false;
              }
              if (lint.state.waves.javascript) {
                lint.state.waves.javascript.complete = false;
              }
              if (
                await adapter.verifyTools({
                  target,
                  versions: versions[target.project.project_id] ?? {},
                  policy: policy.typecheck,
                  signal,
                })
              ) {
                releaseLintCompiler(lint.state, target.project.project_id);
              }
            }
          }
          await lint.save();
        }
        if (nativeStale) {
          for (const target of batch) {
            const receipt = store.state.projects[target.project.project_id];
            if (receipt) {
              receipt.ready = false;
            }
            const result = report.projects[target.project.project_id];
            if (result) {
              result.action = "prepared";
            }
          }
          await store.save();
          if (lint) {
            for (const target of batch) {
              const receipt = lint.state.projects[target.project.project_id];
              if (receipt) {
                receipt.ready = false;
              }
            }
            await lint.save();
          }
          await adapter.prepareBatch({ ...context, targets: batch });
        }
        for (const target of batch) {
          signal.throwIfAborted();
          const plan = await adapter.plan(target, policy.typecheck, signal);
          if (!plan.current) {
            const result = report.projects[target.project.project_id];
            if (result) {
              result.action = "prepared";
            }
          }
          await applyProjection(plan, report.changes);
        }
      } catch (error) {
        for (const target of batch) {
          report.projects[target.project.project_id]?.errors.push(preparationFailure(error, target.project.project_id));
        }
      } finally {
        // A partial batch can change TypeScript before a later member fails. Once the
        // new exact native version verifies, lint must no longer own its older pin.
        if (lint && nativeStale) {
          for (const target of batch) {
            try {
              if (
                await adapter.verifyTools({
                  target,
                  versions: versions[target.project.project_id] ?? {},
                  policy: policy.typecheck,
                  signal,
                })
              ) {
                releaseLintCompiler(lint.state, target.project.project_id);
              }
            } catch {
              /* The failed native preparation is reported below. */
            }
          }
        }
        if (lint) {
          await lint.save();
        }
      }
    }
  }
  let verified = !preflightFailed;
  for (const target of selected) {
    const id = target.project.project_id;
    const receipt = store.state.projects[id];
    const result = report.projects[id];
    if (!receipt || !result) {
      continue;
    }
    try {
      signal.throwIfAborted();
      const currentPolicy = await loadConfig(target.root, {
        signal,
        flush: false,
      });
      if (typecheckPolicyKey(currentPolicy.typecheck[ecosystem]) !== policyHash) {
        throw new TypecheckError("policy-changed", "Typecheck policy changed during preparation; reconcile again");
      }
      const toolContext = {
        target,
        versions: receipt.tools,
        policy: policy.typecheck,
        signal,
      };
      receipt.ready = !preflightFailed && Boolean(await readyTypecheckProjection(adapter, toolContext));
      if (!receipt.ready) {
        throw new TypecheckError("not-ready", `Native typecheck environment is not ready: ${id}`);
      }
    } catch (error) {
      receipt.ready = false;
      result.errors.push(preparationFailure(error, id));
    }
    if (result.errors.length || !receipt.ready) {
      verified = false;
      result.complete = false;
      result.status = "failed";
      result.cancelled = signal.aborted;
    }
  }
  await store.save();
  return verified;
}
async function prepareEcosystem(
  selected: TypecheckTarget[],
  adapter: TypecheckAdapter,
  store: TypecheckStateStore,
  policy: Awaited<ReturnType<typeof loadConfig>>,
  report: PreparationReport,
  signal: AbortSignal,
  unresolved: boolean,
  liveIds: string[],
) {
  const ecosystem = selected[0]?.project.ecosystem;
  if (!ecosystem) {
    return;
  }
  const ids = liveIds.toSorted();
  if (ecosystem === "go") {
    // Installed Go is the tool; refresh its receipt after runtime upgrades.
    const resolved = await adapter.resolve(selected, policy.typecheck, signal);
    const versions = Object.fromEntries(
      ids.map((id) => [id, validateToolVersions(resolved[id] ?? store.state.projects[id]?.tools)]),
    );
    await prepareCohort(selected, versions, adapter, store, policy, report, signal);
    return;
  }
  let wave = store.state.waves[ecosystem];
  const decision = toolMembership(wave, ids);
  if (decision.resolve) {
    const resolved = await adapter.resolve(selected, policy.typecheck, signal);
    const common = validateToolVersions(resolved[selected[0]?.project.project_id ?? ""]);
    const tool = ecosystem === "python" ? "pyright" : "typescript";
    if (!common[tool]) {
      throw new TypecheckError("invalid-version", `Missing ${tool} target`);
    }
    for (const target of selected) {
      if (!sameVersions(validateToolVersions(resolved[target.project.project_id]), common)) {
        throw new TypecheckError("version-mismatch", `${ecosystem} discovery must resolve one shared exact toolset`);
      }
    }
    wave = { projects: ids, tools: common, complete: false, pending: [] };
    store.state.waves[ecosystem] = wave;
    await store.save();
  }
  if (!wave) {
    throw new TypecheckError("state-invalid", "Version wave is missing");
  }
  wave.projects = decision.projects;
  wave.pending = [];
  const versions = Object.fromEntries(selected.map((t) => [t.project.project_id, wave.tools]));
  wave.complete = false;
  await store.save();
  const complete = await prepareCohort(selected, versions, adapter, store, policy, report, signal);
  wave.complete = complete && !unresolved && !signal.aborted;
  await store.save();
  if (!wave.complete) {
    for (const id of ids) {
      const result = report.projects[id] ?? {
        ...initial(),
        affected_projects: [id],
      };
      result.complete = false;
      result.status = "failed";
      result.errors.push({
        code: `incomplete-${ecosystem}-wave`,
        message: `${ecosystem} version alignment wave is incomplete`,
        project_id: id,
      });
      report.projects[id] = result;
    }
  }
  return;
}
/** Owns the union lease once; native adapters must not call public dependency tools. */
export async function prepareTypecheck(
  root: string,
  adapters: TypecheckAdapterRegistry,
  signal: AbortSignal,
  onProgress?: (progress: PreparationProgress) => void,
): Promise<PreparationReport> {
  for (;;) {
    signal.throwIfAborted();
    const before = await getPackagingStructure(root, {
      refresh: true,
      signal,
      publish: false,
    });
    const domains = typecheckDomains(before.structure.root, await targets(before.structure, []));
    const result = await withDomains(domains, signal, async () => {
      const report: PreparationReport = { ...initial(), projects: {} };
      const { structure } = await getPackagingStructure(root, {
        refresh: true,
        signal,
        publish: false,
      });
      const selected = await targets(structure, report.errors);
      if (JSON.stringify(typecheckDomains(structure.root, selected)) !== JSON.stringify(domains)) {
        return undefined;
      }
      const policy = await loadConfig(structure.root, { signal, flush: true });
      const store = await TypecheckStateStore.load(structure.root);
      if (store.recovery) {
        report.recovery = store.recovery;
      }
      const live = new Set(structure.projects.map((p) => p.project_id));
      for (const id of Object.keys(store.state.projects)) {
        if (!live.has(id)) {
          delete store.state.projects[id];
        }
      }
      for (const ecosystem of ["python", "javascript"] as const) {
        const wave = store.state.waves[ecosystem];
        if (wave) {
          wave.projects = wave.projects.filter((id) => live.has(id));
          wave.pending = wave.pending.filter((id) => live.has(id));
          if (!wave.projects.length && !wave.pending.length) {
            delete store.state.waves[ecosystem];
          }
        }
      }
      for (const ecosystem of ["python", "javascript", "go"] as const) {
        const group = selected.filter((t) => t.project.ecosystem === ecosystem);
        if (!group.length) {
          if (ecosystem === "go") {
            continue;
          }
          const wave = store.state.waves[ecosystem];
          if (!wave || !structure.projects.some((p) => p.ecosystem === ecosystem)) {
            continue;
          }
          wave.complete = false;
          const members = new Set(wave.projects);
          wave.pending = [
            ...new Set([
              ...wave.pending,
              ...structure.projects
                .filter((p) => p.ecosystem === ecosystem && !members.has(p.project_id))
                .map((p) => p.project_id),
            ]),
          ].sort();
          continue;
        }
        try {
          signal.throwIfAborted();
          const adapter = adapters[ecosystem];
          if (!adapter) {
            throw new TypecheckError("unsupported-ecosystem", `No typecheck adapter registered for ${ecosystem}`);
          }
          try {
            onProgress?.({
              ecosystem,
              affected_projects: group.map((t) => t.project.project_id),
              message: `Checking ${ecosystem} typecheck preparation and common exact tool versions.`,
            });
          } catch {
            /* Reporting cannot cancel preparation. */
          }
          await prepareEcosystem(
            group,
            adapter,
            store,
            policy,
            report,
            signal,
            report.errors.some((e) => e.project_id?.startsWith(`${ecosystem}:`)),
            structure.projects.filter((p) => p.ecosystem === ecosystem).map((p) => p.project_id),
          );
        } catch (error) {
          for (const target of group) {
            const id = target.project.project_id;
            const receipt = store.state.projects[id];
            if (receipt) {
              receipt.ready = false;
            }
            report.projects[id] = {
              ...initial(),
              status: "failed",
              complete: false,
              errors: [preparationFailure(error, id)],
            };
          }
          if (ecosystem !== "go") {
            const wave = store.state.waves[ecosystem];
            if (wave) {
              wave.complete = false;
            }
          }
        }
      }
      try {
        await store.save();
      } catch (error) {
        report.errors.push(preparationFailure(error));
      }
      for (const [id, project] of Object.entries(report.projects)) {
        project.changes = report.changes.filter((change) => change.project_id === id);
        report.errors.push(...project.errors);
        Object.assign(report.tools, project.tools);
      }
      report.affected_projects = selected.map((t) => t.project.project_id);
      report.cancelled = signal.aborted;
      report.complete =
        !report.cancelled && !report.errors.length && Object.values(report.projects).every((p) => p.complete);
      report.status = report.complete ? "ready" : "failed";
      report.action = Object.values(report.projects).some((p) => p.action === "prepared")
        ? "prepared"
        : "already-ready";
      return report;
    });
    if (result) {
      return result;
    }
  }
}
