import { fileURLToPath } from "node:url";
import { installRepositoryHook } from "../git-hooks/install";

export type { HookInstallation } from "../git-hooks/install";
export function installPrepush(
  cwd: string,
  signal?: AbortSignal,
  runtime = {
    bun: process.execPath,
    cli: fileURLToPath(new URL("./cli.ts", import.meta.url)),
  },
) {
  return installRepositoryHook(cwd, "pre-push", signal, runtime);
}
