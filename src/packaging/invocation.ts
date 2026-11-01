import { AsyncLocalStorage } from "node:async_hooks";

/** A native repository operation excludes gitlinks without changing persisted policy
 * or the ordinary OMP watcher/snapshot. Nested service calls inherit this scope. */
export const packagingInvocation = new AsyncLocalStorage<{
  root: string;
  excluded: string[];
}>();
