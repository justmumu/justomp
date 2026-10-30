import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import type { InspectionRules } from "../config/inspection/model";
import { loadConfig } from "../config/load";
import type { PackagingStructure } from "../inspect/model";
import { inspectProject } from "../inspect/scan";
import { publishSnapshot } from "./snapshot";
import { StructureWatcher, type WatchStatus } from "./watcher";
export class StructureError extends Error {
  override name = "StructureError";
  constructor(
    readonly code: string,
    message: string,
    readonly partial?: PackagingStructure,
  ) {
    super(message);
  }
}
export interface PackagingResult {
  structure: PackagingStructure;
  cacheHit: boolean;
  refreshed: boolean;
  fallbackReason?: string;
  waitMs: number;
  publishMs: number;
  watcher: WatchStatus;
}
interface Job {
  controller: AbortController;
  promise: Promise<{ structure: PackagingStructure; publishMs: number }>;
  waiters: number;
  publish: boolean;
}
interface State {
  root: string;
  key: string;
  rules: InspectionRules;
  watcher: StructureWatcher;
  snapshot?: PackagingStructure;
  published?: PackagingStructure;
  revision: number;
  job?: Job;
  closed: boolean;
  projectKey?: string;
}
interface Registry {
  states: Map<string, State>;
  aliases: Map<string, string>;
  leases: Map<string, number>;
  listeners?: Map<string, Set<() => void>>;
}
// OMP reloads dependency graphs with import query strings; module state is not process state.
const registryKey = Symbol.for("justomp.packaging.v1");
const host = globalThis as typeof globalThis & { [registryKey]?: Registry };
host[registryKey] ??= {
  states: new Map(),
  aliases: new Map(),
  leases: new Map(),
};
const { states, aliases, leases } = host[registryKey];
host[registryKey].listeners ??= new Map();
const listeners = host[registryKey].listeners;
function notify(root: string) {
  for (const listener of listeners.get(root) ?? []) listener();
}
/** Subscribes only to discovery changes; never starts preparation itself. */
export async function subscribePackagingStructure(
  root: string,
  listener: () => void,
): Promise<() => void> {
  const key = await realpath(root);
  const entries = listeners.get(key) ?? new Set<() => void>();
  entries.add(listener);
  listeners.set(key, entries);
  return () => {
    entries.delete(listener);
    if (!entries.size) listeners.delete(key);
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
async function stop(state: State) {
  state.closed = true;
  state.job?.controller.abort(
    new StructureError("closed", "Packaging inspection closed"),
  );
  await state.watcher.close();
  await state.job?.promise.catch(() => undefined);
}
export async function closePackagingStructure(root?: string): Promise<void> {
  if (root === undefined) {
    const pending = [...states.values()];
    states.clear();
    aliases.clear();
    await Promise.all(pending.map(stop));
    return;
  }
  const key = aliases.get(resolve(root)) ?? resolve(root);
  const state = states.get(key);
  if (state) {
    states.delete(key);
    await stop(state);
  }
  for (const [alias, target] of aliases)
    if (target === key) aliases.delete(alias);
}
/** Session owners share a root watcher until the last session releases it. */
export async function retainPackagingStructure(
  root: string,
): Promise<() => Promise<void>> {
  const key = await realpath(root);
  leases.set(key, (leases.get(key) ?? 0) + 1);
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const count = (leases.get(key) ?? 1) - 1;
    if (count > 0) leases.set(key, count);
    else {
      leases.delete(key);
      await closePackagingStructure(key);
    }
  };
}
export function getPackagingStatus(root: string): WatchStatus | undefined {
  return states
    .get(aliases.get(resolve(root)) ?? resolve(root))
    ?.watcher.status();
}
async function refreshState(
  state: State,
  signal: AbortSignal,
): Promise<{ structure: PackagingStructure; publishMs: number }> {
  try {
    if (!state.watcher.ready && !state.watcher.reason)
      await state.watcher.start(signal);
    for (;;) {
      signal.throwIfAborted();
      if (state.closed)
        throw new StructureError("closed", "Packaging inspection closed");
      const revision = state.watcher.revision;
      const structure = await inspectProject({
        root: state.root,
        rules: state.rules,
        signal,
      });
      if (!structure.complete)
        throw new StructureError(
          "incomplete",
          "Project inspection is incomplete",
          structure,
        );
      if (revision !== state.watcher.revision) continue;
      const latest = await loadConfig(state.root, { signal });
      if (latest.key !== state.key)
        throw new StructureError(
          "config-changed",
          "Inspection rules changed during refresh; call again",
        );
      signal.throwIfAborted();
      const published = state.job?.publish !== false;
      const publishMs = published
        ? await publishSnapshot(structure, signal)
        : 0;
      signal.throwIfAborted();
      if (state.closed)
        throw new StructureError("closed", "Packaging inspection closed");
      if (revision !== state.watcher.revision) continue;
      const projectKey = JSON.stringify(
        structure.projects.map((p) => p.project_id).sort(),
      );
      const changed =
        state.projectKey !== undefined && state.projectKey !== projectKey;
      state.projectKey = projectKey;
      state.snapshot = freeze(structure);
      if (published) state.published = state.snapshot;
      state.revision = revision;
      if (changed) notify(state.root);
      return { structure: state.snapshot, publishMs };
    }
  } catch (error) {
    if (signal.aborted) {
      state.closed = true;
      await state.watcher.close();
      state.snapshot = undefined;
      throw signal.reason;
    }
    throw error;
  }
}
function joinJob(
  state: State,
  signal: AbortSignal,
  publish: boolean,
): Promise<{ structure: PackagingStructure; publishMs: number }> {
  let job = state.job;
  if (!job) {
    state.snapshot = undefined;
    state.revision = -1;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        controller.abort(
          new StructureError(
            "structure-unstable",
            "structure-unstable: inspection did not settle within 25 seconds",
          ),
        ),
      25_000,
    );
    const current: Job = {
      controller,
      waiters: 0,
      publish,
      promise: Promise.resolve().then(() =>
        refreshState(state, controller.signal),
      ),
    };
    job = current;
    state.job = current;
    void current.promise
      .finally(() => {
        clearTimeout(timer);
        if (state.job === current) state.job = undefined;
      })
      .catch(() => undefined);
  }
  if (publish) job.publish = true;
  const shared = job;
  shared.waiters++;
  return new Promise((resolveResult, reject) => {
    let done = false;
    const finish = () => {
      if (done) return false;
      done = true;
      signal.removeEventListener("abort", abort);
      shared.waiters--;
      return true;
    };
    const abort = () => {
      if (!finish()) return;
      if (shared.waiters === 0) {
        state.closed = true;
        shared.controller.abort(signal.reason);
        void shared.promise
          .catch(() => undefined)
          .then(() => reject(signal.reason));
      } else reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    void shared.promise.then(
      (result) => {
        if (finish()) resolveResult(result);
      },
      (error) => {
        if (finish()) reject(error);
      },
    );
    if (signal.aborted) abort();
  });
}
/** Read current rules and return a process-local watched snapshot, never the disk JSON. */
export async function getPackagingStructure(
  root: string,
  options: { refresh?: boolean; signal?: AbortSignal; publish?: boolean } = {},
): Promise<PackagingResult> {
  const started = performance.now();
  const controller = new AbortController();
  const signal = options.signal
    ? AbortSignal.any([options.signal, controller.signal])
    : controller.signal;
  const timer = setTimeout(
    () =>
      controller.abort(
        new StructureError(
          "structure-unstable",
          "structure-unstable: inspection exceeded 25 seconds",
        ),
      ),
    25_000,
  );
  try {
    signal.throwIfAborted();
    const canonical = await realpath(root);
    aliases.set(resolve(root), canonical);
    const config = await loadConfig(canonical, { signal });
    signal.throwIfAborted();
    let state = states.get(canonical);
    if (
      !state ||
      state.key !== config.key ||
      state.closed ||
      (state.watcher.ready && !state.watcher.healthy && !state.watcher.reason)
    ) {
      const previous = state;
      state = {
        root: canonical,
        key: config.key,
        rules: config.rules,
        watcher: new StructureWatcher(canonical, config.rules),
        revision: -1,
        closed: false,
      };
      state.watcher.subscribe(() => notify(canonical));
      states.set(canonical, state);
      if (previous) await stop(previous);
    }
    signal.throwIfAborted();
    const cacheHit =
      !options.refresh &&
      state.watcher.healthy &&
      state.snapshot !== undefined &&
      (options.publish === false || state.published === state.snapshot) &&
      state.revision === state.watcher.revision;
    const result = cacheHit
      ? { structure: state.snapshot as PackagingStructure, publishMs: 0 }
      : await joinJob(state, signal, options.publish !== false);
    signal.throwIfAborted();
    if (state.closed)
      throw new StructureError(
        "closed",
        "Packaging scope changed during request",
      );
    if (state.watcher.healthy && state.revision !== state.watcher.revision)
      return await getPackagingStructure(root, {
        ...options,
        refresh: true,
        signal,
      });
    // A default caller can join after a read-only job crossed its publication checkpoint.
    // Refresh through the normal cancellable job so shutdown/revision guarantees remain shared.
    if (options.publish !== false && state.published !== result.structure)
      return await getPackagingStructure(root, {
        ...options,
        refresh: true,
        signal,
      });
    return {
      ...result,
      cacheHit,
      refreshed: !cacheHit,
      ...(state.watcher.reason ? { fallbackReason: state.watcher.reason } : {}),
      waitMs: performance.now() - started,
      watcher: state.watcher.status(),
    };
  } finally {
    clearTimeout(timer);
  }
}
