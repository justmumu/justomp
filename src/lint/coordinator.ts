import { lstat, realpath } from "node:fs/promises";
import { join } from "node:path";
import { FSWatcher } from "chokidar";
import { lintPolicyKey } from "../config/lint/resolve";
import { loadConfig } from "../config/load";
import { withDomains } from "../dependencies/queue";
import { nativeInputsCurrent } from "../native-config/inputs";
import {
  getPackagingStructure,
  retainPackagingStructure,
  subscribePackagingStructure,
} from "../packaging/get-structure";
import { type LintAdapter, type LintAdapterRegistry, type LintCheckContext } from "./adapters/types";
import { LintError } from "./model";
import {
  lintDomains,
  type PreparationProgress,
  type PreparationReport,
  preparationFailure,
  prepareLint,
} from "./prepare";
import { planProjection } from "./projection";
import { LintStateStore, lintWaveReady } from "./state";
import { resolveLintTarget } from "./targets";

interface CoordinatorEntry {
  promise: Promise<LintCoordinator>;
  current?: LintCoordinator;
}
const registryKey = Symbol.for("justomp.lint.coordinators.v1");
const host = globalThis as typeof globalThis & {
  [registryKey]?: Map<string, CoordinatorEntry>;
};
host[registryKey] ??= new Map();
const coordinators = host[registryKey];
const ownersKey = Symbol.for("justomp.lint.owners.v1");
const ownerHost = globalThis as typeof globalThis & {
  [ownersKey]?: Map<LintCoordinator, number>;
};
ownerHost[ownersKey] ??= new Map();
const owners = ownerHost[ownersKey];
export class LintCoordinator {
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
    });
    const config = await loadConfig(this.root, {
      signal: this.controller.signal,
    });
    return JSON.stringify([config.lintKey, structure.projects.map((p) => p.project_id).sort()]);
  }
  private constructor(
    readonly root: string,
    readonly adapters: LintAdapterRegistry,
  ) {}
  static async create(root: string, adapters: LintAdapterRegistry): Promise<LintCoordinator> {
    const coordinator = new LintCoordinator(root, adapters);
    await loadConfig(root, {
      flush: true,
      signal: coordinator.controller.signal,
    });
    coordinator.releasePackaging = await retainPackagingStructure(root);
    try {
      await getPackagingStructure(root, {
        signal: coordinator.controller.signal,
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
      report = await prepareLint(this.root, this.adapters, this.controller.signal, (progress) => {
        this.reportProgress(progress);
      });
    } catch (error) {
      report = {
        status: "failed",
        action: "not-attempted",
        tools: {},
        affected_projects: [],
        changes: [],
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
  private async changedFailedInput(previousInput: string): Promise<boolean> {
    // Self-writes must not spin a failed native step; genuinely new inputs rerun.
    try {
      return (await this.inputKey()) !== previousInput;
    } catch {
      return false;
    }
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
      return Promise.reject(new LintError("closed", "Lint preparation is closed"));
    }
    if (this.job !== undefined) {
      return this.job;
    }
    this.progress = undefined;
    const running = (async () => {
      let previousInput = "";
      const effects: PreparationReport["changes"] = [];
      let prepared = false;
      let recovery: string | undefined;
      for (;;) {
        this.dirty = false;
        const pass = await this.preparePass(previousInput);
        previousInput = pass.input;
        this.last = pass.report;
        effects.push(...this.last.changes);
        recovery ??= this.last.recovery;
        prepared ||= this.last.action === "prepared";
        if (!this.dirty || this.closed) {
          break;
        }
        if (!this.last.complete && !(await this.changedFailedInput(previousInput))) {
          break;
        }
      }
      this.publishReport(this.last, effects, recovery, prepared);
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
    this.controller.abort(new LintError("cancelled", "Lint session shut down"));
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
export async function startLintCoordinator(root: string, adapters: LintAdapterRegistry): Promise<LintCoordinator> {
  const canonical = await realpath(root);
  for (;;) {
    let entry = coordinators.get(canonical);
    if (!entry) {
      const created: CoordinatorEntry = {
        promise: LintCoordinator.create(canonical, adapters),
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
export async function retainLintCoordinator(
  root: string,
  adapters: LintAdapterRegistry,
): Promise<{ coordinator: LintCoordinator; release: () => Promise<void> }> {
  for (;;) {
    const coordinator = await startLintCoordinator(root, adapters);
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
export class LintSession {
  private current: Awaited<ReturnType<typeof retainLintCoordinator>> | undefined;
  constructor(private adapters: LintAdapterRegistry) {}
  async switchRoot(root: string): Promise<LintCoordinator> {
    const canonical = await realpath(root);
    if (this.current?.coordinator.root === canonical) {
      return this.current.coordinator;
    }
    await this.current?.release();
    this.current = await retainLintCoordinator(canonical, this.adapters);
    return this.current.coordinator;
  }
  async shutdown(): Promise<void> {
    await this.current?.release();
    this.current = undefined;
  }
}
async function readyContext(
  target: Awaited<ReturnType<typeof resolveLintTarget>>,
  adapters: LintAdapterRegistry,
  signal: AbortSignal,
): Promise<{ context: LintCheckContext; adapter: LintAdapter; policyHash: string }> {
  const projectId = target.project.project_id;
  const policy = await loadConfig(target.root, { signal, flush: false });
  const store = await LintStateStore.load(target.root);
  const receipt = store.state.projects[projectId];
  if (
    store.recovery ||
    !receipt?.ready ||
    receipt.policy_hash !== lintPolicyKey(policy.lint[target.project.ecosystem])
  ) {
    throw new LintError("not-ready", "Lint preparation is not ready; prepare this project first");
  }
  if (
    !lintWaveReady(
      store.state,
      target.project.ecosystem,
      target.structure.projects.filter((p) => p.ecosystem === target.project.ecosystem).map((p) => p.project_id),
    )
  ) {
    throw new LintError(`incomplete-${target.project.ecosystem}-wave`, "Lint version alignment wave is incomplete");
  }
  const adapter = adapters[target.project.ecosystem];
  if (!adapter) {
    throw new LintError("unsupported-ecosystem", `No lint adapter registered for ${target.project.ecosystem}`);
  }
  const context: LintCheckContext = {
    target,
    versions: receipt.tools,
    policy: policy.lint,
    projection: await planProjection(target, policy.lint, receipt.tools),
    signal,
  };
  if (!context.projection.current || !(await adapter.verify(context))) {
    throw new LintError("not-ready", "Native lint environment is not ready; reconcile preparation first");
  }
  return { context, adapter, policyHash: receipt.policy_hash };
}
async function verifyAfter(
  context: LintCheckContext,
  retained: LintCheckContext,
  adapter: LintAdapter,
  policyHash: string,
): Promise<void> {
  const { target, signal, policy, versions } = retained;
  const after = {
    ...context,
    projection: await planProjection(target, policy, versions),
  };
  if (
    !after.projection.current ||
    !(await nativeInputsCurrent(target.root, retained.projection.inputs)) ||
    !(await adapter.verify(after))
  ) {
    throw new LintError("not-ready", "Native lint environment changed during the check; prepare again");
  }
  if (lintPolicyKey((await loadConfig(target.root, { signal })).lint[target.project.ecosystem]) !== policyHash) {
    throw new LintError("policy-changed", "Lint policy changed during the check");
  }
}
/** Ready execution lease: validates tooling without installs, policy flush or snapshot writes.
 * The operation owns check-only or explicit source-fix behavior; never prepare under this lease. */
export async function withReadyLintTarget<T>(
  root: string,
  projectId: string,
  adapters: LintAdapterRegistry,
  operation: (context: LintCheckContext) => Promise<T>,
  signal: AbortSignal = new AbortController().signal,
): Promise<T> {
  for (;;) {
    signal.throwIfAborted();
    const { structure } = await getPackagingStructure(root, {
      signal,
      publish: false,
    });
    const selected = await resolveLintTarget(structure, projectId);
    const domains = lintDomains(selected.root, [selected]);
    const result = await withDomains(domains, signal, async () => {
      const latest = await getPackagingStructure(root, {
        signal,
        refresh: true,
        publish: false,
      });
      const target = await resolveLintTarget(latest.structure, projectId);
      if (JSON.stringify(lintDomains(target.root, [target])) !== JSON.stringify(domains)) {
        return undefined;
      }
      const { context, adapter, policyHash } = await readyContext(target, adapters, signal);
      const retained = { ...context };
      const value = await operation(context);
      signal.throwIfAborted();
      await verifyAfter(context, retained, adapter, policyHash);
      return { value };
    });
    if (result) {
      return result.value;
    }
  }
}
