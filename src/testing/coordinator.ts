import { realpath } from "node:fs/promises";
import { loadConfig } from "../config/load";
import {
  getPackagingStructure,
  retainPackagingStructure,
  subscribePackagingStructure,
} from "../packaging/get-structure";
import { type TestAdapters } from "./adapters";
import { TestError, type TestPreparation } from "./model";
import { preparationReport, prepareTests, testIssue } from "./prepare";

const key = Symbol.for("justomp.test.coordinators.v1");
interface Entry {
  promise: Promise<TestCoordinator>;
  owners: number;
}
const host = globalThis as typeof globalThis & { [key]?: Map<string, Entry> };
host[key] ??= new Map();
const registry = host[key];
export class TestCoordinator {
  private controller = new AbortController();
  private job: Promise<TestPreparation> | undefined;
  private dirty: boolean = false;
  private stopped?: Promise<void>;
  private closed: boolean = false;
  private unsubscribe?: () => void;
  private releasePackaging?: () => Promise<void>;
  private listeners = new Set<(report: TestPreparation) => void>();
  private progressListeners = new Set<(report: TestPreparation) => void>();
  private constructor(
    readonly root: string,
    readonly adapters: TestAdapters,
  ) {}
  get isClosed() {
    return this.closed;
  }
  get preparing() {
    return this.job !== undefined;
  }
  subscribe(fn: (report: TestPreparation) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
  subscribeProgress(fn: (report: TestPreparation) => void) {
    this.progressListeners.add(fn);
    return () => {
      this.progressListeners.delete(fn);
    };
  }
  private emit(listeners: Set<(report: TestPreparation) => void>, report: TestPreparation) {
    for (const fn of listeners) {
      try {
        fn(structuredClone(report));
      } catch {
        /* Observers do not control preparation. */
      }
    }
  }
  static async create(root: string, adapters: TestAdapters): Promise<TestCoordinator> {
    const c = new TestCoordinator(root, adapters);
    c.releasePackaging = await retainPackagingStructure(root);
    try {
      await getPackagingStructure(root, {
        signal: c.controller.signal,
        publish: false,
      });
      c.unsubscribe = await subscribePackagingStructure(root, () => {
        if (c.closed) {
          return;
        }
        if (c.job !== undefined) {
          c.dirty = true;
        } else {
          void c.reconcile().catch(() => undefined);
        }
      });
      return c;
    } catch (error) {
      await c.shutdown();
      throw error;
    }
  }
  private async inputKey() {
    const { structure } = await getPackagingStructure(this.root, {
      signal: this.controller.signal,
      refresh: true,
      publish: false,
    });
    const config = await loadConfig(this.root, {
      signal: this.controller.signal,
    });
    return JSON.stringify([structure.projects, config.testingKey]);
  }
  reconcile(): Promise<TestPreparation> {
    if (this.closed) {
      return Promise.reject(new TestError("closed", "Test preparation is closed"));
    }
    if (this.job !== undefined) {
      return this.job;
    }
    const job = (async () => {
      let result = preparationReport();
      const changes: TestPreparation["changes"] = [];
      let prepared = false;
      try {
        for (;;) {
          this.dirty = false;
          const before = await this.inputKey();
          result = await prepareTests(this.root, this.adapters, this.controller.signal, (r) =>
            this.emit(this.progressListeners, r),
          );
          changes.push(...result.changes);
          prepared ||= result.action === "prepared";
          if (!this.dirty || this.closed || (await this.inputKey()) === before) {
            break;
          }
        }
      } catch (error) {
        result = {
          ...result,
          status: "failed",
          complete: false,
          cancelled: this.controller.signal.aborted,
          errors: [...result.errors, testIssue(error)],
        };
      }
      result.changes = changes;
      if (prepared) {
        result.action = "prepared";
      }
      this.emit(this.listeners, result);
      return result;
    })();
    this.job = job;
    void job
      .finally(() => {
        if (this.job === job) {
          this.job = undefined;
        }
      })
      .catch(() => undefined);
    return job;
  }
  shutdown(): Promise<void> {
    if (this.stopped !== undefined) {
      return this.stopped;
    }
    this.closed = true;
    this.unsubscribe?.();
    this.controller.abort(new TestError("cancelled", "Last test session closed"));
    this.stopped = (async () => {
      try {
        await this.job;
      } finally {
        await this.releasePackaging?.();
        this.listeners.clear();
        this.progressListeners.clear();
      }
    })();
    return this.stopped;
  }
}
export async function retainTestCoordinator(
  root: string,
  adapters: TestAdapters,
): Promise<{ coordinator: TestCoordinator; release: () => Promise<void> }> {
  const canonical = await realpath(root);
  for (;;) {
    let entry = registry.get(canonical);
    if (!entry) {
      entry = {
        promise: TestCoordinator.create(canonical, adapters),
        owners: 0,
      };
      registry.set(canonical, entry);
    }
    const selected = entry;
    let coordinator: TestCoordinator;
    try {
      coordinator = await selected.promise;
    } catch (error) {
      removeEntry(canonical, selected);
      throw error;
    }
    if (coordinator.isClosed) {
      await coordinator.shutdown();
      removeEntry(canonical, selected);
      continue;
    }
    selected.owners++;
    let released = false;
    return {
      coordinator,
      release: async () => {
        if (released) {
          return;
        }
        released = true;
        if (--selected.owners === 0) {
          try {
            await coordinator.shutdown();
          } finally {
            removeEntry(canonical, selected);
          }
        }
      },
    };
  }
}
/** Cancellation only detaches this waiter; the session still owns the job. */
export function waitForTestPreparation(coordinator: TestCoordinator, signal?: AbortSignal): Promise<TestPreparation> {
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

function removeEntry(canonical: string, selected: Entry): void {
  if (registry.get(canonical) === selected) {
    registry.delete(canonical);
  }
}
