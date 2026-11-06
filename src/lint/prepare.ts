import { lintPolicyKey } from "../config/lint/resolve";
import { loadConfig } from "../config/load";
import { DependencyError, redact } from "../dependencies/model";
import { withDomains } from "../dependencies/queue";
import { type PackagingStructure } from "../inspect/model";
import { getPackagingStructure } from "../packaging/get-structure";
import { toolMembership } from "../packaging/tool-membership";
import {
  type LintAdapter,
  type LintAdapterRegistry,
  type LintCheckContext,
  type LintOperationContext,
  type ToolVersions,
} from "./adapters/types";
import { type LintEcosystem, LintError, type LintPreparation } from "./model";
import { applyProjection, type ProjectionPlan, planProjection, retireProjection } from "./projection";
import { type LintState, LintStateStore, type LintWave } from "./state";
import { type LintTarget, resolveLintTarget } from "./targets";
import { lintToolchainId } from "./toolchain";
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
    code: error instanceof LintError || error instanceof DependencyError ? error.code : "preparation-failed",
    message: redact(error instanceof Error ? error.message : String(error)),
    ...(project_id ? { project_id } : {}),
  };
}
async function targets(
  structure: PackagingStructure,
  errors: LintPreparation["errors"],
  ecosystems: readonly LintEcosystem[],
): Promise<LintTarget[]> {
  const result: LintTarget[] = [];
  for (const project of structure.projects) {
    if (!ecosystems.includes(project.ecosystem)) {
      continue;
    }
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
      ...(selected.some((t) => t.project.ecosystem === "go") ? ["native:golangci-lint"] : []),
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
    projection: await planProjection(target, context.policy, versions),
    signal: context.signal,
  };
}
async function resolveVersions(
  selected: LintTarget[],
  adapter: LintAdapter,
  policy: Awaited<ReturnType<typeof loadConfig>>,
  signal: AbortSignal,
  ecosystem: LintEcosystem,
  ids: string[],
  decision: { resolve: boolean },
  retained: Record<string, ToolVersions>,
): Promise<Record<string, ToolVersions>> {
  let versions: Record<string, ToolVersions>;
  if (decision.resolve) {
    versions = await adapter.resolve(selected, policy.lint, signal);
  } else {
    versions =
      ecosystem === "javascript"
        ? await adapter.resolve(selected, policy.lint, signal, retained)
        : Object.fromEntries(ids.map((id) => [id, retained[id] ?? {}]));
  }
  for (const id of ids) {
    validateToolVersions(versions[id]);
  }
  if (decision.resolve) {
    validateSharedVersions(versions, ecosystem);
  }
  return versions;
}
function validateSharedVersions(versions: Record<string, ToolVersions>, ecosystem: LintEcosystem): void {
  const common: ToolVersions = {};
  for (const tools of Object.values(versions)) {
    for (const [name, version] of Object.entries(tools)) {
      if (common[name] && common[name] !== version) {
        throw new LintError(
          "version-mismatch",
          `${ecosystem} discovery must resolve one shared exact version of ${name}`,
        );
      }
      common[name] = version;
    }
  }
}
async function preflight(
  adapter: LintAdapter,
  context: LintOperationContext,
  report: PreparationReport,
  ids: string[],
): Promise<boolean> {
  let preflightFailed = false;
  try {
    await adapter.preflight(context);
  } catch (error) {
    preflightFailed = true;
    report.errors.push(preparationFailure(error));
    for (const id of ids) {
      report.projects[id]?.errors.push(preparationFailure(error, id));
    }
  }
  return preflightFailed;
}
async function prepareBatch(
  batch: LintTarget[],
  adapter: LintAdapter,
  store: LintStateStore,
  context: LintOperationContext,
  report: PreparationReport,
  wave: { complete: boolean },
): Promise<void> {
  const { signal } = context;
  const state = store.state;
  try {
    signal.throwIfAborted();
    const { stale, nativeStale } = await inspectBatch(batch, adapter, context);
    if (!stale.length) {
      const plans = await planBatch(batch, context);
      for (const plan of plans) {
        recordOwnership(plan, state);
      }
      await store.save();
      return;
    }
    // Workspace adapters must see every member before resolving shared pins/locks.
    invalidateBatch(batch, state, report);
    wave.complete = false;
    await store.save();
    if (nativeStale) {
      await adapter.prepareBatch({ ...context, targets: batch });
    }
    const plans = await planBatch(batch, context);
    for (const plan of plans) {
      signal.throwIfAborted();
      await applyProjection(plan, report.changes);
      recordOwnership(plan, state);
    }
    await store.save();
    for (const plan of plans) {
      signal.throwIfAborted();
      await retireProjection(plan, report.changes);
    }
  } catch (error) {
    report.errors.push(preparationFailure(error));
    for (const target of batch) {
      report.projects[target.project.project_id]?.errors.push(preparationFailure(error, target.project.project_id));
    }
  }
}
async function planBatch(batch: LintTarget[], context: LintOperationContext): Promise<ProjectionPlan[]> {
  const plans: ProjectionPlan[] = [];
  for (const target of batch) {
    context.signal.throwIfAborted();
    plans.push(await planProjection(target, context.policy, context.versions[target.project.project_id]));
  }
  return plans;
}
function recordOwnership(plan: ProjectionPlan, state: LintState): void {
  const receipt = state.projects[plan.target.project.project_id];
  if (receipt && plan.native_configs) {
    receipt.native_configs = plan.native_configs;
  }
}
async function inspectBatch(batch: LintTarget[], adapter: LintAdapter, context: LintOperationContext) {
  const versions = context.versions;
  const stale: LintTarget[] = [];
  let nativeStale = false;
  for (const target of batch) {
    const check = await checkContext(target, versions[target.project.project_id] ?? {}, context);
    const ready = await adapter.verify(check);
    nativeStale ||= !ready;
    if (!check.projection.current || !ready) {
      stale.push(target);
    }
  }
  return { stale, nativeStale };
}
function invalidateBatch(batch: LintTarget[], state: LintState, report: PreparationReport): void {
  for (const target of batch) {
    const receipt = state.projects[target.project.project_id];
    if (receipt) {
      receipt.ready = false;
    }
    const result = report.projects[target.project.project_id];
    if (result) {
      result.action = "prepared";
    }
  }
}
async function verifyTarget(
  target: LintTarget,
  adapter: LintAdapter,
  context: LintOperationContext,
  receipt: LintState["projects"][string],
  result: LintPreparation,
  policyHash: string,
  ecosystem: LintEcosystem,
  preflightFailed: boolean,
): Promise<boolean> {
  const { signal } = context;
  const id = target.project.project_id;
  let verified: boolean = true;
  try {
    signal.throwIfAborted();
    const currentPolicy = await loadConfig(target.root, { signal });
    if (lintPolicyKey(currentPolicy.lint[ecosystem]) !== policyHash) {
      throw new LintError("policy-changed", "Lint policy changed during preparation; reconcile again");
    }
    const check = await checkContext(target, receipt.tools, context);
    receipt.ready =
      !preflightFailed && !result.errors.length && check.projection.current && (await adapter.verify(check));
    if (!receipt.ready) {
      throw new LintError("not-ready", `Native lint environment is not ready: ${id}`);
    }
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
  return verified;
}
function pruneVersions(wave: LintWave, live: Set<string>): void {
  for (const id of Object.keys(wave.versions)) {
    if (!live.has(id)) {
      delete wave.versions[id];
    }
  }
}
function pruneState(store: LintStateStore, structure: PackagingStructure): void {
  const live = new Set(structure.projects.map((p) => p.project_id));
  for (const id of Object.keys(store.state.projects)) {
    if (!live.has(id)) {
      delete store.state.projects[id];
    }
  }
  for (const [ecosystem, wave] of Object.entries(store.state.waves)) {
    wave.projects = wave.projects.filter((id) => live.has(id));
    pruneVersions(wave, live);
    if (!wave.projects.length) {
      delete store.state.waves[ecosystem as LintEcosystem];
    }
  }
}
async function prepareGroup(
  ecosystem: LintEcosystem,
  selected: LintTarget[],
  structure: PackagingStructure,
  store: LintStateStore,
  adapters: LintAdapterRegistry,
  policy: Awaited<ReturnType<typeof loadConfig>>,
  report: PreparationReport,
  signal: AbortSignal,
  onProgress?: (progress: PreparationProgress) => void,
): Promise<void> {
  const group = selected.filter((t) => t.project.ecosystem === ecosystem);
  const liveIds = structure.projects.filter((p) => p.ecosystem === ecosystem).map((p) => p.project_id);
  if (group.length !== liveIds.length) {
    const wave = store.state.waves[ecosystem];
    if (wave) {
      wave.complete = false;
    }
    return;
  }
  if (!group.length) {
    return;
  }
  try {
    signal.throwIfAborted();
    const adapter = adapters[ecosystem];
    if (!adapter) {
      throw new LintError("unsupported-ecosystem", `No lint adapter registered for ${ecosystem}`);
    }
    try {
      onProgress?.({
        ecosystem,
        affected_projects: group.map((t) => t.project.project_id),
        message: `Checking ${ecosystem} lint preparation with Justomp-owned tools and shared policy.`,
      });
    } catch {
      /* Reporting cannot cancel preparation. */
    }
    await prepareEcosystem(group, adapter, store, policy, report, signal);
  } catch (error) {
    failGroup(group, store, ecosystem, report, error);
  }
}
function failGroup(
  group: LintTarget[],
  store: LintStateStore,
  ecosystem: LintEcosystem,
  report: PreparationReport,
  error: unknown,
): void {
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
  const wave = store.state.waves[ecosystem];
  if (wave) {
    wave.complete = false;
  }
  report.errors.push(preparationFailure(error));
}
function finishPreparation(report: PreparationReport, selected: LintTarget[], signal: AbortSignal): void {
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
  report.action = Object.values(report.projects).some((p) => p.action === "prepared") ? "prepared" : "already-ready";
}
async function prepareUnderLease(
  root: string,
  domains: string[],
  adapters: LintAdapterRegistry,
  signal: AbortSignal,
  ecosystems: readonly LintEcosystem[],
  onProgress?: (progress: PreparationProgress) => void,
): Promise<PreparationReport | undefined> {
  const report: PreparationReport = { ...initial(), projects: {} };
  const { structure } = await getPackagingStructure(root, {
    refresh: true,
    signal,
  });
  const selected = await targets(structure, report.errors, ecosystems);
  if (JSON.stringify(lintDomains(structure.root, selected)) !== JSON.stringify(domains)) {
    return undefined;
  }
  const policy = await loadConfig(structure.root, { signal });
  const store = await LintStateStore.load(structure.root);
  if (store.recovery) {
    report.recovery = store.recovery;
  }
  pruneState(store, structure);
  for (const ecosystem of ["python", "javascript", "go"] as const) {
    if (!ecosystems.includes(ecosystem)) {
      continue;
    }
    await prepareGroup(ecosystem, selected, structure, store, adapters, policy, report, signal, onProgress);
  }
  try {
    await store.save();
  } catch (error) {
    report.errors.push(preparationFailure(error));
  }
  finishPreparation(report, selected, signal);
  return report;
}

function initializeReceipts(
  selected: LintTarget[],
  versions: Record<string, ToolVersions>,
  state: LintState,
  report: PreparationReport,
  ecosystem: LintEcosystem,
  policyHash: string,
): void {
  for (const target of selected) {
    const id = target.project.project_id;
    const tools = validateToolVersions(versions[id]);
    const previous = state.projects[id];
    state.projects[id] = {
      ecosystem,
      toolchain_id: lintToolchainId(ecosystem),
      tools,
      ...(previous?.native_configs ? { native_configs: previous.native_configs } : {}),
      policy_hash: policyHash,
      ready:
        previous?.ready === true &&
        previous.toolchain_id === lintToolchainId(ecosystem) &&
        previous.policy_hash === policyHash &&
        sameVersions(previous.tools, tools),
    };
    report.projects[id] = { ...initial(), tools, affected_projects: [id] };
  }
}
async function verifyMembers(
  selected: LintTarget[],
  state: LintState,
  report: PreparationReport,
  adapter: LintAdapter,
  context: LintOperationContext,
  policyHash: string,
  ecosystem: LintEcosystem,
  preflightFailed: boolean,
): Promise<boolean> {
  // Verify every member, including effects completed before a later native failure.
  let verified: boolean = true;
  for (const target of selected) {
    const id = target.project.project_id;
    const receipt = state.projects[id];
    const result = report.projects[id];
    if (!receipt || !result) {
      continue;
    }
    const ready = await verifyTarget(target, adapter, context, receipt, result, policyHash, ecosystem, preflightFailed);
    verified = ready && verified;
  }
  return verified;
}
function markIncompleteWave(ids: string[], ecosystem: LintEcosystem, report: PreparationReport): void {
  for (const id of ids) {
    const result = report.projects[id];
    if (result) {
      result.complete = false;
      result.status = "failed";
      result.errors.push({
        code: `incomplete-${ecosystem}-wave`,
        message: `${ecosystem} version alignment wave is incomplete`,
        project_id: id,
      });
    }
  }
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
  if (!ecosystem) {
    return;
  }
  const policyHash = lintPolicyKey(policy.lint[ecosystem]);
  const errorStart = report.errors.length;
  const ids = selected.map((t) => t.project.project_id).sort();
  const state = store.state;
  const previousWave = state.waves[ecosystem];
  const membership = toolMembership(previousWave, ids);
  const decision = {
    ...membership,
    resolve: membership.resolve || ids.some((id) => state.projects[id]?.toolchain_id !== lintToolchainId(ecosystem)),
  };
  const versions = await resolveVersions(
    selected,
    adapter,
    policy,
    signal,
    ecosystem,
    ids,
    decision,
    previousWave?.versions ?? {},
  );
  signal.throwIfAborted();
  const wave: LintWave = { projects: ids, versions, complete: false };
  state.waves[ecosystem] = wave;
  initializeReceipts(selected, versions, state, report, ecosystem, policyHash);
  // Resolved targets survive partial native failures and process restarts.
  await store.save();
  const context: LintOperationContext = {
    targets: selected,
    versions,
    policy: policy.lint,
    signal,
    changes: report.changes,
  };
  const preflightFailed = await preflight(adapter, context, report, ids);
  if (!preflightFailed) {
    for (const batch of batches(selected)) {
      await prepareBatch(batch, adapter, store, context, report, wave);
    }
  }
  const verified = await verifyMembers(
    selected,
    state,
    report,
    adapter,
    context,
    policyHash,
    ecosystem,
    preflightFailed,
  );
  // A previous partial wave is complete only after all current members verify.
  wave.complete =
    verified &&
    !signal.aborted &&
    report.errors.length === errorStart &&
    !report.errors.some((error) => error.project_id?.startsWith(`${ecosystem}:`));
  if (!wave.complete) {
    markIncompleteWave(ids, ecosystem, report);
  }
  await store.save();
}
/** Owns the union lease once; native adapters must not call executeDependency. */
export async function prepareLint(
  root: string,
  adapters: LintAdapterRegistry,
  signal: AbortSignal,
  onProgress?: (progress: PreparationProgress) => void,
  ecosystems: readonly LintEcosystem[] = ["python", "javascript", "go"],
): Promise<PreparationReport> {
  for (;;) {
    signal.throwIfAborted();
    const before = await getPackagingStructure(root, { signal });
    const domains = lintDomains(before.structure.root, await targets(before.structure, [], ecosystems));
    const result = await withDomains(domains, signal, () =>
      prepareUnderLease(root, domains, adapters, signal, ecosystems, onProgress),
    );
    if (result) {
      return result;
    }
  }
}
