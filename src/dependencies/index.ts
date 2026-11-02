import { bunAdapter } from "./adapters/bun";
import { goAdapter } from "./adapters/go";
import { npmAdapter } from "./adapters/npm";
import { pnpmAdapter } from "./adapters/pnpm";
import { uvAdapter } from "./adapters/uv";
import { yarnClassicAdapter } from "./adapters/yarn-classic";
import { yarnModernAdapter } from "./adapters/yarn-modern";
import { type AdapterRegistry } from "./service";

export const adapters: AdapterRegistry = {
  uv: uvAdapter,
  npm: npmAdapter,
  pnpm: pnpmAdapter,
  "yarn-classic": yarnClassicAdapter,
  "yarn-modern": yarnModernAdapter,
  bun: bunAdapter,
  go: goAdapter,
};
export type { DependencyRequest, Group, Operation, Source } from "./schemas";
export { schemas } from "./schemas";
export { executeDependency, listProjects } from "./service";
