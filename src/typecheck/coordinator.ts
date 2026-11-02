import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { loadConfig } from "../config/load";
import { typecheckPolicyKey } from "../config/typecheck/resolve";
import { withDomains } from "../dependencies/queue";
import {
  getPackagingStructure,
  retainPackagingStructure,
  subscribePackagingStructure,
} from "../packaging/get-structure";
import { type TypecheckAdapterRegistry, type TypecheckCheckContext } from "./adapters/types";
import { TypecheckError } from "./model";
import {
  type PreparationProgress,
  type PreparationReport,
  preparationFailure,
  prepareTypecheck,
  typecheckDomains,
} from "./prepare";
import { readyTypecheckProjection } from "./readiness";

import { TypecheckStateStore } from "./state";
import { resolveTypecheckTarget } from "./targets";
import { sameVersions } from "./versions";

interface CoordinatorEntry {
  promise: Promise<TypecheckCoordinator>;
  current?: TypecheckCoordinator;
}
const registryKey = Symbol.for("justomp.typecheck.coordinators.v1");
const host = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, CoordinatorEntry>;
};
host[registryKey] ??= new Map();
const coordinators = host[registryKey];
const ownersKey = Symbol.for("justomp.typecheck.owners.v1");
const ownerHost = globalThis as typeof globalThis & {
  [ownersKey]?: Map<TypecheckCoordinator, number>;
};
ownerHost[ownersKey] ??= new Map();
const owners = ownerHost[ownersKey];
export class TypecheckCoordinator {
  private controller = new AbortController();
  private job: Promise<PreparationReport> | undefined;
  private dirty: boolean = false;
  private closed: boolean = false;
  private stopping?: Promise<void>;
  get isClosed(): boolean {
    return this.closed;
  }
  private watcher?: FSWatcher;
  private unsubscribe?: () => void;
  private releasePackaging?: () => Promise<void>;
  private last?: PreparationReport;
  private listeners = new Set<(report: PreparationReport) => void>();
  private progressListeners = new Set<(progress: PreparationProgress) => void>();
  private progress: PreparationProgress | undefined;
  get preparing(): boolean {
    return this.job !== undefined;
  }
  subscribeProgress(listener: (progress: PreparationProgress) => void): () => void {
    this.progressListeners.add(listener);
    if (this.job !== undefined && this.progress) {
      listener(this.progress);
    }
    return () => {
      this.progressListeners.delete(listener);
    };
  }
  subscribe(listener: (report: PreparationReport) => void): () => void {
    this.listeners.add(listener);
    if (this.last) {
      listener(this.last);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
  private async inputKey(): Promise<string> {
    const { structure } = await getPackagingStructure(this.root, {
      signal: this.controller.signal,
      refresh: true,
      publish: false,
    });
    const config = await loadConfig(this.root, {
      signal: this.controller.signal,
    });
    return JSON.stringify([config.typecheckKey, structure.projects.map((p) => p.project_id).sort()]);
  }
  private constructor(
    readonly root: string,
    readonly adapters: TypecheckAdapterRegistry,
  ) {}
  static async create(root: string, adapters: TypecheckAdapterRegistry): Promise<TypecheckCoordinator> {
    const coordinator = new TypecheckCoordinator(root, adapters);
    coordinator.releasePackaging = await retainPackagingStructure(root);
    try {
      await getPackagingStructure(root, {
        signal: coordinator.controller.signal,
        refresh: true,
        publish: false,
      });
      coordinator.unsubscribe = await subscribePackagingStructure(root, () => coordinator.notify());
      const watcher = new FSWatcher({
        ignoreInitial: true,
        followSymlinks: false,
        persistent: false,
        atomic: false,
      });
      coordinator.watcher = watcher;
      const configPath = join(root, ".justomp/config.json");
      const signature = async () => {
        try {
          const stat = await lstat(configPath);
          return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode].join(":");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return "missing";
          }
          throw error;
        }
      };
      let previous = await signature();
      watcher.on("all", (_event, path) => {
        if (path !== configPath) {
          return;
        }
        void signature()
          .then((current) => {
            // Native backends may report reads: atime is not a policy change.
            if (current === previous) {
              return;
            }
            previous = current;
            coordinator.notify();
          })
          .catch(() => {
            coordinator.notify();
          });
      });
      // Inspection fallback remains available through every explicit reconcile call.
      watcher.on("error", () => {
        void watcher.close();
      });
      watcher.add(configPath);
      coordinator.notify();
      return coordinator;
    } catch (error) {
      // Preserve the setup failure after joining every resource acquired so far.
      await coordinator.shutdown().catch(() => undefined);
      throw error;
    }
  }
  private async preparePass(previousInput: string): Promise<{ input: string; report: PreparationReport }> {
    let report: PreparationReport;
    try {
      previousInput = await this.inputKey();
      report = await prepareTypecheck(this.root, this.adapters, this.controller.signal, (progress) => {
        this.reportProgress(progress);
      });
    } catch (error) {
      report = {
        status: "failed",
        action: "not-attempted",
        tools: {},
        affected_projects: [],
        changes: [],
        diagnostics: [],
        complete: false,
        cancelled: this.controller.signal.aborted,
        errors: [preparationFailure(error)],
        projects: {},
      };
    }
    return { input: previousInput, report };
  }
  private reportProgress(progress: PreparationProgress): void {
    this.progress = progress;
    for (const listener of this.progressListeners) {
      try {
        listener(progress);
      } catch {
        /* Reporting cannot cancel preparation. */
      }
    }
  }
  private async changedInput(previousInput: string): Promise<boolean> {
    // Self-writes must not spin a failed native step; genuinely new inputs rerun.
    try {
      if ((await this.inputKey()) === previousInput) {
        return false;
      }
    } catch {
      return false;
    }
    return true;
  }
  private publishReport(
    report: PreparationReport,
    effects: PreparationReport["changes"],
    recovery: string | undefined,
    prepared: boolean,
  ): void {
    report.changes = effects;
    if (recovery) {
      report.recovery = recovery;
    }
    if (prepared) {
      report.action = "prepared";
    }
    for (const [id, project] of Object.entries(report.projects)) {
      project.changes = effects.filter((change) => change.project_id === id);
    }
    for (const listener of this.listeners) {
      try {
        listener(report);
      } catch {
        /* Reporting cannot cancel preparation. */
      }
    }
  }
  private accumulate(
    report: PreparationReport,
    accumulated: { prepared: boolean; recovery: string | undefined },
  ): void {
    accumulated.recovery ??= report.recovery;
    accumulated.prepared ||= report.action === "prepared";
  }
  private notify(): void {
    if (this.closed) {
      return;
    }
    if (this.job !== undefined) {
      this.dirty = true;
      return;
    }
    void this.reconcile().catch(() => undefined);
  }
  /** Explicit calls retry failure; events received during a job coalesce to one new pass. */
  reconcile(): Promise<PreparationReport> {
    if (this.closed) {
      return Promise.reject(new TypecheckError("closed", "Typecheck preparation is closed"));
    }
    if (this.job !== undefined) {
      return this.job;
    }
    this.progress = undefined;
    const running = (async () => {
      let previousInput = "";
      const effects: PreparationReport["changes"] = [];
      const accumulated: { prepared: boolean; recovery: string | undefined } = { prepared: false, recovery: undefined };
      for (;;) {
        this.dirty = false;
        const pass = await this.preparePass(previousInput);
        previousInput = pass.input;
        this.last = pass.report;
        effects.push(...this.last.changes);
        this.accumulate(this.last, accumulated);
        if (!this.dirty || this.closed) {
          break;
        }
        if (!this.last.complete && !(await this.changedInput(previousInput))) {
          break;
        }
      }
      this.publishReport(this.last, effects, accumulated.recovery, accumulated.prepared);
      return this.last;
    })();
    this.job = running;
    void running
      .finally(() => {
        if (this.job === running) {
          this.job = undefined;
        }
      })
      .catch(() => undefined);
    return running;
  }
  shutdown(): Promise<void> {
    if (this.stopping !== undefined) {
      return this.stopping;
    }
    this.closed = true;
    this.unsubscribe?.();
    this.controller.abort(new TypecheckError("cancelled", "Typecheck session shut down"));
    this.stopping = (async () => {
      try {
        await this.watcher?.close();
      } finally {
        try {
          await this.job;
        } finally {
          await this.releasePackaging?.();
        }
      }
    })().finally(() => {
      this.listeners.clear();
      this.progressListeners.clear();
      if (coordinators.get(this.root)?.current === this) {
        coordinators.delete(this.root);
      }
    });
    return this.stopping;
  }
}
/** One process-local job per canonical root, independent of OMP inspection deadlines. */
export async function startTypecheckCoordinator(
  root: string,
  adapters: TypecheckAdapterRegistry,
): Promise<TypecheckCoordinator> {
  const canonical = await realpath(root);
  for (;;) {
    let entry = coordinators.get(canonical);
    if (!entry) {
      const created: CoordinatorEntry = {
        promise: TypecheckCoordinator.create(canonical, adapters),
      };
      entry = created;
      coordinators.set(canonical, created);
      void created.promise.then(
        (coordinator) => {
          created.current = coordinator;
        },
        () => {
          if (coordinators.get(canonical) === created) {
            coordinators.delete(canonical);
          }
        },
      );
    }
    const coordinator = await entry.promise;
    if (!coordinator.isClosed) {
      return coordinator;
    }
    await coordinator.shutdown();
  }
}
/** Ownership belongs to an instance, so old sessions cannot release its replacement. */
export async function retainTypecheckCoordinator(
  root: string,
  adapters: TypecheckAdapterRegistry,
): Promise<{
  coordinator: TypecheckCoordinator;
  release: () => Promise<void>;
}> {
  for (;;) {
    const coordinator = await startTypecheckCoordinator(root, adapters);
    // The last owner may have released between start returning and this continuation.
    if (coordinator.isClosed) {
      continue;
    }
    owners.set(coordinator, (owners.get(coordinator) ?? 0) + 1);
    let released = false;
    return {
      coordinator,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        const remaining = (owners.get(coordinator) ?? 1) - 1;
        if (remaining > 0) {
          owners.set(coordinator, remaining);
        } else {
          owners.delete(coordinator);
          await coordinator.shutdown();
        }
      },
    };
  }
}
/** Host root switches await cancellation/child teardown before starting the next root. */
export class TypecheckSession {
  private current: Awaited<ReturnType<typeof retainTypecheckCoordinator>> | undefined;
  constructor(private adapters: TypecheckAdapterRegistry) {}
  async switchRoot(root: string): Promise<TypecheckCoordinator> {
    const canonical = await realpath(root);
    if (this.current?.coordinator.root === canonical) {
      return this.current.coordinator;
    }
    await this.current?.release();
    this.current = await retainTypecheckCoordinator(canonical, this.adapters);
    return this.current.coordinator;
  }
  async shutdown(): Promise<void> {
    await this.current?.release();
    this.current = undefined;
  }
}
/** Revalidate after generated preparation, before invoking the checker under the same lease. */
export async function verifyReadyTypecheckContext(
  context: TypecheckCheckContext,
  adapters: TypecheckAdapterRegistry,
): Promise<TypecheckCheckContext> {
  const { target, signal } = context;
  signal.throwIfAborted();
  const policy = await loadConfig(target.root, { signal, flush: false });
  if (
    typecheckPolicyKey(policy.typecheck[target.project.ecosystem]) !==
    typecheckPolicyKey(context.policy[target.project.ecosystem])
  ) {
    throw new TypecheckError("policy-changed", "Typecheck policy changed during the check");
  }
  const adapter = adapters[target.project.ecosystem];
  if (!adapter) {
    throw new TypecheckError(
      "unsupported-ecosystem",
      `No typecheck adapter registered for ${target.project.ecosystem}`,
    );
  }
  const projection = await readyTypecheckProjection(adapter, {
    ...context,
    policy: policy.typecheck,
  });
  if (!projection) {
    throw new TypecheckError("not-ready", "Native typecheck environment changed during the check; prepare again");
  }
  return { ...context, policy: policy.typecheck, projection };
}
/** Read-only readiness check. Additional dependency IDs participate in the same union
 * lease and are resolved again after waiting. Callback may prepare generated types,
 * then call verifyReadyTypecheckContext before checking without nested leases. */
export async function withReadyTypecheckTarget<T>(
  root: string,
  projectId: string,
  adapters: TypecheckAdapterRegistry,
  operation: (context: TypecheckCheckContext) => Promise<T>,
  signal: AbortSignal = new AbortController().signal,
  additionalProjectIds: readonly string[] = [],
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const { structure } = await getPackagingStructure(root, {
      signal,
      refresh: true,
      publish: false,
    });
    const ids = [...new Set([projectId, ...additionalProjectIds])];
    const selected = await Promise.all(ids.map((id) => resolveTypecheckTarget(structure, id)));
    const domains = typecheckDomains(structure.root, selected);
    const result = await withDomains(domains, signal, async () => {
      const latest = await getPackagingStructure(root, {
        signal,
        refresh: true,
        publish: false,
      });
      const current = await Promise.all(ids.map((id) => resolveTypecheckTarget(latest.structure, id)));
      const target = current[0];
      if (!target) {
        throw new TypecheckError("project-not-found", `Unknown project_id: ${projectId}`);
      }
      if (JSON.stringify(typecheckDomains(target.root, current)) !== JSON.stringify(domains)) {
        return undefined;
      }
      return operateReadyTarget(target, current, latest.structure, adapters, operation, signal);
    });
    if (result) {
      return result.value;
    }
  }
}
/** Cancel one waiter without aborting the session-owned native operation. */
export function waitForTypecheckPreparation(
  coordinator: TypecheckCoordinator,
  signal?: AbortSignal,
): Promise<PreparationReport> {
  signal?.throwIfAborted();
  const job = coordinator.reconcile();
  if (!signal) {
    return job;
  }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    void job.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

async function operateReadyTarget<T>(
  target: TypecheckCheckContext["target"],
  current: TypecheckCheckContext["target"][],
  structure: TypecheckCheckContext["target"]["structure"],
  adapters: TypecheckAdapterRegistry,
  operation: (context: TypecheckCheckContext) => Promise<T>,
  signal: AbortSignal,
): Promise<{ value: T }> {
  const projectId = target.project.project_id;
  const policy = await loadConfig(target.root, { signal, flush: false });
  const store = await TypecheckStateStore.load(target.root);
  verifyReceipts(current, structure, store, policy);
  const receipt = store.state.projects[projectId];
  if (!receipt) {
    throw new TypecheckError("not-ready", "Missing preparation receipt");
  }
  const adapter = adapters[target.project.ecosystem];
  if (!adapter) {
    throw new TypecheckError(
      "unsupported-ecosystem",
      `No typecheck adapter registered for ${target.project.ecosystem}`,
    );
  }
  const toolContext = {
    target,
    versions: receipt.tools,
    policy: policy.typecheck,
    signal,
  };
  const projection = await readyTypecheckProjection(adapter, toolContext);
  if (!projection) {
    throw new TypecheckError("not-ready", "Native typecheck environment is not ready; reconcile preparation first");
  }
  const context = { ...toolContext, projection };
  const value = await operation(context);
  await verifyReadyTypecheckContext(context, adapters);
  return { value };
}

function verifyReceipts(
  current: TypecheckCheckContext["target"][],
  structure: TypecheckCheckContext["target"]["structure"],
  store: TypecheckStateStore,
  policy: Awaited<ReturnType<typeof loadConfig>>,
): void {
  for (const member of current) {
    const id = member.project.project_id;
    const ecosystem = member.project.ecosystem;
    const receipt = store.state.projects[id];
    if (store.recovery || !receipt?.ready || receipt.policy_hash !== typecheckPolicyKey(policy.typecheck[ecosystem])) {
      throw new TypecheckError("not-ready", "Typecheck preparation is not ready; prepare this project first");
    }
    if (ecosystem !== "go") {
      const wave = store.state.waves[ecosystem];
      const live = structure.projects
        .filter((p) => p.ecosystem === ecosystem)
        .map((p) => p.project_id)
        .sort();
      if (
        !wave?.complete ||
        wave.pending.length ||
        JSON.stringify([...wave.projects].sort()) !== JSON.stringify(live) ||
        !sameVersions(wave.tools, receipt.tools)
      ) {
        throw new TypecheckError(`incomplete-${ecosystem}-wave`, `${ecosystem} version alignment wave is incomplete`);
      }
    }
  }
}
