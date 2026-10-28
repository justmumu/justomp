interface Waiter {
  resolve: (release: () => void) => void;
  signal?: AbortSignal;
  abort: () => void;
}
interface Entry {
  held: boolean;
  waiters: Waiter[];
}
const key = Symbol.for("justomp.dependencies.queue.v1");
const host = globalThis as typeof globalThis & { [key]?: Map<string, Entry> };
host[key] ??= new Map();
const queues = host[key];
function acquire(domain: string, signal?: AbortSignal): Promise<() => void> {
  signal?.throwIfAborted();
  let entry = queues.get(domain);
  if (!entry) {
    entry = { held: false, waiters: [] };
    queues.set(domain, entry);
  }
  const state = entry;
  function grant(): () => void {
    state.held = true;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = state.waiters.shift();
      if (next) {
        next.signal?.removeEventListener("abort", next.abort);
        next.resolve(grant());
      } else {
        state.held = false;
        queues.delete(domain);
      }
    };
  }
  if (!state.held) return Promise.resolve(grant());
  return new Promise((resolve, reject) => {
    const waiter: Waiter = {
      resolve,
      signal,
      abort: () => {
        const index = state.waiters.indexOf(waiter);
        if (index >= 0) {
          state.waiters.splice(index, 1);
          reject(signal?.reason);
        }
      },
    };
    state.waiters.push(waiter);
    signal?.addEventListener("abort", waiter.abort, { once: true });
    if (signal?.aborted) waiter.abort();
  });
}
export async function withDomains<T>(
  domains: string[],
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const releases: (() => void)[] = [];
  try {
    for (const domain of [...new Set(domains)].sort())
      releases.push(await acquire(domain, signal));
    signal?.throwIfAborted();
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
